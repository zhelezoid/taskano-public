import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closePools, withGlobal } from '../src/db/pool.js';
import { setLlmForTests, type LlmArgs } from '../src/ai/llm.js';
import { miniappRoutes } from '../src/web/miniapp-api.js';
import { createTask, updateTask } from '../src/core/tasks.js';
import { transition } from '../src/core/lifecycle.js';
import { requestDue, setDueDate } from '../src/core/due.js';
import { AppError } from '../src/core/errors.js';
import { localDate } from '../src/core/calendar.js';
import { runTaskTimers } from '../src/worker/timers.js';
import { analyzeGroup } from '../src/groups/analyze.js';
import { mayNameDueInChat, mentionsDate, mentionsTask } from '../src/groups/chat-due.js';
import { logger } from '../src/log.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { notificationText, type NotifRow } from '../src/bot/notif-text.js';
import { NOTIFICATION_KINDS } from '../src/core/notification-kinds.js';
import { t } from '../src/i18n/index.js';
import { addPerson, inOrg, makeAgent, makeOrg, minutes, MON_10 } from './helpers.js';

// Спека self-set-due, машинные пункты Acceptance: срок ставит и исполнитель (календарь в Mini App),
// просьба назвать срок с эскалацией, срок из обсуждения в рабочем чате. Модель разбора групп подменена.

afterAll(async () => {
  setLlmForTests(undefined);
  await closePools();
});

const BOT_TOKEN = 'test-bot-token-self-due';
const app = express();
miniappRoutes(app, { botToken: BOT_TOKEN });
const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };

let tgSeq = 970000000;
const nextTg = (): number => (tgSeq += 1);

function initDataFor(telegramUserId: number): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: telegramUserId, first_name: 'Test' }),
  });
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

async function linkTelegram(userId: string): Promise<number> {
  const tg = nextTg();
  await withGlobal((db) => db.query(`insert into telegram_links(user_id, telegram_user_id, chat_id) values ($1, $2, $2)`, [userId, tg]));
  return tg;
}

const post = (tg: number, url: string, body: unknown) => request(app).post(url).set('X-Telegram-Init-Data', initDataFor(tg)).send(body as object);
const get = (tg: number, url: string) => request(app).get(url).set('X-Telegram-Init-Data', initDataFor(tg));

