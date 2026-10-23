import { afterAll, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { closePools } from '../src/db/pool.js';
import { createApp } from '../src/web/app.js';
import { outbox } from '../src/email/send.js';
import { encrypt } from '../src/core/crypto.js';
import { createTask } from '../src/core/tasks.js';
import { addHumanComment } from '../src/core/comments.js';
import { addComment } from '../src/mcp/tools/tasks.js';
import { transition } from '../src/core/lifecycle.js';
import { emit } from '../src/core/events.js';
import { getBriefing, ackBriefing } from '../src/runtime/briefing.js';
import { fireRunner, maybeFire, resetFetch, setFetchForTests } from '../src/runtime/fire.js';
import { addPerson, inOrg, makeAgent, makeOrg, minutes, MON_10, loginCookie, waitForEvents } from './helpers.js';

afterAll(closePools);
afterEach(resetFetch);

const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };
const MON_21 = new Date('2026-09-21T18:00:00Z'); // 21:00 Стамбул — вне рабочего окна организации

async function makeRunner(orgId: string, fireUrl = 'https://api.anthropic.com/v1/routines/r1/fire'): Promise<void> {
  await inOrg(orgId, (db) => db.query(
    `insert into runners(org_id, fire_url, fire_token_enc) values ($1, $2, $3)`,
    [orgId, fireUrl, encrypt('fire-secret-token', orgId)],
  ));
}

/** Ставит вопрос по задаче нового человека: ready → active (fillSlot) → in_progress → blocked (question). */
async function raiseQuestion(orgId: string, ownerId: string, agent: string, now: Date): Promise<string> {
  const person = await addPerson(orgId);
  const act = { kind: 'agent' as const, agentId: agent, userId: ownerId };
  const t = await inOrg(orgId, (db) => createTask(db, { ...base, title: `вопрос-${person}`, assigneeUserId: person }, act, now));
  await inOrg(orgId, (db) => transition(db, t.id, 'take', { kind: 'user', userId: person }, { now }));
  await inOrg(orgId, (db) => transition(db, t.id, 'question', { kind: 'user', userId: person }, { now, text: 'где взять?' }));
  return person;
}

describe('исполнитель агента: /fire на блокирующие события', () => {
  it('вопрос в 10:00 и в 10:05 окна — ровно один /fire', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agent = await makeAgent(orgId, ownerId);
    await makeRunner(orgId);
    const calls: string[] = [];
    setFetchForTests(async (_url, init) => {
      calls.push(JSON.parse(String((init as RequestInit).body)).text as string);
      return new Response(null, { status: 200 });
    });

    await raiseQuestion(orgId, ownerId, agent, MON_10);
    await waitForEvents(orgId);
    expect(await maybeFire(orgId, MON_10)).toBe('fired');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('question');

    await raiseQuestion(orgId, ownerId, agent, minutes(MON_10, 5));
    // Склейка: с прошлого /fire не прошло 15 минут — второй вопрос ждёт, нового вызова нет.
    expect(await maybeFire(orgId, minutes(MON_10, 5))).toBe('skipped');
    expect(calls).toHaveLength(1);
  });

  it('сданная работа будит рутину: человек ждёт приёмки, а не следующего часа', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agent = await makeAgent(orgId, ownerId);
    await makeRunner(orgId);
    const calls: string[] = [];
    setFetchForTests(async (_url, init) => {
      calls.push(JSON.parse(String((init as RequestInit).body)).text as string);
      return new Response(null, { status: 200 });
    });

    const person = await addPerson(orgId);
    const act = { kind: 'agent' as const, agentId: agent, userId: ownerId };
    const task = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'сдать отчёт', assigneeUserId: person }, act, MON_10));
    await inOrg(orgId, (db) => transition(db, task.id, 'take', { kind: 'user', userId: person }, { now: MON_10 }));
    await inOrg(orgId, (db) => transition(db, task.id, 'submit', { kind: 'user', userId: person },
      { now: MON_10, result: { text: 'готово' } }));

    await waitForEvents(orgId);
    expect(await maybeFire(orgId, MON_10)).toBe('fired');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('submitted');
  });

  it('вопрос в 21:00, вне рабочего окна организации — ни одного /fire', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agent = await makeAgent(orgId, ownerId);
    await makeRunner(orgId);
    const calls: unknown[] = [];
    setFetchForTests(async () => { calls.push(1); return new Response(null, { status: 200 }); });

    await raiseQuestion(orgId, ownerId, agent, MON_21);
    expect(await maybeFire(orgId, MON_21)).toBe('skipped');
    expect(calls).toHaveLength(0);
  });

  it('401 от /fire — runner переходит в broken и владелец получает решение', async () => {
    const { orgId, ownerId } = await makeOrg();
    await makeRunner(orgId);
    setFetchForTests(async () => new Response(null, { status: 401 }));
    expect(await fireRunner(orgId, 'setup-check', MON_10)).toBe('broken');
    const runner = await inOrg(orgId, (db) => db.query('select status from runners where org_id = $1', [orgId]));
    expect(runner.rows[0].status).toBe('broken');
    const notif = await inOrg(orgId, (db) => db.query(`select * from notifications where kind = 'runner_broken' and user_id = $1`, [ownerId]));
    expect(notif.rowCount).toBe(1);
  });
});

