import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import './helpers.js';
import { closePools, withGlobal } from '../src/db/pool.js';
import { addMember, ensureUserByEmail } from '../src/core/people.js';
import { sha256 } from '../src/core/crypto.js';
import { outbox } from '../src/email/send.js';
import { connectClient, callTool } from './mcp-client.js';

afterAll(closePools);

// Вход по коду почты (connectClient) идёт через общий rate-limit /oauth/login/* (src/web/rate-limit.ts,
// не наш файл) — поэтому в тестах инструментов минимизируем число полных OAuth-входов: один владелец
// на большинство сценариев плюс один участник для проверки «не владелец агента».

async function insertInviteCode(): Promise<string> {
  const code = randomUUID();
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query(`insert into product_invite_codes(code_hash, note, created_by) values ($1, 'test', 'test')`, [sha256(code)]);
  await client.end();
  return code;
}

async function addExistingMember(orgId: string, email: string): Promise<void> {
  await withGlobal(async (db) => {
    const { user } = await ensureUserByEmail(db, email, { verified: true });
    await addMember(db, orgId, user.id, 'member');
  });
}

function parse(r: Awaited<ReturnType<typeof callTool>>): any {
  return JSON.parse(r.body.result.content[0].text);
}

const validStep = (extra: Record<string, unknown> = {}) => ({
  why: 'зачем', done_criteria: 'критерий', due_date: '2026-12-31', idempotency_key: randomUUID(),
  description: 'как делать: открыть таблицу и свериться',
  source: { kind: 'chat', title: 'разговор', quote: 'так и сказал' }, ...extra,
});