/** Дата через `days` дней от сегодняшнего дня по Стамбулу (пояс тестовых людей). */
function inDays(days: number, from: Date = new Date()): string {
  const today = localDate(from, 'Europe/Istanbul');
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

interface Scene { orgId: string; ownerId: string; person: string; outsider: string }

async function scene(): Promise<Scene> {
  const { orgId, ownerId } = await makeOrg();
  return { orgId, ownerId, person: await addPerson(orgId, 'member'), outsider: await addPerson(orgId, 'member') };
}

async function ownerTask(s: Scene, title: string, now?: Date): Promise<string> {
  const task = await inOrg(s.orgId, (db) => createTask(db, { ...base, title, assigneeUserId: s.person }, { kind: 'user', userId: s.ownerId }, now), s.ownerId);
  return task.id;
}

async function row(s: Scene, taskId: string): Promise<{ status: string; due_date: string; due_assumed: boolean; version: number }> {
  return inOrg(s.orgId, async (db) => (await db.query('select status, due_date, due_assumed, version from tasks where id = $1', [taskId])).rows[0]);
}

async function notifs(s: Scene, kind: string, userId: string, taskId: string): Promise<{ level: string; payload: Record<string, unknown> }[]> {
  return inOrg(s.orgId, async (db) => (await db.query(
    'select level, payload from notifications where kind = $1 and user_id = $2 and task_id = $3', [kind, userId, taskId])).rows);
}

async function events(s: Scene, type: string, taskId: string): Promise<{ data: Record<string, unknown>; actor_user_id: string | null }[]> {
  return inOrg(s.orgId, async (db) => (await db.query('select data, actor_user_id from events where type = $1 and task_id = $2 order by id', [type, taskId])).rows);
}

describe('срок ставит исполнитель (Mini App)', () => {
  it('исполнитель ставит срок: срок новый, статус тот же, due_assumed снят, событие due_set, автору — due_set', async () => {
    const s = await scene();
    const tg = await linkTelegram(s.person);
    const taskId = await ownerTask(s, 'сверить остатки');
    await inOrg(s.orgId, (db) => db.query('update tasks set due_assumed = true where id = $1', [taskId]));
    const before = await row(s, taskId);
    const date = inDays(10);

    const card = await get(tg, `/app/api/tasks/${taskId}`);
    expect(card.status).toBe(200);
    expect(card.body.task.can_set_due).toBe(true);
    expect(card.body.task.can_request_due).toBe(false);

    const r = await post(tg, `/app/api/tasks/${taskId}/due`, { date, version: before.version });
    expect(r.status).toBe(200);
    // Ответ — карточка целиком: приложение перерисовывает её, не перезапрашивая.
    expect(r.body.task.due_date).toBe(date);
    expect(r.body.actions).toBeDefined();

    const after = await row(s, taskId);
    expect(after).toMatchObject({ due_date: date, status: before.status, due_assumed: false });
    const ev = await events(s, 'due_set', taskId);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data).toMatchObject({ from: '2026-12-31', to: date, by_user_id: s.person, source: 'app' });
    expect(await notifs(s, 'due_set', s.ownerId, taskId)).toHaveLength(1);
    // Сам себе — никому: исполнителю о его же сроке не пишем.
    expect(await notifs(s, 'task_updated', s.person, taskId)).toHaveLength(0);

    // Тот же срок ещё раз — ничего не происходит.
    const again = await post(tg, `/app/api/tasks/${taskId}/due`, { date });
    expect(again.status).toBe(200);
    expect(await events(s, 'due_set', taskId)).toHaveLength(1);
  });

  it('посторонний — 404; дата в прошлом — 400; закрытое дело — отказ', async () => {
    const s = await scene();
    const tgPerson = await linkTelegram(s.person);
    const tgOutsider = await linkTelegram(s.outsider);
    const taskId = await ownerTask(s, 'подготовить счёт');

    const foreign = await post(tgOutsider, `/app/api/tasks/${taskId}/due`, { date: inDays(5) });
    expect(foreign.status).toBe(404);

    const past = await post(tgPerson, `/app/api/tasks/${taskId}/due`, { date: inDays(-1) });
    expect(past.status).toBe(400);
    expect(past.body.code).toBe('validation_failed');
    expect((await row(s, taskId)).due_date).toBe('2026-12-31');

    await inOrg(s.orgId, async (db) => {
      await transition(db, taskId, 'submit', { kind: 'user', userId: s.person });
      await transition(db, taskId, 'accept', { kind: 'user', userId: s.ownerId });
    });
    const closed = await post(tgPerson, `/app/api/tasks/${taskId}/due`, { date: inDays(5) });
    expect(closed.status).toBe(400);
    expect(closed.body.code).toBe('validation_failed');
  });

  it('автор ставит срок — исполнителю task_updated; отложенное дело остаётся отложенным', async () => {
    const s = await scene();
    const taskId = await ownerTask(s, 'обзвонить поставщиков');
    await inOrg(s.orgId, (db) => setDueDate(db, { taskId, date: inDays(9), actor: { kind: 'user', userId: s.ownerId }, source: 'mcp' }));
    expect(await notifs(s, 'task_updated', s.person, taskId)).toHaveLength(1);
    expect(await notifs(s, 'due_set', s.ownerId, taskId)).toHaveLength(0);

    await inOrg(s.orgId, (db) => transition(db, taskId, 'postpone', { kind: 'user', userId: s.person }, { postponeTo: inDays(20) }));
    const activateAt = await inOrg(s.orgId, async (db) => (await db.query('select activate_at from tasks where id = $1', [taskId])).rows[0].activate_at);
    await inOrg(s.orgId, (db) => setDueDate(db, { taskId, date: inDays(25), actor: { kind: 'user', userId: s.person }, source: 'app' }));
    const after = await inOrg(s.orgId, async (db) => (await db.query('select status, due_date, activate_at from tasks where id = $1', [taskId])).rows[0]);
    expect(after).toMatchObject({ status: 'scheduled', due_date: inDays(25) });
    expect(new Date(after.activate_at).getTime()).toBe(new Date(activateAt).getTime());
  });

  it('update_task: исполнитель меняет только срок, остальное — нет', async () => {
    const s = await scene();
    const taskId = await ownerTask(s, 'разобрать возвраты');
    const person = { kind: 'user' as const, userId: s.person };
    await inOrg(s.orgId, (db) => updateTask(db, taskId, { dueDate: inDays(7) }, person));
    expect((await row(s, taskId)).due_date).toBe(inDays(7));
    await expect(inOrg(s.orgId, (db) => updateTask(db, taskId, { dueDate: inDays(8), title: 'другое' }, person)))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(inOrg(s.orgId, (db) => updateTask(db, taskId, { title: 'другое' }, person))).rejects.toBeInstanceOf(AppError);
  });
});

