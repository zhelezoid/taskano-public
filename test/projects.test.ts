import { createHmac, randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools, withGlobal, withOrgBackground } from '../src/db/pool.js';
import { sha256 } from '../src/core/crypto.js';
import { createTask } from '../src/core/tasks.js';
import { createProject, setTaskProject, updateProject } from '../src/core/projects.js';
import { addSource } from '../src/core/sources.js';
import { addComment } from '../src/mcp/tools/tasks.js';
import { transition } from '../src/core/lifecycle.js';
import { fillSlot } from '../src/core/queue.js';
import { activateScheduled } from '../src/core/tasks.js';
import { getBriefing } from '../src/runtime/briefing.js';
import { readEvents } from '../src/core/events.js';
import { tickOrg } from '../src/worker/tick.js';
import { offboardPerson } from '../src/core/invitations.js';
import { miniappRoutes } from '../src/web/miniapp-api.js';
import { buildCard } from '../src/bot/card-view.js';
import { findTaskByShortId } from '../src/bot/lookup.js';
import { addPerson, inOrg, makeAgent, makeOrg, minutes, MON_10, uniq, waitForEvents } from './helpers.js';
import { callTool, connectClient } from './mcp-client.js';

// Проекты — спека projects. Главное здесь: дела закрытого проекта видит только его
// хозяин, и держит это одно правило RLS (`private_owner_user_id` + `app.actor_user_id`), а не код
// каждой выборки. Поэтому почти все проверки — «кто что видит», а не «что вернул инструмент».

afterAll(closePools);

const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };
const human = (userId: string) => ({ kind: 'user' as const, userId });
const asAgent = (agentId: string, userId: string) => ({ kind: 'agent' as const, agentId, userId });

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'no error';
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

/** Видно ли дело в сессии этого человека (пусто — сессия без действующего лица, как у агента). */
async function sees(orgId: string, taskId: string, userId?: string): Promise<boolean> {
  const r = await inOrg(orgId, (db) => db.query('select 1 from tasks where id = $1', [taskId]), userId);
  return r.rowCount === 1;
}