describe('get_briefing / ack_briefing', () => {
  it('blocked-задача с вопросом видна, курсор двигается только по событиям', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agent = await makeAgent(orgId, ownerId);
    await raiseQuestion(orgId, ownerId, agent, MON_10);

    await waitForEvents(orgId);

    const b1 = await inOrg(orgId, (db) => getBriefing(db, MON_10));
    expect(b1.nothing_to_do).toBe(false);
    const a1 = b1.agents.find((a) => a.id === agent)!;
    const q = a1.events.find((e) => e.type === 'question')!;
    // Текст человека в ленте событий — только под пометкой untrusted (ревью безопасности).
    expect((q.data as { text: unknown }).text).toEqual({ untrusted: true, text: 'где взять?' });
    expect(a1.blocked).toHaveLength(1);
    expect(a1.blocked[0]!.question).toEqual({ untrusted: true, text: 'где взять?' });

    await inOrg(orgId, (db) => ackBriefing(db, b1.cursor));
    await waitForEvents(orgId);
    const b2 = await inOrg(orgId, (db) => getBriefing(db, minutes(MON_10, 1)));
    // «Событий» с прошлого ack больше нет; blocked остаётся видимым — это текущее состояние, не событие.
    expect(b2.agents.find((a) => a.id === agent)!.events).toHaveLength(0);
    expect(b2.agents.find((a) => a.id === agent)!.blocked).toHaveLength(1);
  });

  it('откат вето-изменения владельцем (vetoed) виден агенту в сводке', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agent = await makeAgent(orgId, ownerId);
    await inOrg(orgId, (db) => emit(db, { type: 'vetoed', agentId: agent, data: { change_id: 'x' } }));
    await waitForEvents(orgId);
    const b = await inOrg(orgId, (db) => getBriefing(db, MON_10));
    expect(b.agents.find((a) => a.id === agent)!.events.some((e) => e.type === 'vetoed')).toBe(true);
  });

  it('после ack без остаточного состояния — nothing_to_do: true', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agent = await makeAgent(orgId, ownerId);
    const person = await raiseQuestion(orgId, ownerId, agent, MON_10);
    const task = (await inOrg(orgId, (db) => db.query(`select id from tasks where assignee_user_id = $1`, [person]))).rows[0];
    // Отвечаем сразу — задача возвращается в работу, никакого постоянного состояния не остаётся.
    await inOrg(orgId, (db) => transition(db, task.id, 'answer', { kind: 'user', userId: ownerId }, { now: minutes(MON_10, 1), text: 'вот здесь' }));

    await waitForEvents(orgId);

    const b1 = await inOrg(orgId, (db) => getBriefing(db, minutes(MON_10, 2)));
    expect(b1.nothing_to_do).toBe(false);
    expect(b1.agents.find((a) => a.id === agent)!.blocked).toHaveLength(0);

    await inOrg(orgId, (db) => ackBriefing(db, b1.cursor));
    await waitForEvents(orgId);
    const b2 = await inOrg(orgId, (db) => getBriefing(db, minutes(MON_10, 3)));
    expect(b2.nothing_to_do).toBe(true);
  });

  it('ack с устаревшим курсором не двигает его назад (монотонность)', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agent = await makeAgent(orgId, ownerId);
    await raiseQuestion(orgId, ownerId, agent, MON_10);
    await waitForEvents(orgId);
    const b1 = await inOrg(orgId, (db) => getBriefing(db, MON_10));
    await inOrg(orgId, (db) => ackBriefing(db, b1.cursor));
    const before = await inOrg(orgId, (db) => db.query('select cursor from agent_cursors where agent_id = $1', [agent]));
    await inOrg(orgId, (db) => ackBriefing(db, '0:0'));
    const after = await inOrg(orgId, (db) => db.query('select cursor from agent_cursors where agent_id = $1', [agent]));
    expect(after.rows[0].cursor).toBe(before.rows[0].cursor);
  });
});