describe('просьба назвать срок', () => {
  it('requestDue → реплика due_request и уведомление исполнителю; срок от исполнителя гасит просьбу', async () => {
    const s = await scene();
    const tgOwner = await linkTelegram(s.ownerId);
    const tgPerson = await linkTelegram(s.person);
    const taskId = await ownerTask(s, 'собрать заявки');

    // Владелец просит из приложения; вторая просьба — та же самая.
    const asked = await post(tgOwner, `/app/api/tasks/${taskId}/due-request`, {});
    expect(asked.status).toBe(200);
    expect(asked.body.task.due_request).toMatchObject({ to_me: false });
    const again = await inOrg(s.orgId, (db) => requestDue(db, { taskId, actor: { kind: 'user', userId: s.ownerId } }));
    expect(again.created).toBe(false);

    const msgs = await inOrg(s.orgId, async (db) => (await db.query(
      `select id, kind, answered_at, author_user_id from task_messages where task_id = $1 and kind = 'due_request'`, [taskId])).rows);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ author_user_id: s.ownerId, answered_at: null });
    expect(await notifs(s, 'due_request', s.person, taskId)).toHaveLength(1);

    // Исполнитель видит просьбу в карточке и точку «новое» в списке.
    const card = await get(tgPerson, `/app/api/tasks/${taskId}`);
    expect(card.body.task.due_request).toMatchObject({ to_me: true });
    expect(card.body.task.due_request.by_name).not.toBe('');

    // Посторонний просить не может.
    await expect(inOrg(s.orgId, (db) => requestDue(db, { taskId, actor: { kind: 'user', userId: s.outsider } })))
      .rejects.toMatchObject({ code: 'not_found' });

    const set = await post(tgPerson, `/app/api/tasks/${taskId}/due`, { date: inDays(6) });
    expect(set.status).toBe(200);
    expect(set.body.task.due_request).toBeNull();
    const answered = await inOrg(s.orgId, async (db) => (await db.query(
      `select answered_at from task_messages where id = $1`, [msgs[0].id])).rows[0].answered_at);
    expect(answered).not.toBeNull();
  });

  it('перенос в боте исполнителем тоже ответ на просьбу', async () => {
    const s = await scene();
    const taskId = await ownerTask(s, 'проверить договор');
    await inOrg(s.orgId, (db) => requestDue(db, { taskId, actor: { kind: 'user', userId: s.ownerId } }));
    await inOrg(s.orgId, (db) => transition(db, taskId, 'postpone', { kind: 'user', userId: s.person }, { postponeTo: inDays(3) }));
    const open = await inOrg(s.orgId, async (db) => (await db.query(
      `select 1 from task_messages where task_id = $1 and kind = 'due_request' and answered_at is null`, [taskId])).rowCount);
    expect(open).toBe(0);
  });

  it('без ответа: 1 рабочий день — одно напоминание исполнителю, 2 — одно due_request_ignored просившему', async () => {
    const s = await scene();
    const taskId = await ownerTask(s, 'согласовать смету', MON_10);
    await inOrg(s.orgId, (db) => requestDue(db, { taskId, actor: { kind: 'user', userId: s.ownerId }, now: MON_10 }));
    const tick = (at: Date) => inOrg(s.orgId, (db) => runTaskTimers(db, at));

    await tick(minutes(MON_10, 7 * 60));                          // пн 17:00 — меньше рабочего дня
    expect(await notifs(s, 'due_request_reminder', s.person, taskId)).toHaveLength(0);

    const tue = minutes(MON_10, 24 * 60 + 5);                     // вт 10:05 — рабочий день прошёл
    await tick(tue);
    await tick(minutes(tue, 60));
    expect(await notifs(s, 'due_request_reminder', s.person, taskId)).toHaveLength(1);
    expect(await notifs(s, 'due_request_ignored', s.ownerId, taskId)).toHaveLength(0);

    const wed = minutes(MON_10, 48 * 60 + 5);                     // ср 10:05 — два рабочих дня
    await tick(wed);
    await tick(minutes(wed, 60));
    await tick(minutes(wed, 24 * 60));
    expect(await notifs(s, 'due_request_reminder', s.person, taskId)).toHaveLength(1);
    expect(await notifs(s, 'due_request_ignored', s.ownerId, taskId)).toHaveLength(1);
  });

  it('просьба агента без ответа: событие в сводку и «Решение» владельцу агента — по одному', async () => {
    const s = await scene();
    const agentId = await makeAgent(s.orgId, s.ownerId);
    const actor = { kind: 'agent' as const, agentId, userId: s.ownerId };
    const task = await inOrg(s.orgId, (db) => createTask(db, { ...base, title: 'закрыть квартал', assigneeUserId: s.person }, actor, MON_10));
    await inOrg(s.orgId, (db) => requestDue(db, { taskId: task.id, actor, text: 'нужно для плана', now: MON_10 }));
    const wed = minutes(MON_10, 48 * 60 + 5);
    await inOrg(s.orgId, (db) => runTaskTimers(db, wed));
    await inOrg(s.orgId, (db) => runTaskTimers(db, minutes(wed, 30)));
    expect(await events(s, 'due_request_ignored', task.id)).toHaveLength(1);
    const n = await notifs(s, 'due_request_ignored', s.ownerId, task.id);
    expect(n).toHaveLength(1);
    expect(n[0]!.level).toBe('decision');
  });

  it('MCP: request_due и due_request в get_task и find_task', async () => {
    const s = await scene();
    const taskId = await ownerTask(s, 'уникальное дело для поиска просьбы');
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await buildMcpServer({ userId: s.ownerId }).connect(serverT);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(clientT);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
      return { isError: !!r.isError, data: JSON.parse(r.content[0]!.text) };
    };
    const req = await call('request_due', { org: s.orgId, task: taskId, text: 'к планёрке', idempotency_key: `rd-${taskId}` });
    expect(req.isError).toBe(false);
    expect(req.data.created).toBe(true);

    const dossier = await call('get_task', { org: s.orgId, task: taskId });
    expect(dossier.data.task.due_request.requested_at).toBeTruthy();
    expect(dossier.data.task.due_request.answered_at).toBeNull();

    const found = await call('find_task', { org: s.orgId, query: 'уникальное дело' });
    expect(found.data.tasks[0].due_request.requested_at).toBeTruthy();
  });
});