describe('проекты: правило видимости (спека projects)', () => {
  it('дело закрытого проекта видит хозяин; сессия без app.actor_user_id и коллега — нет', async () => {
    const { orgId, ownerId } = await makeOrg();
    const colleague = await addPerson(orgId);
    const project = await inOrg(orgId, (db) => createProject(db, { name: `Здоровье ${uniq()}`, private: true }, human(ownerId)), ownerId);
    expect(project.private).toBe(true);

    const task = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'записаться к врачу', assigneeUserId: ownerId, project: project.id }, human(ownerId), MON_10), ownerId);
    // Правило видимости живёт в самом деле — одним условием политики, без подзапроса к проектам.
    expect(task.private_owner_user_id).toBe(ownerId);
    expect(task.project_id).toBe(project.id);

    expect(await sees(orgId, task.id, ownerId)).toBe(true);
    // Отказ в безопасную сторону: переменной сессии нет — закрытое не видно (так идёт агент).
    expect(await sees(orgId, task.id)).toBe(false);
    expect(await sees(orgId, task.id, colleague)).toBe(false);
  });

  it('дело открытого проекта видно всем в организации, в том числе сессии без действующего лица', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agentId = await makeAgent(orgId, ownerId);
    const task = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'открытое дело', assigneeUserId: person }, asAgent(agentId, ownerId), MON_10));
    expect(task.private_owner_user_id).toBeNull();
    // Проект по умолчанию завела миграция 008 — дело попало в него, не оставшись без проекта.
    expect(task.project_id).toBeTruthy();
    expect(await sees(orgId, task.id)).toBe(true);
    expect(await sees(orgId, task.id, person)).toBe(true);
  });

  it('закрытие проекта прячет его дела, открытие — возвращает', async () => {
    const { orgId, ownerId } = await makeOrg();
    const project = await inOrg(orgId, (db) => createProject(db, { name: `Переезд ${uniq()}` }, human(ownerId)), ownerId);
    const task = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'своё дело', assigneeUserId: ownerId, project: project.id }, human(ownerId), MON_10), ownerId);
    expect(await sees(orgId, task.id)).toBe(true);

    await inOrg(orgId, (db) => updateProject(db, project.id, { private: true }, human(ownerId)), ownerId);
    expect(await sees(orgId, task.id)).toBe(false);
    expect(await sees(orgId, task.id, ownerId)).toBe(true);

    await inOrg(orgId, (db) => updateProject(db, project.id, { private: false }, human(ownerId)), ownerId);
    expect(await sees(orgId, task.id)).toBe(true);
    // Открытие — решение человека, и оно пишет событие: дела становятся видны агентам.
    const opened = await inOrg(orgId, (db) => db.query(
      `select 1 from events where type = 'project_opened' and data->>'project_id' = $1`, [project.id]), ownerId);
    expect(opened.rowCount).toBe(1);
  });

  it('закрытый проект — только для своих дел: чужое в него не назначается и с чужими делами он не закрывается', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agentId = await makeAgent(orgId, ownerId);
    const person = await addPerson(orgId);
    const foreign = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'дело сотрудника', assigneeUserId: person }, asAgent(agentId, ownerId), MON_10));

    const closed = await inOrg(orgId, (db) => createProject(db, { name: `Моё ${uniq()}`, private: true }, human(ownerId)), ownerId);
    expect(await codeOf(inOrg(orgId, (db) => setTaskProject(db, foreign.id, closed.id, human(ownerId)), ownerId))).toBe('validation_failed');
    expect(await sees(orgId, foreign.id, person)).toBe(true);

    const open = await inOrg(orgId, (db) => createProject(db, { name: `Общее ${uniq()}` }, human(ownerId)), ownerId);
    await inOrg(orgId, (db) => setTaskProject(db, foreign.id, open.id, human(ownerId)), ownerId);
    expect(await codeOf(inOrg(orgId, (db) => updateProject(db, open.id, { private: true }, human(ownerId)), ownerId))).toBe('validation_failed');
    expect(await sees(orgId, foreign.id, person)).toBe(true);

    // Закрытый проект заводит только человек: агенту хозяином закрытого не стать.
    expect(await codeOf(inOrg(orgId, (db) => createProject(db, { name: `Агентское ${uniq()}`, private: true }, asAgent(agentId, ownerId)))))
      .toBe('forbidden');
  });

  it('update_task(project) меняет проект одной строкой — история дела остаётся на месте', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agentId = await makeAgent(orgId, ownerId);
    const person = await addPerson(orgId);
    const actor = asAgent(agentId, ownerId);
    const task = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'перевезти стенд', assigneeUserId: person }, actor, MON_10));
    await inOrg(orgId, (db) => addSource(db, {
      taskId: task.id, kind: 'external', title: 'Linear EXT-1', system: 'linear', externalId: `EXT-${task.short_id}`,
    }, actor, MON_10));
    await inOrg(orgId, (db) => addComment(db, task.id, actor, 'что со стендом?'));

    const history = async () => inOrg(orgId, async (db) => ({
      sources: (await db.query('select count(*)::int as n from task_sources where task_id = $1', [task.id])).rows[0].n as number,
      messages: (await db.query('select count(*)::int as n from task_messages where task_id = $1', [task.id])).rows[0].n as number,
      events: (await db.query('select count(*)::int as n from events where task_id = $1', [task.id])).rows[0].n as number,
    }));
    const before = await history();

    const project = await inOrg(orgId, (db) => createProject(db, { name: `Склад ${uniq()}` }, actor));
    const moved = await inOrg(orgId, (db) => setTaskProject(db, task.id, project.name, actor));
    expect(moved.id).toBe(task.id);
    expect(moved.project_id).toBe(project.id);
    expect(moved.version).toBe(task.version + 1);

    const after = await history();
    expect(after.sources).toBe(before.sources);
    expect(after.messages).toBe(before.messages);
    // Смена проекта — одно событие правки, вся прежняя лента дела на месте.
    expect(after.events).toBe(before.events + 1);
  });

  it('чужая организация проектов не видит', async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    const theirs = await inOrg(b.orgId, (db) => createProject(db, { name: `Поставки ${uniq()}` }, human(b.ownerId)), b.ownerId);

    const seen = await inOrg(a.orgId, (db) => db.query('select count(*)::int as n from projects where id = $1', [theirs.id]), a.ownerId);
    expect(seen.rows[0].n).toBe(0);
    await expect(inOrg(a.orgId, (db) => db.query(
      `insert into projects(org_id, name, owner_user_id) values ($1, 'чужой', $2)`, [b.orgId, b.ownerId]), a.ownerId))
      .rejects.toThrow(/row-level security/);
  });

  it('бот: карточка показывает проект, и дело закрытого проекта находится по короткому номеру', async () => {
    const { orgId, ownerId } = await makeOrg();
    const name = `Аренда ${uniq()}`;
    const project = await inOrg(orgId, (db) => createProject(db, { name, private: true }, human(ownerId)), ownerId);
    const task = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'продлить договор', assigneeUserId: ownerId, project: project.id }, human(ownerId), MON_10), ownerId);

    // Бот ищет дело среди организаций человека и действует от его имени — иначе своё же дело
    // закрытого проекта он бы не нашёл.
    const found = await findTaskByShortId(ownerId, String(task.short_id));
    expect(found?.task.id).toBe(task.id);
    const card = await inOrg(orgId, (db) => buildCard(db, found!.task, 'ru', { sourceLang: 'ru', personal: false, viewerUserId: ownerId }), ownerId);
    expect(card.text).toContain(`Проект: ${name}`);
  });

  it('дела архивного проекта не выдаются в очередь', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agentId = await makeAgent(orgId, ownerId);
    const person = await addPerson(orgId);
    const actor = asAgent(agentId, ownerId);
    const project = await inOrg(orgId, (db) => createProject(db, { name: `Ярмарка ${uniq()}` }, actor));
    const first = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'первое', assigneeUserId: person, project: project.id }, actor, MON_10));
    const second = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'второе', assigneeUserId: person, project: project.id }, actor, MON_10));

    await inOrg(orgId, (db) => updateProject(db, project.id, { status: 'archived' }, asAgent(agentId, ownerId)));
    await inOrg(orgId, (db) => transition(db, first.id, 'cancel', actor, { now: minutes(MON_10, 1) }));
    const picked = await inOrg(orgId, (db) => fillSlot(db, person, minutes(MON_10, 2)));
    expect(picked).toBeNull();
    const still = await inOrg(orgId, (db) => db.query('select status from tasks where id = $1', [second.id]));
    expect(still.rows[0].status).toBe('ready');
  });
});