describe('токен /fire не появляется в ответах инструментов', () => {
  const app = createApp();
  async function connectClient(email: string): Promise<string> {
    const reg = await request(app).post('/register').send({
      client_name: 'claude.ai', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    });
    const clientId = reg.body.client_id as string;
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const auth = await request(app).get('/authorize').query({
      client_id: clientId, response_type: 'code', redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: challenge, code_challenge_method: 'S256', state: 's1', resource: 'http://localhost:3000/mcp',
    });
    const id = new URL(auth.headers.location!).pathname.split('/').pop()!;
    await request(app).post(`/oauth/login/${id}/email`).type('form').send({ email });
    const mail = outbox.filter((m) => m.to === email).at(-1)!;
    const code = /(\d{6})/.exec(mail.text)![1]!;
    const entered = await request(app).post(`/oauth/login/${id}/code`).type('form').send({ code });
    const consent = await request(app).post(`/oauth/login/${id}/consent`).set('Cookie', loginCookie(entered));
    const cb = new URL(consent.headers.location!);
    const tok = await request(app).post('/token').type('form').send({
      grant_type: 'authorization_code', code: cb.searchParams.get('code'), code_verifier: verifier,
      client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', resource: 'http://localhost:3000/mcp',
    });
    return tok.body.access_token as string;
  }
  async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
    return request(app).post('/mcp').set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream').send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  }

  it('get_briefing не отдаёт fire_token_enc / расшифрованный токен', async () => {
    const { orgId, ownerId } = await makeOrg();
    await makeAgent(orgId, ownerId);
    await makeRunner(orgId, 'https://api.anthropic.com/v1/routines/r2/fire');
    const owner = await inOrg(orgId, (db) => db.query('select id from users where id = $1', [ownerId]));
    expect(owner.rowCount).toBe(1);
    const email = await inOrg(orgId, (db) => db.query('select email from user_emails where user_id = $1', [ownerId]));
    const token = await connectClient(email.rows[0].email);
    const r = await callTool(token, 'get_briefing', { org: orgId });
    const text = JSON.stringify(r.body);
    expect(text).not.toContain('fire-secret-token');
    expect(text).not.toContain('fire_token_enc');
  });
});

// ---------------------------------------------------------------- реплики людей (спека task-comments)