describe('срок из рабочего чата', () => {
  let llmCalls: LlmArgs[] = [];
  function mockLlm(respond: (args: LlmArgs) => unknown): void {
    llmCalls = [];
    setLlmForTests(async (args) => {
      llmCalls.push(args);
      return { text: JSON.stringify(respond(args)), inputTokens: 100, outputTokens: 10 };
    });
  }

  let chatSeq = -1_000_000_900_000;
  let msgSeq = 5000;

  async function group(s: Scene, dueFromChat: boolean): Promise<{ groupId: string; chatId: number }> {
    const chatId = chatSeq--;
    const r = await inOrg(s.orgId, (db) => db.query(
      `insert into group_chats(org_id, telegram_chat_id, title, bot_is_admin, due_from_chat)
       values (current_setting('app.org_id')::uuid, $1, 'Склад', true, $2) returning id`, [chatId, dueFromChat]));
    return { groupId: r.rows[0].id as string, chatId };
  }

  async function say(s: Scene, groupId: string, author: string, text: string, sentAt: Date, replyTo: number | null = null): Promise<number> {
    const messageId = msgSeq++;
    await inOrg(s.orgId, (db) => db.query(
      `insert into group_messages(org_id, group_id, telegram_message_id, author_user_id, text, sent_at, expires_at, reply_to)
       values (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $5::timestamptz + interval '30 days', $6)`,
      [groupId, messageId, author, text, sentAt, replyTo]));
    return messageId;
  }

  async function shortId(s: Scene, taskId: string): Promise<number> {
    return inOrg(s.orgId, async (db) => Number((await db.query('select short_id from tasks where id = $1', [taskId])).rows[0].short_id));
  }

  /** Модель привязывает каждое сообщение к задаче и называет срок из списка `dues` по порядку. */
  function answerWithDues(task: number, dues: (string | null)[]): void {
    mockLlm(() => ({
      messages: dues.map((due, i) => ({ ref: `m${i + 1}`, task, confidence: 0.9, kind: 'progress', summary: 'срок', due_date: due })),
      images: [], new_tasks: [],
    }));
  }

  it('due_from_chat=true: «сделаю к …» исполнителя ставит срок и пишет источник с id и временем сообщения; последний срок пачки выигрывает', async () => {
    const s = await scene();
    const taskId = await ownerTask(s, 'отгрузить заказ', MON_10);
    const { groupId, chatId } = await group(s, true);
    await say(s, groupId, s.person, 'сделаю к 5 октября', MON_10);
    const last = await say(s, groupId, s.person, 'нет, давайте к 2 октября', minutes(MON_10, 5));
    answerWithDues(await shortId(s, taskId), ['2026-10-05', '2026-10-02']);

    const res = await analyzeGroup(s.orgId, groupId, minutes(MON_10, 10));
    expect(res.status).toBe('done');
    expect(llmCalls[0]!.system).toContain('due_date у элемента messages');

    expect((await row(s, taskId)).due_date).toBe('2026-10-02');
    const src = await inOrg(s.orgId, async (db) => (await db.query(
      `select kind, system, external_id, captured_at, quote, snapshot from task_sources where task_id = $1 and external_id is not null`, [taskId])).rows);
    expect(src).toHaveLength(1);
    expect(src[0]).toMatchObject({ kind: 'group', system: 'telegram', external_id: `${chatId}:${last}`, quote: 'нет, давайте к 2 октября' });
    expect(new Date(src[0].captured_at).getTime()).toBe(minutes(MON_10, 5).getTime());
    expect(src[0].snapshot).toMatchObject({ group_id: groupId, message_id: String(last), author_user_id: s.person, due_date: '2026-10-02' });
    const ev = await events(s, 'due_set', taskId);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.actor_user_id).toBe(s.person);
    expect(ev[0]!.data).toMatchObject({ source: 'group', group: { group_id: groupId, message_id: String(last) } });
  });

  it('due_from_chat=false: тот же ответ модели срок не меняет, и правила в промпте нет', async () => {
    const s = await scene();
    const taskId = await ownerTask(s, 'отгрузить второй заказ', MON_10);
    const { groupId } = await group(s, false);
    await say(s, groupId, s.person, 'сделаю к 2 октября', MON_10);
    answerWithDues(await shortId(s, taskId), ['2026-10-02']);
    await analyzeGroup(s.orgId, groupId, minutes(MON_10, 10));
    expect(llmCalls[0]!.system).not.toContain('due_date у элемента messages');
    expect((await row(s, taskId)).due_date).toBe('2026-12-31');
  });

  it('update_group включает due_from_chat, list_groups его отдаёт; рядовому участнику нельзя', async () => {
    const s = await scene();
    const { groupId } = await group(s, false);
    const client = async (userId: string) => {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await buildMcpServer({ userId }).connect(serverT);
      const c = new Client({ name: 'test', version: '1' });
      await c.connect(clientT);
      return c;
    };
    const owner = await client(s.ownerId);
    const member = await client(s.person);
    const denied = await member.callTool({ name: 'update_group', arguments: { org: s.orgId, group: groupId, due_from_chat: true } }) as { isError?: boolean };
    expect(denied.isError).toBe(true);
    const on = await owner.callTool({ name: 'update_group', arguments: { org: s.orgId, group: groupId, due_from_chat: true } }) as { content: { text: string }[] };
    expect(JSON.parse(on.content[0]!.text)).toMatchObject({ status: 'active', due_from_chat: true });
    const list = await owner.callTool({ name: 'list_groups', arguments: { org: s.orgId } }) as { content: { text: string }[] };
    expect(JSON.parse(list.content[0]!.text).groups[0]).toMatchObject({ id: groupId, due_from_chat: true });
  });

  it('сообщение постороннего участника группы срок не меняет', async () => {
    const s = await scene();
    const taskId = await ownerTask(s, 'отгрузить третий заказ', MON_10);
    const { groupId } = await group(s, true);
    await say(s, groupId, s.outsider, 'Ахмет сделает к 2 октября', MON_10);
    answerWithDues(await shortId(s, taskId), ['2026-10-02']);
    await analyzeGroup(s.orgId, groupId, minutes(MON_10, 10));
    expect((await row(s, taskId)).due_date).toBe('2026-12-31');
    expect(await events(s, 'due_set', taskId)).toHaveLength(0);
  });

  // ---- ревью: подложенный срок, совпадающая дата, граница гашения, источник у двух дел, журнал

  it('в тексте нет даты — срок из ответа модели не ставится', async () => {
    const s = await scene();
    const taskId = await ownerTask(s, 'разобрать полку', MON_10);
    const { groupId } = await group(s, true);
    await say(s, groupId, s.person, 'ок, займусь', MON_10);
    answerWithDues(await shortId(s, taskId), ['2026-10-02']);
    await analyzeGroup(s.orgId, groupId, minutes(MON_10, 10));
    expect((await row(s, taskId)).due_date).toBe('2026-12-31');
  });

  it('owner/admin не автор и не исполнитель: без упоминания дела срок не ставится; с #номером или ответом на сообщение дела — ставится', async () => {
    const s = await scene();
    const admin = await addPerson(s.orgId, 'admin');
    const { groupId } = await group(s, true);

    const plain = await ownerTask(s, 'дело без упоминания', MON_10);
    await say(s, groupId, admin, 'сделаем к 2 октября', MON_10);
    answerWithDues(await shortId(s, plain), ['2026-10-02']);
    await analyzeGroup(s.orgId, groupId, minutes(MON_10, 10));
    expect((await row(s, plain)).due_date).toBe('2026-12-31');

    const tagged = await ownerTask(s, 'дело с номером', MON_10);
    const n = await shortId(s, tagged);
    await say(s, groupId, admin, `#${n} сделаем к 3 октября`, minutes(MON_10, 20));
    answerWithDues(n, ['2026-10-03']);
    await analyzeGroup(s.orgId, groupId, minutes(MON_10, 30));
    expect((await row(s, tagged)).due_date).toBe('2026-10-03');

    // Ответ на сообщение, уже привязанное к делу (привязка — тем же разбором, первым элементом).
    const replied = await ownerTask(s, 'дело из ответа', MON_10);
    const r = await shortId(s, replied);
    const first = await say(s, groupId, s.person, 'начал разбирать', minutes(MON_10, 40));
    await say(s, groupId, admin, 'давай к 4 октября', minutes(MON_10, 41), first);
    answerWithDues(r, [null, '2026-10-04']);
    await analyzeGroup(s.orgId, groupId, minutes(MON_10, 50));
    expect((await row(s, replied)).due_date).toBe('2026-10-04');
  });

  it('срок по сообщению исполнителя — ему glance «Срок записан по вашему сообщению в «чат»»', async () => {
    const s = await scene();
    const taskId = await ownerTask(s, 'посчитать остатки', MON_10);
    const { groupId } = await group(s, true);
    await say(s, groupId, s.person, 'сделаю к 2 октября', MON_10);
    answerWithDues(await shortId(s, taskId), ['2026-10-02']);
    await analyzeGroup(s.orgId, groupId, minutes(MON_10, 10));
    const n = await notifs(s, 'due_set_from_chat', s.person, taskId);
    expect(n).toHaveLength(1);
    expect(n[0]!.level).toBe('glance');
    const text = await inOrg(s.orgId, async (db) => notificationText(db, 'ru', {
      id: 'x', kind: 'due_set_from_chat', level: 'glance', task_id: taskId, payload: n[0]!.payload, created_at: MON_10,
    }, s.person));
    expect(text).toContain('Срок записан по вашему сообщению в «Склад»');
  });

  it('та же дата из чата: источник пишется, просьба гаснет, события due_set нет', async () => {
    const s = await scene();
    const taskId = await ownerTask(s, 'отправить образцы', MON_10);
    await inOrg(s.orgId, (db) => setDueDate(db, { taskId, date: '2026-10-02', actor: { kind: 'user', userId: s.ownerId }, now: MON_10 }));
    await inOrg(s.orgId, (db) => requestDue(db, { taskId, actor: { kind: 'user', userId: s.ownerId }, now: minutes(MON_10, 1) }));
    const { groupId } = await group(s, true);
    await say(s, groupId, s.person, 'подтверждаю: к 2 октября', minutes(MON_10, 5));
    answerWithDues(await shortId(s, taskId), ['2026-10-02']);
    await analyzeGroup(s.orgId, groupId, minutes(MON_10, 10));
    const srcs = await inOrg(s.orgId, async (db) => (await db.query(`select 1 from task_sources where task_id = $1 and system = 'telegram'`, [taskId])).rowCount);
    expect(srcs).toBe(1);
    const open = await inOrg(s.orgId, async (db) => (await db.query(
      `select 1 from task_messages where task_id = $1 and kind = 'due_request' and answered_at is null`, [taskId])).rowCount);
    expect(open).toBe(0);
    expect((await events(s, 'due_set', taskId)).filter((e) => e.data.source === 'group')).toHaveLength(0);
  });

  it('просьба, заданная после сообщения, этим сообщением не гасится', async () => {
    const s = await scene();
    const taskId = await ownerTask(s, 'сверить накладные', MON_10);
    const { groupId } = await group(s, true);
    await say(s, groupId, s.person, 'сделаю к 2 октября', minutes(MON_10, 5));
    await inOrg(s.orgId, (db) => requestDue(db, { taskId, actor: { kind: 'user', userId: s.ownerId }, now: minutes(MON_10, 7) }));
    answerWithDues(await shortId(s, taskId), ['2026-10-02']);
    await analyzeGroup(s.orgId, groupId, minutes(MON_10, 10));
    expect((await row(s, taskId)).due_date).toBe('2026-10-02');
    const open = await inOrg(s.orgId, async (db) => (await db.query(
      `select 1 from task_messages where task_id = $1 and kind = 'due_request' and answered_at is null`, [taskId])).rowCount);
    expect(open).toBe(1);
  });

  it('одно сообщение со сроками двух дел — источник у обоих', async () => {
    const s = await scene();
    const a = await ownerTask(s, 'первое дело', MON_10);
    const b = await ownerTask(s, 'второе дело', MON_10);
    const { groupId, chatId } = await group(s, true);
    const m = await say(s, groupId, s.person, 'оба сделаю к 2 октября', MON_10);
    const [na, nb] = [await shortId(s, a), await shortId(s, b)];
    mockLlm(() => ({
      messages: [na, nb].map((task) => ({ ref: 'm1', task, confidence: 0.9, kind: 'progress', summary: 'срок', due_date: '2026-10-02' })),
      images: [], new_tasks: [],
    }));
    await analyzeGroup(s.orgId, groupId, minutes(MON_10, 10));
    for (const id of [a, b]) {
      expect((await row(s, id)).due_date).toBe('2026-10-02');
      const src = await inOrg(s.orgId, async (db) => (await db.query(
        `select external_id from task_sources where task_id = $1 and system = 'telegram'`, [id])).rows);
      expect(src).toEqual([{ external_id: `${chatId}:${m}` }]);
    }
  });

  it('ожидаемый отказ ядра — info; прочий сбой — warn с ошибкой', async () => {
    const s = await scene();
    const { groupId } = await group(s, true);
    const info = vi.spyOn(logger, 'info');
    const warn = vi.spyOn(logger, 'warn');
    try {
      // Срок в прошлом — validation_failed ядра.
      const past = await ownerTask(s, 'дело с прошлым сроком', MON_10);
      await say(s, groupId, s.person, 'сделаю к 1 сентября', MON_10);
      answerWithDues(await shortId(s, past), ['2026-09-01']);
      await analyzeGroup(s.orgId, groupId, minutes(MON_10, 10));
      expect(info.mock.calls.some((c) => c[1] === 'group analyze: срок из чата не поставлен')).toBe(true);
      expect(warn.mock.calls.some((c) => String(c[1]).startsWith('group analyze: срок из чата'))).toBe(false);

      // Предел источников дела — не отказ «нельзя», а сбой записи: в журнал предупреждением.
      const full = await ownerTask(s, 'дело с полным досье', MON_10);
      await inOrg(s.orgId, async (db) => {
        for (let i = 0; i < 50; i++) {
          await db.query(`insert into task_sources(org_id, task_id, kind, title) values (current_setting('app.org_id')::uuid, $1, 'chat', $2)`, [full, `s${i}`]);
        }
      });
      await say(s, groupId, s.person, 'сделаю к 2 октября', minutes(MON_10, 20));
      answerWithDues(await shortId(s, full), ['2026-10-02']);
      await analyzeGroup(s.orgId, groupId, minutes(MON_10, 30));
      expect(warn.mock.calls.some((c) => c[1] === 'group analyze: срок из чата не записался')).toBe(true);
      expect((await row(s, full)).due_date).toBe('2026-12-31');
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });
});