// ---------------------------------------------------------------- коннектор

function parse(r: Awaited<ReturnType<typeof callTool>>): any {
  return JSON.parse(r.body.result.content[0].text);
}

async function insertInviteCode(): Promise<string> {
  const code = randomUUID();
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query(`insert into product_invite_codes(code_hash, note, created_by) values ($1, 'test', 'test')`, [sha256(code)]);
  await client.end();
  return code;
}

const validStep = (extra: Record<string, unknown> = {}) => ({
  why: 'зачем', done_criteria: 'критерий', due_date: '2026-12-31', idempotency_key: randomUUID(),
  description: 'как делать: открыть таблицу и свериться',
  source: { kind: 'chat', title: 'разговор', quote: 'так и сказал' }, ...extra,
});

describe('закрытый проект через коннектор (спека projects)', () => {
  let token: string;
  let orgId: string;
  let ownerEmail: string;
  let agentId: string;
  let projectName: string;
  let privateTask: { id: string };
  let openTask: { id: string };
  const externalId = `EXT-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    ownerEmail = `owner-${randomUUID()}@test.local`;
    token = await connectClient(ownerEmail);
    orgId = parse(await callTool(token, 'create_org', { name: `Org ${uniq()}`, invite_code: await insertInviteCode() })).org_id;
    agentId = parse(await callTool(token, 'create_agent', { org: orgId, name: `agent-${uniq()}` })).id;

    projectName = `Здоровье ${uniq()}`;
    const project = await callTool(token, 'create_project', { org: orgId, name: projectName, private: true });
    expect(project.body.result.isError).toBeFalsy();
    privateTask = parse(await callTool(token, 'create_task', {
      org: orgId, title: 'записаться к врачу', assignee: ownerEmail, project: projectName, ...validStep(),
    }));
    await callTool(token, 'add_source', {
      org: orgId, task: privateTask.id, kind: 'external', title: `Linear ${externalId}`, system: 'linear', external_id: externalId,
    });
    openTask = parse(await callTool(token, 'create_task', {
      org: orgId, title: 'открытое дело', assignee: ownerEmail, ...validStep(),
    }));
  });

  it('агент не видит дела закрытого проекта: ни в поиске, ни в get_task, ни по ключу трекера, ни в сводке', async () => {
    const list = parse(await callTool(token, 'find_task', { org: orgId, agent: agentId }));
    expect(list.tasks.map((t: { id: string }) => t.id)).toContain(openTask.id);
    expect(list.tasks.map((t: { id: string }) => t.id)).not.toContain(privateTask.id);

    const got = await callTool(token, 'get_task', { org: orgId, agent: agentId, task: privateTask.id });
    expect(got.body.result.isError).toBe(true);
    expect(parse(got).code).toBe('not_found');

    // Поиск по объекту внешней системы идёт джойном к делу — закрытое не отдаётся и по ключу трекера.
    const found = parse(await callTool(token, 'find_task', { org: orgId, agent: agentId, external: { system: 'linear', id: externalId } }));
    expect(found.tasks).toEqual([]);

    // Сводка routine: ни идентификатора дела, ни его названия, ни названия закрытого проекта.
    const briefing = await callTool(token, 'get_briefing', { org: orgId });
    expect(briefing.body.result.isError).toBeFalsy();
    const text = JSON.stringify(briefing.body);
    expect(text).not.toContain(privateTask.id);
    expect(text).not.toContain('записаться к врачу');
    expect(text).toContain(openTask.id);

    const projects = parse(await callTool(token, 'list_projects', { org: orgId, agent: agentId }));
    expect(projects.projects.map((p: { name: string }) => p.name)).not.toContain(projectName);
  });

  it('человек видит своё закрытое дело через коннектор', async () => {
    const list = parse(await callTool(token, 'find_task', { org: orgId }));
    expect(list.tasks.map((t: { id: string }) => t.id)).toContain(privateTask.id);

    const got = parse(await callTool(token, 'get_task', { org: orgId, task: privateTask.id }));
    expect(got.task.id).toBe(privateTask.id);

    const found = parse(await callTool(token, 'find_task', { org: orgId, external: { system: 'linear', id: externalId } }));
    expect(found.tasks[0].id).toBe(privateTask.id);

    const projects = parse(await callTool(token, 'list_projects', { org: orgId }));
    const mine = projects.projects.find((p: { name: string }) => p.name === projectName);
    expect(mine.private).toBe(true);
    expect(mine.tasks_open).toBe(1);
  });

  it('update_task(project): дело уходит из закрытого проекта и становится видно агенту', async () => {
    const moving = parse(await callTool(token, 'create_task', {
      org: orgId, title: 'договор с поставщиком', assignee: ownerEmail, project: projectName, ...validStep(),
    }));
    const hidden = parse(await callTool(token, 'find_task', { org: orgId, agent: agentId }));
    expect(hidden.tasks.map((t: { id: string }) => t.id)).not.toContain(moving.id);

    const open = parse(await callTool(token, 'list_projects', { org: orgId, agent: agentId })).projects[0];
    const r = await callTool(token, 'update_task', { org: orgId, task: moving.id, project: open.id });
    expect(r.body.result.isError).toBeFalsy();

    const after = parse(await callTool(token, 'find_task', { org: orgId, agent: agentId }));
    expect(after.tasks.map((t: { id: string }) => t.id)).toContain(moving.id);
  });

  // Закрытое дело переносится (разбор архива по проектам), но остальные поля у него не меняются.
  // Если перенос идёт первым, вызов с двумя полями отвечает «дело закрыто», уже откатив состоявшийся
  // переезд, — агент решит, что не приняли только название (ревью слияний).
  it('update_task: закрытое дело переносится, а вместе с другим полем — отказ, и дело остаётся на месте', async () => {
    const [from, to] = parse(await callTool(token, 'list_projects', { org: orgId })).projects.slice(0, 2);
    const task = parse(await callTool(token, 'create_task', {
      org: orgId, title: 'закрыть год', assignee: ownerEmail, project: from.id, ...validStep(),
    }));
    await callTool(token, 'cancel_task', { org: orgId, task: task.id });

    const both = await callTool(token, 'update_task', { org: orgId, task: task.id, project: to.id, title: 'Договор 2025' });
    expect(both.body.result.isError).toBe(true);
    expect(parse(both).code).toBe('conflict');
    expect(parse(await callTool(token, 'get_task', { org: orgId, task: task.id })).task.project_id).toBe(from.id);

    const alone = await callTool(token, 'update_task', { org: orgId, task: task.id, project: to.id });
    expect(alone.body.result.isError).toBeFalsy();
    expect(parse(await callTool(token, 'get_task', { org: orgId, task: task.id })).task.project_id).toBe(to.id);
  });
});

// ---------------------------------------------------------------- Mini App

const BOT_TOKEN = 'test-bot-token-projects';
const miniapp = express();
miniappRoutes(miniapp, { botToken: BOT_TOKEN });

let tgSeq = 960000000;

/** Повторяет алгоритм подписи Telegram WebApp (как в test/miniapp-auth.test.ts). */
function buildInitData(telegramUserId: number): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: telegramUserId, first_name: 'Test' }),
  });
  const dataCheckString = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}

describe('Mini App: дело закрытого проекта (спека projects)', () => {
  it('человек видит своё закрытое дело в списке, у проекта — признак закрытости', async () => {
    const { orgId, ownerId } = await makeOrg();
    tgSeq += 1;
    const telegramUserId = tgSeq;
    await withGlobal((db) => db.query(
      `insert into telegram_links(telegram_user_id, user_id, chat_id) values ($1, $2, $1)`, [telegramUserId, ownerId]));
    const initData = buildInitData(telegramUserId);

    const name = `Личное дело ${uniq()}`;
    const project = await inOrg(orgId, (db) => createProject(db, { name, private: true }, human(ownerId)), ownerId);
    const task = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'продлить страховку', assigneeUserId: ownerId, project: project.id }, human(ownerId), MON_10), ownerId);

    const lists = await request(miniapp).get('/app/api/lists').set('X-Telegram-Init-Data', initData);
    expect(lists.status).toBe(200);
    const space = lists.body.spaces.find((s: { org_id: string }) => s.org_id === orgId);
    const shown = [...space.lists.now, ...space.lists.queue].find((t: { id: string }) => t.id === task.id);
    expect(shown).toBeTruthy();
    expect(shown.project).toEqual({ id: project.id, name, private: true, key: project.key });

    const card = await request(miniapp).get(`/app/api/tasks/${task.id}`).set('X-Telegram-Init-Data', initData);
    expect(card.status).toBe(200);
    expect(card.body.task.project.name).toBe(name);
  });
});

describe('закрытое не течёт агенту ни одним путём', () => {
  /** Организация, агент, его дело у владельца — и владелец прячет дело в свой закрытый проект. */
  async function hidden() {
    const { orgId, ownerId } = await makeOrg();
    const agentId = await makeAgent(orgId, ownerId);
    const token = await connectClient(`hide-${uniq()}@test.local`);
    const secret = await inOrg(orgId, (db) => createProject(db, { name: `Своё ${uniq()}`, private: true }, human(ownerId)), ownerId);
    const task = await inOrg(orgId, (db) => createTask(db, {
      ...base, title: 'ТАЙНА-НАЗВАНИЕ', assigneeUserId: ownerId,
    }, asAgent(agentId, ownerId), MON_10), ownerId);
    await inOrg(orgId, (db) => addComment(db, task.id, human(ownerId), 'ТАЙНА-РЕПЛИКА'), ownerId);
    await inOrg(orgId, (db) => setTaskProject(db, task.id, secret.id, human(ownerId)), ownerId);
    return { orgId, ownerId, agentId, task, secret, token };
  }

  it('сводка агентская: спрятанное дело не приходит ни названием, ни текстом', async () => {
    const w = await hidden();
    const b = await inOrg(w.orgId, (db) => getBriefing(db, minutes(MON_10, 5)), w.ownerId);
    const dump = JSON.stringify(b);
    expect(dump).not.toContain('ТАЙНА-НАЗВАНИЕ');
    expect(dump).not.toContain('ТАЙНА-РЕПЛИКА');
    expect(dump).not.toContain(w.task.id);
  });

  it('лента событий агенту спрятанного дела не отдаёт, но курсор не застревает', async () => {
    const w = await hidden();
    // Горизонт видимости событий общий на весь кластер: транзакции соседнего прогона держат его.
    await waitForEvents(w.orgId);
    const seen = await inOrg(w.orgId, (db) => readEvents(db, null, { limit: 1000 }));
    const dump = JSON.stringify(seen.events);
    expect(dump).not.toContain(w.task.id);
    expect(dump).not.toContain('ТАЙНА-РЕПЛИКА');
    // Хозяин ту же ленту видит целиком: правило про видимость, а не про потерю событий.
    const mine = await inOrg(w.orgId, (db) => readEvents(db, null, { limit: 1000 }), w.ownerId);
    expect(JSON.stringify(mine.events)).toContain(w.task.id);
  });

  it('закрыть проект нельзя, пока в нём есть дело, которое ведут другие', async () => {
    const { orgId, ownerId } = await makeOrg();
    const mate = await addPerson(orgId, 'admin');
    const open = await inOrg(orgId, (db) => createProject(db, { name: `Общее ${uniq()}` }, human(ownerId)), ownerId);
    // Дело владельца, но поставил его коллега — после закрытия он потерял бы своё же поручение.
    await inOrg(orgId, (db) => createTask(db, {
      ...base, title: 'поручение коллеги', assigneeUserId: ownerId, project: open.id,
    }, human(mate), MON_10), mate);

    expect(await codeOf(inOrg(orgId, (db) => updateProject(db, open.id, { private: true }, human(ownerId)), ownerId)))
      .toBe('validation_failed');
  });
});

describe('фоновые задания и закрытые проекты (миграция 009)', () => {
  it('дело закрытого проекта компании не выпадает из автоматики: выпуск по сроку срабатывает', async () => {
    const { orgId, ownerId } = await makeOrg();
    const secret = await inOrg(orgId, (db) => createProject(db, { name: `Своё ${uniq()}`, private: true }, human(ownerId)), ownerId);
    const later = new Date(MON_10.getTime() + 3 * 3600000);
    const task = await inOrg(orgId, (db) => createTask(db, {
      ...base, title: 'закрытое дело', assigneeUserId: ownerId, project: secret.id,
      activateAt: later.toISOString(), release: true,
    }, human(ownerId), MON_10), ownerId);
    expect(task.status).toBe('scheduled');

    // Тик воркера идёт без действующего лица: раньше дело в закрытом проекте он просто не видел.
    // Своя организация, а не вся база (runTick): обход сотен организаций прогона не укладывался
    // в таймаут теста.
    await tickOrg(orgId, later);

    const status = await inOrg(orgId, (db) => db.query('select status from tasks where id = $1', [task.id]), ownerId);
    // Вышло по сроку и встало в «Сейчас» — вся цепочка автоматики достала закрытое дело.
    expect(status.rows[0].status).not.toBe('scheduled');
    expect(['ready', 'active']).toContain(status.rows[0].status);
  });

  it('вывод человека из организации убирает его закрытые дела, а не оставляет невидимыми', async () => {
    const { orgId, ownerId } = await makeOrg();
    const worker = await addPerson(orgId);
    const secret = await inOrg(orgId, (db) => createProject(db, { name: `Своё ${uniq()}`, private: true }, human(worker)), worker);
    const task = await inOrg(orgId, (db) => createTask(db, {
      ...base, title: 'закрытое дело сотрудника', assigneeUserId: worker, project: secret.id,
    }, human(worker), MON_10), worker);

    await inOrg(orgId, (db) => offboardPerson(db, worker, human(ownerId), MON_10), ownerId);

    const left = await withOrgBackground(orgId, (db) => db.query('select 1 from tasks where id = $1', [task.id]));
    expect(left.rowCount).toBe(0);
    const projects = await withOrgBackground(orgId, (db) => db.query('select 1 from projects where id = $1', [secret.id]));
    expect(projects.rowCount).toBe(0);
  });

  it('фоновая сессия снимает приватность, но не границу организаций', async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    const secret = await inOrg(a.orgId, (db) => createProject(db, { name: `Своё ${uniq()}`, private: true }, human(a.ownerId)), a.ownerId);
    const task = await inOrg(a.orgId, (db) => createTask(db, {
      ...base, title: 'закрытое дело', assigneeUserId: a.ownerId, project: secret.id,
    }, human(a.ownerId), MON_10), a.ownerId);

    // Фоновая сессия чужой организации его не достаёт: снимается приватность, не изоляция.
    const foreign = await withOrgBackground(b.orgId, (db) => db.query('select 1 from tasks where id = $1', [task.id]));
    expect(foreign.rowCount).toBe(0);
    const own = await withOrgBackground(a.orgId, (db) => db.query('select 1 from tasks where id = $1', [task.id]));
    expect(own.rowCount).toBe(1);
  });
});