describe('реплики людей к делу в сводке агента', () => {
  /** Задача агента новому человеку — исполнителю есть что дописать к делу. */
  async function taskWithPerson(orgId: string, ownerId: string, agent: string, title = 'поставка стеллажей'): Promise<{ person: string; task: string }> {
    const person = await addPerson(orgId);
    const t = await inOrg(orgId, (db) => createTask(
      db, { ...base, title, assigneeUserId: person }, { kind: 'agent', agentId: agent, userId: ownerId }, MON_10));
    return { person, task: t.id };
  }

  it('комментарий исполнителя приходит агенту под untrusted, поднимает nothing_to_do и начинает неначатое дело', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agent = await makeAgent(orgId, ownerId);
    const { person, task } = await taskWithPerson(orgId, ownerId, agent);
    await inOrg(orgId, (db) => addHumanComment(db, task, person, 'поставщик перенёс на четверг'));

    await waitForEvents(orgId);

    const b = await inOrg(orgId, (db) => getBriefing(db, minutes(MON_10, 2)));
    expect(b.nothing_to_do).toBe(false);
    const a = b.agents.find((x) => x.id === agent)!;
    expect(a.comments).toHaveLength(1);
    expect(a.comments[0]).toMatchObject({
      task, kind: 'comment', answered: false,
      title: { untrusted: true, text: 'поставка стеллажей' },
      text: { untrusted: true, text: 'поставщик перенёс на четверг' },
    });
    // Событие `comment` тоже доходит — тоже под пометкой untrusted.
    const ev = a.events.find((e) => e.type === 'comment')!;
    expect((ev.data as { text: unknown }).text).toEqual({ untrusted: true, text: 'поставщик перенёс на четверг' });

    // Первая реплика исполнителя к неначатому делу начинает его (спека auto-start).
    const after = await inOrg(orgId, (db) => db.query('select status, started_via from tasks where id = $1', [task]));
    expect(after.rows[0]).toEqual({ status: 'in_progress', started_via: 'comment' });
  });

  it('пока агент не ответил — реплика приходит снова; ответ (comment_task) убирает её из сводки', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agent = await makeAgent(orgId, ownerId);
    const { person, task } = await taskWithPerson(orgId, ownerId, agent);
    await inOrg(orgId, (db) => addHumanComment(db, task, person, 'сделал половину, вторая ждёт счёта'));

    await waitForEvents(orgId);

    const b1 = await inOrg(orgId, (db) => getBriefing(db, minutes(MON_10, 2)));
    expect(b1.agents.find((x) => x.id === agent)!.comments).toHaveLength(1);
    await inOrg(orgId, (db) => ackBriefing(db, b1.cursor));

    // Событие уже подтверждено, но реплика без ответа остаётся в блоке и держит сводку непустой.
    await waitForEvents(orgId);
    const b2 = await inOrg(orgId, (db) => getBriefing(db, minutes(MON_10, 3)));
    expect(b2.agents.find((x) => x.id === agent)!.events).toHaveLength(0);
    expect(b2.agents.find((x) => x.id === agent)!.comments).toHaveLength(1);
    expect(b2.nothing_to_do).toBe(false);
    await inOrg(orgId, (db) => ackBriefing(db, b2.cursor));

    await inOrg(orgId, (db) => addComment(db, task, { kind: 'agent', agentId: agent, userId: ownerId }, 'понял, жду счёт'));

    await waitForEvents(orgId);

    const b3 = await inOrg(orgId, (db) => getBriefing(db, minutes(MON_10, 5)));
    const a3 = b3.agents.find((x) => x.id === agent)!;
    expect(a3.comments).toEqual([]);
    // Своя реплика агенту событием не возвращается.
    expect(a3.events.filter((e) => e.type === 'comment')).toEqual([]);
    expect(b3.nothing_to_do).toBe(true);
  });

  it('реплика владельца к задаче агента — указание (owner_instruction)', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agent = await makeAgent(orgId, ownerId);
    const { task } = await taskWithPerson(orgId, ownerId, agent, 'обзвон поставщиков');

    const added = await inOrg(orgId, (db) => addHumanComment(db, task, ownerId, 'сначала проверь наличие на складе'));
    expect(added.kind).toBe('owner_instruction');

    const row = await inOrg(orgId, (db) => db.query(
      'select kind from task_messages where task_id = $1 and author_user_id = $2', [task, ownerId]));
    expect(row.rows[0].kind).toBe('owner_instruction');

    await waitForEvents(orgId);

    const b = await inOrg(orgId, (db) => getBriefing(db, minutes(MON_10, 2)));
    const a = b.agents.find((x) => x.id === agent)!;
    expect(a.comments[0]).toMatchObject({ kind: 'owner_instruction', text: { untrusted: true, text: 'сначала проверь наличие на складе' } });
  });

  it('указание владельца в деле агента — исполнитель получает уведомление (30.09)', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agent = await makeAgent(orgId, ownerId);
    const { person, task } = await taskWithPerson(orgId, ownerId, agent, 'обзвон поставщиков');
    await inOrg(orgId, (db) => addHumanComment(db, task, ownerId, 'сначала проверь наличие на складе'));
    const n = await inOrg(orgId, (db) => db.query(
      `select user_id from notifications where kind = 'task_comment' and task_id = $1`, [task]));
    expect(n.rows.map((r) => r.user_id)).toEqual([person]);
    // Реплика самого исполнителя в деле агента — никому не уведомление (агент читает сводку).
    await inOrg(orgId, (db) => addHumanComment(db, task, person, 'понял'));
    const n2 = await inOrg(orgId, (db) => db.query(
      `select count(*)::int as c from notifications where kind = 'task_comment' and task_id = $1`, [task]));
    expect(n2.rows[0].c).toBe(1);
  });

  it('больше 20 реплик к задаче в сутки от одного человека → limit_exceeded', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agent = await makeAgent(orgId, ownerId);
    const { person, task } = await taskWithPerson(orgId, ownerId, agent);
    for (let i = 0; i < 20; i++) {
      await inOrg(orgId, (db) => addHumanComment(db, task, person, `реплика ${i}`));
    }
    await expect(inOrg(orgId, (db) => addHumanComment(db, task, person, 'двадцать первая')))
      .rejects.toMatchObject({ code: 'limit_exceeded' });
    const n = await inOrg(orgId, (db) => db.query('select count(*)::int as n from task_messages where task_id = $1', [task]));
    expect(n.rows[0].n).toBe(20);
  });

  it('посторонний участник организации писать в чужое дело не может', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agent = await makeAgent(orgId, ownerId);
    const { task } = await taskWithPerson(orgId, ownerId, agent);
    const stranger = await addPerson(orgId);
    await expect(inOrg(orgId, (db) => addHumanComment(db, task, stranger, 'а я мимо проходил')))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it('реплика рутину не будит: список блокирующих событий /fire не изменился', async () => {
    // Сторож списка: комментарий добавлен в сводку, но НЕ в блокирующие события (решение владельца 71).
    // Сданная работа — повод (спека agent-runtime): человек закончил и ждёт, держать его час незачем.
    const src = readFileSync('src/runtime/fire.ts', 'utf8');
    const block = /BLOCKING_EVENT_TYPES = \[([^\]]*)\]/.exec(src)![1]!;
    expect([...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]))
      .toEqual(['question', 'unclear', 'declined', 'person_idle', 'task_submitted']);

    const { orgId, ownerId } = await makeOrg();
    const agent = await makeAgent(orgId, ownerId);
    await makeRunner(orgId);
    const calls: unknown[] = [];
    setFetchForTests(async () => { calls.push(1); return new Response(null, { status: 200 }); });

    const { person, task } = await taskWithPerson(orgId, ownerId, agent);
    await inOrg(orgId, (db) => addHumanComment(db, task, person, 'поставщик перенёс на четверг'));
    expect(await maybeFire(orgId, minutes(MON_10, 2))).toBe('skipped');
    expect(calls).toHaveLength(0);
  });
});