describe('кто вправе назвать срок в чате и есть ли в тексте дата (чистые проверки)', () => {
  const base3 = { author: 'a', assignee: 'x', taskAuthor: 'y', authorIsManager: false, pointsAtTask: false };
  it('исполнитель и автор — да; посторонний — нет; owner/admin — только указав на дело', () => {
    expect(mayNameDueInChat({ ...base3, author: 'x' })).toBe(true);
    expect(mayNameDueInChat({ ...base3, author: 'y' })).toBe(true);
    expect(mayNameDueInChat(base3)).toBe(false);
    expect(mayNameDueInChat({ ...base3, pointsAtTask: true })).toBe(false);
    expect(mayNameDueInChat({ ...base3, authorIsManager: true })).toBe(false);
    expect(mayNameDueInChat({ ...base3, authorIsManager: true, pointsAtTask: true })).toBe(true);
  });

  it('дата в тексте на четырёх языках', () => {
    for (const yes of ['сделаю к 5 октября', 'к пятнице', 'завтра отправлю', 'через 3 дня', 'до 10.10', 'by Friday', 'on Oct 5',
      'tomorrow', 'in two weeks', 'yarın', '5 ekim', 'cuma günü', '3 gün sonra', 'ngày mai', 'thứ sáu', 'ngày 5 tháng 10', '2026-10-05']) {
      expect(mentionsDate(yes), yes).toBe(true);
    }
    for (const no of ['ок, займусь', 'отгрузил 3 коробки', 'on it', 'tamam', 'được rồi', 'может быть']) {
      expect(mentionsDate(no), no).toBe(false);
    }
  });

  it('упоминание дела: #номер и обозначение', () => {
    expect(mentionsTask('по #42 сделаем', 42, null)).toBe(true);
    expect(mentionsTask('по #420 сделаем', 42, null)).toBe(false);
    expect(mentionsTask('NOR-7 к пятнице', 1, 'NOR-007')).toBe(true);
    expect(mentionsTask('NOR-70 к пятнице', 1, 'NOR-007')).toBe(false);
  });
});