describe('MCP-инструменты (спека mcp-and-oauth)', () => {
  let token: string;
  let orgId: string;
  let ownerEmail: string;

  beforeAll(async () => {
    ownerEmail = `owner-${randomUUID()}@test.local`;
    token = await connectClient(ownerEmail);
    const code = await insertInviteCode();
    const org = await callTool(token, 'create_org', { name: `Org ${randomUUID().slice(0, 6)}`, invite_code: code });
    orgId = parse(org).org_id as string;
  });

  it('create_org: без действительного кода — forbidden', async () => {
    const bad = await callTool(token, 'create_org', { name: 'Org X', invite_code: 'нет-такого-кода' });
    expect(bad.body.result.isError).toBe(true);
    expect(parse(bad).code).toBe('forbidden');
  });

  it('create_org: с действительным кодом — ok (сделано в beforeAll)', () => {
    expect(orgId).toBeTruthy();
  });

  async function freshPlan(): Promise<{ agentId: string; planId: string }> {
    const agentRes = await callTool(token, 'create_agent', { org: orgId, name: `agent-${randomUUID().slice(0, 6)}` });
    const agentId = parse(agentRes).id as string;
    const planRes = await callTool(token, 'create_plan', { org: orgId, agent: agentId, goal: 'цель' });
    const planId = parse(planRes).id as string;
    return { agentId, planId };
  }

  it('add_step: без why/done_criteria/due_date — validation_failed', async () => {
    const { agentId, planId } = await freshPlan();
    const r = await callTool(token, 'add_step', { org: orgId, agent: agentId, plan: planId, title: 'шаг', assignee: ownerEmail, idempotency_key: randomUUID() });
    expect(r.body.result.isError).toBe(true);
    expect(parse(r).code).toBe('validation_failed');
  });

  it('idempotency_key: повтор — тот же объект, другое тело — idempotency_conflict', async () => {
    const { agentId, planId } = await freshPlan();
    const args = { org: orgId, agent: agentId, plan: planId, title: 'шаг', assignee: ownerEmail, ...validStep() };
    const r1 = await callTool(token, 'add_step', args);
    const b1 = parse(r1);
    expect(r1.body.result.isError).toBeFalsy();

    const r2 = await callTool(token, 'add_step', args);
    expect(parse(r2).id).toBe(b1.id);

    const r3 = await callTool(token, 'add_step', { ...args, title: 'другой шаг' });
    expect(r3.body.result.isError).toBe(true);
    expect(parse(r3).code).toBe('idempotency_conflict');
  });

  it('agent: не владелец — forbidden при вызове с agent', async () => {
    const { agentId, planId } = await freshPlan();
    const email2 = `member-${randomUUID()}@test.local`;
    await addExistingMember(orgId, email2);
    const token2 = await connectClient(email2);
    const r = await callTool(token2, 'add_step', { org: orgId, agent: agentId, plan: planId, title: 'шаг', assignee: email2, ...validStep() });
    expect(r.body.result.isError).toBe(true);
    expect(parse(r).code).toBe('forbidden');
  });

  it('dry_run: не создаёт строк и уведомлений', async () => {
    const { agentId, planId } = await freshPlan();
    const title = `пробный шаг ${randomUUID()}`;
    const r = await callTool(token, 'add_step', { org: orgId, agent: agentId, plan: planId, title, assignee: ownerEmail, ...validStep({ dry_run: true }) });
    expect(r.body.result.isError).toBeFalsy();
    expect(parse(r).dry_run).toBe(true);

    const list = await callTool(token, 'find_task', { org: orgId, plan: planId });
    const tasks = parse(list).tasks as { title: string }[];
    expect(tasks.find((t) => t.title === title)).toBeUndefined();
  });

  // Ожидание заводится тем же create_task, дата проверки двигается тем же update_task
  // (слияние поверхности коннектора: create_waiting и set_check_date больше нет).
  it("create_task(kind: 'waiting') заводит ожидание, update_task(next_check_at) двигает проверку", async () => {
    const title = `ответ поставщика ${randomUUID().slice(0, 6)}`;
    const made = await callTool(token, 'create_task', {
      org: orgId, title, assignee: ownerEmail, kind: 'waiting', why: 'без ответа не заказываем',
      waiting_for: 'поставщик',
      expected_at: '2026-12-01T09:00:00Z', next_check_at: '2026-11-20T09:00:00Z', on_arrival: 'подтвердить срок',
      idempotency_key: randomUUID(),
    });
    expect(made.body.result.isError).toBeFalsy();
    const task = parse(made);
    expect(task.kind).toBe('waiting');
    expect(task.status).toBe('waiting');
    expect(task.waiting).toMatchObject({ waiting_for: 'поставщик', on_arrival: 'подтвердить срок' });
    expect(task.waiting.next_check_at.slice(0, 10)).toBe('2026-11-20');

    const moved = await callTool(token, 'update_task', { org: orgId, task: task.id, next_check_at: '2026-11-25T09:00:00Z' });
    expect(moved.body.result.isError).toBeFalsy();
    expect(parse(moved).waiting.next_check_at.slice(0, 10)).toBe('2026-11-25');

    const arrived = await callTool(token, 'resolve_waiting', { org: orgId, task: task.id });
    expect(arrived.body.result.isError).toBeFalsy();
    expect(parse(arrived).status).toBe('resolved');
  });

  it("поля ожидания без kind: 'waiting' — validation_failed, а не молча забытые", async () => {
    const r = await callTool(token, 'create_task', {
      org: orgId, title: 'позвонить поставщику', assignee: ownerEmail, waiting_for: 'поставщик', ...validStep(),
    });
    expect(r.body.result.isError).toBe(true);
    expect(parse(r).code).toBe('validation_failed');
    expect(parse(r).message).toContain('waiting_for');
  });

  it('agent_paused: пауза агента отвечает agent_paused на запись', async () => {
    const { agentId, planId } = await freshPlan();
    const pause = await callTool(token, 'update_agent', { org: orgId, agent: agentId, status: 'paused' });
    expect(pause.body.result.isError).toBeFalsy();

    const r = await callTool(token, 'add_step', { org: orgId, agent: agentId, plan: planId, title: 'шаг', assignee: ownerEmail, ...validStep() });
    expect(r.body.result.isError).toBe(true);
    expect(parse(r).code).toBe('agent_paused');
  });

  it('invite_person: письмо в outbox с t.me-ссылкой', async () => {
    const email2 = `invitee-${randomUUID()}@test.local`;
    const r = await callTool(token, 'invite_person', { org: orgId, email: email2, role: 'member' });
    expect(r.body.result.isError).toBeFalsy();
    expect(parse(r).membershipStatus).toBe('invited');

    const mail = outbox.filter((m) => m.to === email2).at(-1);
    expect(mail).toBeTruthy();
    expect(mail!.text).toMatch(/t\.me\/[^/]+\?start=inv_/);
    // Ссылки с токеном в ответе нет: кто её откроет, тот и войдёт этим человеком (аудит безопасности).
    expect(JSON.stringify(parse(r))).not.toContain('inv_');
    // Имя владельца не задано — в письме название организации, а не часть почты до «@».
    expect(mail!.text).not.toContain(ownerEmail.split('@')[0]);
  });

  it('set_person_settings: своё имя — любой, и оно попадает в следующее приглашение', async () => {
    const me = await callTool(token, 'set_person_settings', { org: orgId, person: ownerEmail, name: 'Олег' });
    expect(me.body.result.isError).toBeFalsy();
    const email3 = `invitee-${randomUUID()}@test.local`;
    await callTool(token, 'invite_person', { org: orgId, email: email3, role: 'member', language: 'ru' });
    expect(outbox.filter((m) => m.to === email3).at(-1)!.text).toContain('Олег приглашает');

    // Обычный участник может сменить только своё имя, чужое — нет.
    const memberEmail = `member-${randomUUID()}@test.local`;
    await addExistingMember(orgId, memberEmail);
    const memberToken = await connectClient(memberEmail);
    expect((await callTool(memberToken, 'set_person_settings', { org: orgId, person: memberEmail, name: 'Ахмет' })).body.result.isError).toBeFalsy();
    const other = await callTool(memberToken, 'set_person_settings', { org: orgId, person: ownerEmail, name: 'взлом' });
    expect(other.body.result.isError).toBe(true);
    const mine = await callTool(memberToken, 'set_person_settings', { org: orgId, person: memberEmail, name: 'Ахмет', daily_step_limit: 99 });
    expect(mine.body.result.isError).toBe(true);
  });
  it('invite_person(resend): новое письмо с новой ссылкой, прежняя ссылка больше не работает', async () => {
    const email = `invitee-${randomUUID()}@test.local`;
    await callTool(token, 'invite_person', { org: orgId, email, role: 'member' });
    const r = await callTool(token, 'invite_person', { org: orgId, email, resend: true });
    expect(r.body.result.isError).toBeFalsy();
    const mails = outbox.filter((m) => m.to === email);
    expect(mails).toHaveLength(2);
    // Ссылки — только в письмах: первая и новая разные.
    const link = (text: string) => /start=inv_([^\s"<]+)/.exec(text)![1]!;
    const oldToken = link(mails[0]!.text);
    expect(link(mails[1]!.text)).not.toBe(oldToken);
    const rows = await withGlobal((db) => db.query('select 1 from invitations where token_hash = $1', [sha256(oldToken)]));
    expect(rows.rowCount).toBe(0);
  });
});