describe('тексты новых видов', () => {
  // Та же проверка, что в test/bot-messages.test.ts («тексты без рода»), — на новых строках явно.
  const GENDERED = /(^|[^а-яё])(взял|застрял|откликнулся|ответил|отказался|закрыл|вернул|прислал|понял|заблокировал|принял|отправил|написал|сделал|сдал|начал|открыл|спросил|назвал|поставил|попросил|просил)([^а-яё]|$)|[а-яё]+(лся|лась|ла)([^а-яё]|$)/i;
  const KEYS = ['notif.due_set', 'notif.due_request', 'notif.due_request_reminder', 'notif.due_request_body', 'notif.due_request_body_plain', 'notif.due_request_ignored'];

  it('ru-строки без родовых окончаний прошедшего времени', () => {
    for (const k of KEYS) expect(t('ru', k), k).not.toMatch(GENDERED);
  });

  it('новые виды в реестре и рендерятся с именем', async () => {
    for (const k of ['due_set', 'due_request', 'due_request_reminder', 'due_request_ignored']) expect(NOTIFICATION_KINDS).toHaveProperty(k);
    const s = await scene();
    const taskId = await ownerTask(s, 'текст просьбы');
    await inOrg(s.orgId, async (db) => {
      const req = await requestDue(db, { taskId, actor: { kind: 'user', userId: s.ownerId } });
      const row: NotifRow = { id: 'x', kind: 'due_request', level: 'work', task_id: taskId, payload: { request_id: req.id }, created_at: new Date() };
      const name = (await db.query('select display_name from users where id = $1', [s.ownerId])).rows[0].display_name as string;
      const text = await notificationText(db, 'ru', row, s.person);
      expect(text).toContain(t('ru', 'notif.due_request'));
      expect(text).toContain(t('ru', 'notif.due_request_body', { name }));
    });
  });
});

describe('ревью: правка срока, дубли уведомлений, текст просьбы, адресат эскалации', () => {
  it('update_task человеком только со сроком — через setDueDate: due_set, due_assumed снят, счётчик напоминаний сброшен', async () => {
    const s = await scene();
    const taskId = await ownerTask(s, 'правка срока автором');
    await inOrg(s.orgId, (db) => db.query('update tasks set due_assumed = true, reminded_count = 2 where id = $1', [taskId]));
    await inOrg(s.orgId, (db) => updateTask(db, taskId, { dueDate: inDays(12) }, { kind: 'user', userId: s.ownerId }));
    const r = await inOrg(s.orgId, async (db) => (await db.query('select due_date, due_assumed, reminded_count from tasks where id = $1', [taskId])).rows[0]);
    expect(r).toMatchObject({ due_date: inDays(12), due_assumed: false, reminded_count: 0 });
    expect(await events(s, 'due_set', taskId)).toHaveLength(1);

    // Вместе с другими полями — прежний путь, но «срок предположен» снимается.
    await inOrg(s.orgId, (db) => db.query('update tasks set due_assumed = true where id = $1', [taskId]));
    await inOrg(s.orgId, (db) => updateTask(db, taskId, { dueDate: inDays(13), title: 'правка срока и названия' }, { kind: 'user', userId: s.ownerId }));
    expect((await row(s, taskId)).due_assumed).toBe(false);
  });

  it('исполнитель перебирает даты — автору одно уведомление в день, с последним сроком', async () => {
    const s = await scene();
    const taskId = await ownerTask(s, 'перебор дат');
    const person = { kind: 'user' as const, userId: s.person };
    await inOrg(s.orgId, (db) => setDueDate(db, { taskId, date: inDays(4), actor: person }));
    await inOrg(s.orgId, (db) => setDueDate(db, { taskId, date: inDays(5), actor: person }));
    await inOrg(s.orgId, (db) => setDueDate(db, { taskId, date: inDays(6), actor: person }));
    const n = await notifs(s, 'due_set', s.ownerId, taskId);
    expect(n).toHaveLength(1);
    expect(n[0]!.payload.to).toBe(inDays(6));
  });

  it('текст просьбы виден исполнителю: цитатой в уведомлении, в плашке карточки и в записях', async () => {
    const s = await scene();
    const tg = await linkTelegram(s.person);
    const taskId = await ownerTask(s, 'текст просьбы виден');
    await inOrg(s.orgId, (db) => requestDue(db, { taskId, actor: { kind: 'user', userId: s.ownerId }, text: 'нужно для <плана> закупок' }));
    const n = await notifs(s, 'due_request', s.person, taskId);
    const text = await inOrg(s.orgId, (db) => notificationText(db, 'ru', {
      id: 'x', kind: 'due_request', level: 'work', task_id: taskId, payload: n[0]!.payload, created_at: new Date(),
    }, s.person));
    expect(text).toContain('<blockquote>нужно для &lt;плана&gt; закупок</blockquote>');
    const card = await get(tg, `/app/api/tasks/${taskId}`);
    expect(card.body.task.due_request.text).toBe('нужно для <плана> закупок');
    expect(card.body.notes.map((x: { text: string }) => x.text)).toContain('нужно для <плана> закупок');
  });

  it('просивший ушёл из компании — о молчании узнаёт автор дела', async () => {
    const s = await scene();
    const admin = await addPerson(s.orgId, 'admin');
    const taskId = await ownerTask(s, 'эскалация автору', MON_10);
    await inOrg(s.orgId, (db) => requestDue(db, { taskId, actor: { kind: 'user', userId: admin }, now: MON_10 }));
    await withGlobal((db) => db.query(`update memberships set status = 'removed' where org_id = $1 and user_id = $2`, [s.orgId, admin]));
    await inOrg(s.orgId, (db) => runTaskTimers(db, minutes(MON_10, 48 * 60 + 5)));
    expect(await notifs(s, 'due_request_ignored', admin, taskId)).toHaveLength(0);
    expect(await notifs(s, 'due_request_ignored', s.ownerId, taskId)).toHaveLength(1);
  });

  it('MCP add_source: kind group и system telegram пишет только сервер', async () => {
    const s = await scene();
    const taskId = await ownerTask(s, 'подложенный источник');
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await buildMcpServer({ userId: s.ownerId }).connect(serverT);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(clientT);
    for (const args of [{ kind: 'group', title: 'Склад' }, { kind: 'external', title: 'чат', system: 'telegram', external_id: '-1:5' }]) {
      const r = await client.callTool({ name: 'add_source', arguments: { org: s.orgId, task: taskId, ...args } }) as { isError?: boolean; content: { text: string }[] };
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.content[0]!.text).code).toBe('validation_failed');
    }
  });
});
