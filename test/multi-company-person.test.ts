process.env.TASKANO_DISABLE_RATE_LIMIT = '1';

import { createHmac, randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { GrammyError } from 'grammy';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Update, UserFromGetMe } from 'grammy/types';
import './helpers.js';
import { closePools, withGlobal, withSystem } from '../src/db/pool.js';
import { addMember, createCompanyOrg } from '../src/core/people.js';
import { createTask } from '../src/core/tasks.js';
import { transition } from '../src/core/lifecycle.js';
import { fillSlot, takeTask } from '../src/core/queue.js';
import { ensureDefaultProject } from '../src/core/projects.js';
import { acceptPendingInvitation, offboardPerson } from '../src/core/invitations.js';
import { ensurePersonalOrg } from '../src/core/people.js';
import { showStatsHeading } from '../app/src/stats-heading.js';
import { sha256 } from '../src/core/crypto.js';
import { startTimer } from '../src/core/time.js';
import type { Task } from '../src/core/types.js';
import { runTaskTimers } from '../src/worker/timers.js';
import { buildCard } from '../src/bot/card-view.js';
import { notificationText, type NotifRow } from '../src/bot/notif-text.js';
import { createBot } from '../src/bot/bot.js';
import { deliverNotification } from '../src/bot/deliver.js';
import { dialogDb, loadWaits, pushWait } from '../src/bot/dialog.js';
import { miniappRoutes } from '../src/web/miniapp-api.js';
import { t } from '../src/i18n/index.js';
import { addPerson, inOrg, makeAgent, makeOrg, makeUser, minutes, MON_10, uniq } from './helpers.js';

// Спека multi-company-person, машинные пункты Acceptance: человек в нескольких компаниях — одна
// голова, одно «Сейчас», один счёт напоминаний; ответ в боте уходит своему делу; «Итоги» и «Компания»
// по выбранной вкладке; приглашённый пускается, и первое действие принимает приглашение.

afterAll(closePools);

const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };
const user = (userId: string) => ({ kind: 'user' as const, userId });
const agent = (agentId: string, userId: string) => ({ kind: 'agent' as const, agentId, userId });

const renameOrg = (orgId: string, name: string): Promise<unknown> =>
  withGlobal((db) => db.query('update orgs set name = $2 where id = $1', [orgId, name]));

const fresh = (orgId: string, taskId: string, asUser?: string): Promise<Task> =>
  inOrg(orgId, async (db) => (await db.query('select * from tasks where id = $1', [taskId])).rows[0] as Task, asUser);
const statusOf = async (orgId: string, taskId: string): Promise<string> => (await fresh(orgId, taskId)).status;

async function twoCompanies() {
  const a = await makeOrg();
  const b = await makeOrg();
  const nameA = `Апельсин ${uniq()}`;
  const nameB = `Гранат ${uniq()}`;
  await renameOrg(a.orgId, nameA);
  await renameOrg(b.orgId, nameB);
  const person = await addPerson(a.orgId);
  await withGlobal((db) => addMember(db, b.orgId, person, 'member'));
  return {
    orgA: a.orgId, ownerA: a.ownerId, nameA, agentA: await makeAgent(a.orgId, a.ownerId),
    orgB: b.orgId, ownerB: b.ownerId, nameB, agentB: await makeAgent(b.orgId, b.ownerId),
    person,
  };
}

/** Приглашение в компанию — строкой, как её оставляет `invite_person`; `ageDays` — давность. */
async function invite(orgId: string, ownerId: string, userId: string, opts: { status?: string; ageDays?: number } = {}): Promise<void> {
  await withGlobal((db) => addMember(db, orgId, userId, 'member', 'invited'));
  await inOrg(orgId, (db) => db.query(
    `insert into invitations(org_id, email, user_id, role, token_hash, invited_by_user_id, status, created_at)
     values ($1, $2, $3, 'member', $4, $5, $6, now() - make_interval(days => $7))`,
    [orgId, `inv-${uniq()}@test.local`, userId, sha256(randomUUID()), ownerId, opts.status ?? 'pending', opts.ageDays ?? 0]));
}

async function membershipStatus(orgId: string, userId: string): Promise<string> {
  return (await withGlobal((db) => db.query('select status from memberships where org_id = $1 and user_id = $2', [orgId, userId]))).rows[0].status;
}

async function acceptedEvents(orgId: string, userId: string): Promise<number> {
  return (await inOrg(orgId, (db) => db.query(
    `select count(*)::int as n from events where type = 'invitation_accepted' and actor_user_id = $1`, [userId]))).rows[0].n;
}

// ---------------------------------------------------------------- бот (сеть Telegram перехвачена)

const BOT_INFO: UserFromGetMe = {
  id: 10, is_bot: true, first_name: 'Taskano', username: 'taskano_test_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
  allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
};

let nextUpdateId = 1;
let nextMessageId = 1;
let nextTgId = 740_000;

interface SentCall { method: string; payload: Record<string, unknown>; messageId?: number }
let sent: SentCall[];
let bot: ReturnType<typeof createBot>;
/** Заблокировал ли человек бота: тогда Telegram отвечает 403 на любую отправку. */
let blocked = false;

beforeEach(() => {
  sent = [];
  blocked = false;
  bot = createBot({ token: 'test-token', botInfo: BOT_INFO });
  bot.api.config.use(async (_prev, method, payload) => {
    if (blocked && method === 'sendMessage') {
      throw new GrammyError('blocked', { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, method, payload);
    }
    const call: SentCall = { method, payload: payload as Record<string, unknown> };
    sent.push(call);
    const chatId = (payload as { chat_id?: number }).chat_id;
    if (method === 'sendMessage') {
      call.messageId = nextMessageId++;
      return {
        ok: true,
        result: { message_id: call.messageId, date: 0, chat: { id: chatId, type: 'private' }, text: String((payload as { text?: string }).text ?? '') },
      } as never;
    }
    return { ok: true, result: true } as never;
  });
});

type From = NonNullable<Update['message']>['from'];
const tgUser = (id: number): From => ({ id, is_bot: false, first_name: 'Person', language_code: 'ru' });

function messageUpdate(from: From, text: string, replyTo?: number): Update {
  const chat = { id: from!.id, type: 'private', first_name: 'Person' };
  const isCommand = text.startsWith('/');
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat, from, text,
      ...(isCommand ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] } : {}),
      ...(replyTo !== undefined ? { reply_to_message: { message_id: replyTo, date: 0, chat, text: 'card' } } : {}),
    },
  } as unknown as Update;
}

function callbackUpdate(from: From, data: string, messageId: number): Update {
  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: String(nextUpdateId), from, chat_instance: 'x', data,
      message: {
        message_id: messageId, date: Math.floor(Date.now() / 1000),
        chat: { id: from!.id, type: 'private', first_name: 'Person' }, text: 'card',
      },
    },
  } as unknown as Update;
}

async function linkTelegram(userId: string): Promise<{ from: From; tg: number }> {
  const tg = nextTgId++;
  await withGlobal((db) => db.query(
    `insert into telegram_links(telegram_user_id, user_id, chat_id) values ($1, $2, $3)`, [tg, userId, tg]));
  return { from: tgUser(tg), tg };
}

/** Подсказка «Ответ по делу …» с force_reply — id последней отправленной. */
const lastPromptId = (): number => sent.filter((c) => c.method === 'sendMessage'
  && (c.payload.reply_markup as { force_reply?: boolean } | undefined)?.force_reply).at(-1)!.messageId!;

const texts = (): string[] => sent.filter((s) => s.method === 'sendMessage').map((s) => String(s.payload.text ?? ''));

async function questions(orgId: string, taskId: string): Promise<string[]> {
  return (await inOrg(orgId, (db) => db.query(
    `select text from task_messages where task_id = $1 and kind = 'question' order by created_at`, [taskId]))).rows.map((r) => r.text as string);
}

// ---------------------------------------------------------------- Mini App

const BOT_TOKEN = 'test-bot-token-multi-person';
const app = express();
miniappRoutes(app, { botToken: BOT_TOKEN });

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
const appGet = (tg: number, url: string) => request(app).get(url).set('X-Telegram-Init-Data', initDataFor(tg));
const appPost = (tg: number, url: string) => request(app).post(url).set('X-Telegram-Init-Data', initDataFor(tg));

// ================================================================= «Сейчас» — одно на человека

describe('«Сейчас» — одно на человека во всех компаниях', () => {
  it('автопилот держит «Сейчас» только одно; «Взял» в Б снимает «Сейчас» в А и досчитывает его время', async () => {
    const w = await twoCompanies();
    const inA = await inOrg(w.orgA, (db) => createTask(
      db, { ...base, title: 'дело А', assigneeUserId: w.person }, agent(w.agentA, w.ownerA), MON_10));
    const inB = await inOrg(w.orgB, (db) => createTask(
      db, { ...base, title: 'дело Б', assigneeUserId: w.person }, agent(w.agentB, w.ownerB), minutes(MON_10, 1)));
    expect(inA.status).toBe('active');
    await inOrg(w.orgB, (db) => fillSlot(db, w.person, minutes(MON_10, 2)));
    expect(await statusOf(w.orgB, inB.id)).toBe('ready');

    await inOrg(w.orgA, (db) => takeTask(db, inA.id, user(w.person), { now: minutes(MON_10, 5) }));
    await inOrg(w.orgB, (db) => takeTask(db, inB.id, user(w.person), { now: minutes(MON_10, 35) }));

    expect(await statusOf(w.orgB, inB.id)).toBe('in_progress');
    const a = await fresh(w.orgA, inA.id);
    expect(a.status).toBe('ready');
    expect(a.worked_seconds).toBe(30 * 60);
    // Учёт в А остановлен, открыт только таймер дела Б.
    const open = await withSystem(async (db) => (await db.query(
      `select task_id from time_entries where user_id = $1 and ended_at is null and source = 'timer'`, [w.person])).rows);
    expect(open.map((r) => r.task_id)).toEqual([inB.id]);
  });

  it('компания, куда лишь позвали, «Сейчас» не выдаёт до принятия приглашения', async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    const person = await addPerson(a.orgId);
    await invite(b.orgId, b.ownerId, person);
    const agentB = await makeAgent(b.orgId, b.ownerId);
    const inB = await inOrg(b.orgId, (db) => createTask(
      db, { ...base, title: 'дело до принятия', assigneeUserId: person }, agent(agentB, b.ownerId), MON_10));
    // Иначе это дело стало бы вторым «Сейчас»: держателем слота дело невошедшей компании не считается.
    expect(inB.status).toBe('ready');
    const inA = await inOrg(a.orgId, (db) => createTask(
      db, { ...base, title: 'дело действующей компании', assigneeUserId: person }, user(a.ownerId), minutes(MON_10, 1)));
    expect(inA.status).toBe('active');
  });

  it('person_stuck не тикает в компании, где человек занят делом другой компании', async () => {
    const w = await twoCompanies();
    const inA = await inOrg(w.orgA, (db) => createTask(
      db, { ...base, title: 'дело А', assigneeUserId: w.person }, agent(w.agentA, w.ownerA), MON_10));
    await inOrg(w.orgA, (db) => takeTask(db, inA.id, user(w.person), { now: MON_10 }));
    const inB = await inOrg(w.orgB, (db) => createTask(
      db, { ...base, title: 'дело Б', assigneeUserId: w.person }, agent(w.agentB, w.ownerB), MON_10));
    // Два дела в работе разом — след гонки или старых данных; застрявшим человек от этого не становится.
    await inOrg(w.orgB, (db) => db.query(`update tasks set status = 'in_progress' where id = $1`, [inB.id]));

    const later = new Date('2026-09-24T08:00:00Z');   // четверг — больше двух рабочих дней спустя
    await inOrg(w.orgA, (db) => runTaskTimers(db, later));
    const stuck = () => inOrg(w.orgA, async (db) => (await db.query(
      `select count(*)::int as n from notifications where kind = 'person_stuck' and task_id = $1`, [inA.id])).rows[0].n as number);
    expect(await stuck()).toBe(0);

    await inOrg(w.orgB, (db) => db.query(`update tasks set status = 'ready' where id = $1`, [inB.id]));
    await inOrg(w.orgA, (db) => runTaskTimers(db, later));
    expect(await stuck()).toBe(1);
  });
});

describe('лимит напоминаний — на человека', () => {
  it('три в день по двум компаниям, а не шесть', async () => {
    const w = await twoCompanies();
    const ids: { orgId: string; id: string }[] = [];
    for (const [orgId, agentId, ownerId] of [[w.orgA, w.agentA, w.ownerA], [w.orgB, w.agentB, w.ownerB]] as const) {
      for (let i = 0; i < 3; i += 1) {
        const task = await inOrg(orgId, (db) => createTask(
          db, { ...base, title: `дело ${i}`, assigneeUserId: w.person, dueDate: '2026-09-21' }, agent(agentId, ownerId), MON_10));
        ids.push({ orgId, id: task.id });
      }
    }
    await inOrg(ids[0]!.orgId, (db) => transition(db, ids[0]!.id, 'take', user(w.person), { now: MON_10 }));
    const dayAfter = new Date('2026-09-22T07:00:00Z');
    for (const orgId of [w.orgA, w.orgB]) await inOrg(orgId, (db) => runTaskTimers(db, dayAfter));
    let reminders = 0;
    for (const orgId of [w.orgA, w.orgB]) {
      reminders += (await inOrg(orgId, (db) => db.query(
        `select count(*)::int as n from notifications where user_id = $1 and kind = 'reminder'`, [w.person]))).rows[0].n as number;
    }
    expect(reminders).toBe(3);
  });
});

// ================================================================= диалог бота — по делу (п.1)

describe('ответ в боте уходит в своё дело', () => {
  async function twoQuestions() {
    const w = await twoCompanies();
    const { from } = await linkTelegram(w.person);
    const inA = await inOrg(w.orgA, (db) => createTask(
      db, { ...base, title: 'свериться с поставщиком', assigneeUserId: w.person }, agent(w.agentA, w.ownerA), MON_10));
    const inB = await inOrg(w.orgB, (db) => createTask(
      db, { ...base, title: 'подготовить отчёт', assigneeUserId: w.person }, agent(w.agentB, w.ownerB), MON_10));
    const cardA = 5101;
    const cardB = 5202;
    await bot.handleUpdate(callbackUpdate(from, `a:q:${inA.short_id}:${inA.version}`, cardA));
    const b = await fresh(w.orgB, inB.id);
    await bot.handleUpdate(callbackUpdate(from, `a:q:${b.short_id}:${b.version}`, cardB));
    return { ...w, from, inA, inB, cardA, cardB };
  }

  it('«Вопрос» на А, «Вопрос» на Б, ответ reply на карточку А — реплика в А, Б по-прежнему ждёт', async () => {
    const w = await twoQuestions();

    await bot.handleUpdate(messageUpdate(w.from, 'до какого числа сверять?', w.cardA));

    expect(await questions(w.orgA, w.inA.id)).toEqual(['до какого числа сверять?']);
    expect(await questions(w.orgB, w.inB.id)).toEqual([]);
    // Второе нажатие ничего не отменило: ответ по Б — следующим сообщением, уже без вопроса «К какому?».
    await bot.handleUpdate(messageUpdate(w.from, 'в каком формате отчёт?'));
    expect(await questions(w.orgB, w.inB.id)).toEqual(['в каком формате отчёт?']);
  });

  it('без reply при нажатиях в двух делах бот переспрашивает, а не угадывает', async () => {
    const w = await twoQuestions();

    await bot.handleUpdate(messageUpdate(w.from, 'а где лежит таблица?'));

    // Ни одному делу ничего не записано — сообщение ждёт выбора.
    expect(await questions(w.orgA, w.inA.id)).toEqual([]);
    expect(await questions(w.orgB, w.inB.id)).toEqual([]);
    const ask = sent.filter((s) => s.method === 'sendMessage').at(-1)!;
    expect(ask.payload.text).toBe(t('ru', 'dialog.which_task'));
    const buttons = JSON.stringify(ask.payload.reply_markup);
    expect(buttons).toContain(w.inA.title);
    expect(buttons).toContain(w.inB.title);

    await bot.handleUpdate(callbackUpdate(w.from, `wq:${w.inA.short_id}`, 7777));
    expect(await questions(w.orgA, w.inA.id)).toEqual(['а где лежит таблица?']);
    expect(await questions(w.orgB, w.inB.id)).toEqual([]);
    // Повторное нажатие той же кнопки второй раз ничего не отправляет.
    await bot.handleUpdate(callbackUpdate(w.from, `wq:${w.inB.short_id}`, 7777));
    expect(await questions(w.orgB, w.inB.id)).toEqual([]);
  });

  it('нажатия в одном деле — вопроса нет, текст уходит ему', async () => {
    const w = await twoCompanies();
    const { from } = await linkTelegram(w.person);
    const task = await inOrg(w.orgA, (db) => createTask(
      db, { ...base, title: 'свериться с поставщиком', assigneeUserId: w.person }, agent(w.agentA, w.ownerA), MON_10));
    await bot.handleUpdate(callbackUpdate(from, `a:q:${task.short_id}:${task.version}`, 4444));
    await bot.handleUpdate(callbackUpdate(from, `a:q:${task.short_id}:${task.version}`, 4444));

    await bot.handleUpdate(messageUpdate(from, 'сколько позиций?'));

    expect(texts()).not.toContain(t('ru', 'dialog.which_task'));
    expect(await questions(w.orgA, task.id)).toEqual(['сколько позиций?']);
  });
});

// ================================================================= Mini App: «Итоги» и «Компания» по вкладке (п.4)

describe('«Итоги» и «Компания» — по выбранной компании', () => {
  it('/stats?org=<Б> и /company?org=<Б> отдают Б; чужую — 404', async () => {
    const w = await twoCompanies();
    await withGlobal((db) => db.query(`update memberships set role = 'admin' where org_id = $1 and user_id = $2`, [w.orgB, w.person]));
    await withGlobal((db) => db.query(`update orgs set timezone = 'Asia/Ho_Chi_Minh' where id = $1`, [w.orgB]));
    const { tg } = await linkTelegram(w.person);
    const stranger = await makeOrg();

    const stats = await appGet(tg, `/app/api/stats?period=today&org=${w.orgB}`);
    expect(stats.status).toBe(200);
    expect(stats.body).toMatchObject({ org_id: w.orgB, org_name: w.nameB, tz: 'Asia/Ho_Chi_Minh' });
    const company = await appGet(tg, `/app/api/company?org=${w.orgB}`);
    expect(company.status).toBe(200);
    expect(company.body).toMatchObject({ org_id: w.orgB, org_name: w.nameB });

    expect((await appGet(tg, `/app/api/stats?period=today&org=${stranger.orgId}`)).status).toBe(404);
    expect((await appGet(tg, `/app/api/company?org=${stranger.orgId}`)).status).toBe(404);
    // Компания, где он рядовой, — раздел «Компания» не его: тоже 404, а не чужие данные.
    expect((await appGet(tg, `/app/api/company?org=${w.orgA}`)).status).toBe(404);
  });
});

// ================================================================= приглашённый

describe('приглашённый пускается; первое действие — принятие', () => {
  async function invitedScene(opts: { status?: string; ageDays?: number } = {}) {
    const a = await makeOrg();
    const b = await makeOrg();
    const person = await addPerson(a.orgId);
    await invite(b.orgId, b.ownerId, person, opts);
    const agentB = await makeAgent(b.orgId, b.ownerId);
    const task = await inOrg(b.orgId, (db) => createTask(
      db, { ...base, title: `дело новой компании ${uniq()}`, assigneeUserId: person }, agent(agentB, b.ownerId), MON_10));
    const link = await linkTelegram(person);
    return { orgA: a.orgId, orgB: b.orgId, person, task, ...link };
  }

  it('«Взял» в боте: членство active, событие invitation_accepted, дело взято', async () => {
    const s = await invitedScene();
    // До действия дело уже видно: компания в списке, а приглашение не принято.
    await bot.handleUpdate(messageUpdate(s.from, t('ru', 'menu.list')));
    expect(texts().join('\n')).toContain(s.task.title);
    expect(await membershipStatus(s.orgB, s.person)).toBe('invited');

    await bot.handleUpdate(callbackUpdate(s.from, `a:take:${s.task.short_id}:${s.task.version}`, 6001));

    expect(await membershipStatus(s.orgB, s.person)).toBe('active');
    expect(await acceptedEvents(s.orgB, s.person)).toBe(1);
    expect(await statusOf(s.orgB, s.task.id)).toBe('in_progress');
    const inv = await inOrg(s.orgB, (db) => db.query(`select status from invitations where user_id = $1`, [s.person]));
    expect(inv.rows.map((r) => r.status)).toEqual(['accepted']);
  });

  it('«Взять» в приложении: членство active, событие invitation_accepted, дело взято; вкладка видна до того', async () => {
    const s = await invitedScene();
    const lists = await appGet(s.tg, '/app/api/lists');
    const tab = lists.body.spaces.find((sp: { org_id: string }) => sp.org_id === s.orgB);
    expect(tab).toMatchObject({ invited: true, manages: false });

    const r = await appPost(s.tg, `/app/api/tasks/${s.task.id}/take`).send({});

    expect(r.status).toBe(200);
    expect(await membershipStatus(s.orgB, s.person)).toBe('active');
    expect(await acceptedEvents(s.orgB, s.person)).toBe(1);
    expect(await statusOf(s.orgB, s.task.id)).toBe('in_progress');
  });

  it('отозванное приглашение — 404 в приложении и «не найдено» в боте, членство не трогается', async () => {
    const s = await invitedScene({ status: 'revoked' });

    expect((await appPost(s.tg, `/app/api/tasks/${s.task.id}/take`).send({})).status).toBe(404);
    expect((await appGet(s.tg, `/app/api/tasks/${s.task.id}`)).status).toBe(404);
    await bot.handleUpdate(callbackUpdate(s.from, `a:take:${s.task.short_id}:${s.task.version}`, 6002));
    expect(texts().at(-1)).toBe(t('ru', 'start.task_not_found'));

    expect(await membershipStatus(s.orgB, s.person)).toBe('invited');
    expect(await acceptedEvents(s.orgB, s.person)).toBe(0);
    expect(await statusOf(s.orgB, s.task.id)).toBe('ready');
  });

  it('истёкшее приглашение (старше 30 дней) — тоже 404', async () => {
    const s = await invitedScene({ ageDays: 31 });
    expect((await appPost(s.tg, `/app/api/tasks/${s.task.id}/take`).send({})).status).toBe(404);
    expect(await membershipStatus(s.orgB, s.person)).toBe('invited');
  });

  it('ядро не принимает чужое, отозванное и снятое выводом приглашение', async () => {
    const s = await invitedScene();
    const other = await makeUser();
    // Не его приглашение — не его и принятие.
    expect(await inOrg(s.orgB, (db) => acceptPendingInvitation(db, s.orgB, other, new Date()))).toBe(false);
    await withGlobal((db) => db.query(`update memberships set status = 'removed' where org_id = $1 and user_id = $2`, [s.orgB, s.person]));
    expect(await inOrg(s.orgB, (db) => acceptPendingInvitation(db, s.orgB, s.person, new Date()))).toBe(false);
    expect(await membershipStatus(s.orgB, s.person)).toBe('removed');
  });
});

// ================================================================= названия (п.3, п.8, п.9)

describe('компания названа', () => {
  it('ключ проекта «Разное» кириллической компании — латиница из названия, не B<n>', async () => {
    const owner = await makeUser();
    const orgId = await withGlobal((db) => createCompanyOrg(db, owner, 'Апельсин', { language: 'ru' }));
    const project = await inOrg(orgId, (db) => ensureDefaultProject(db, orgId));
    expect(project.name).toBe(t('ru', 'project.default'));
    expect(project.key).toBe('RAZ');
    expect(project.key).not.toMatch(/^B\d/);
  });

  const notifRow = (orgId: string, userId: string, kind: string): Promise<NotifRow> => inOrg(orgId, async (db) =>
    (await db.query(
      `select id, kind, level, task_id, payload, created_at from notifications
        where user_id = $1 and kind = $2 order by created_at desc limit 1`, [userId, kind])).rows[0] as NotifRow);

  it('уведомление о деле человеку в двух компаниях называет компанию, в одной — нет', async () => {
    const w = await twoCompanies();
    await inOrg(w.orgB, (db) => createTask(
      db, { ...base, title: 'подготовить отчёт', assigneeUserId: w.person }, agent(w.agentB, w.ownerB), MON_10));
    const text = await inOrg(w.orgB, async (db) => notificationText(db, 'ru', await notifRow(w.orgB, w.person, 'task_now'), w.person));
    expect(text).toContain(w.nameB);

    const solo = await makeOrg();
    const name = `Единственная ${uniq()}`;
    await renameOrg(solo.orgId, name);
    const alone = await addPerson(solo.orgId);
    await inOrg(solo.orgId, (db) => createTask(
      db, { ...base, title: 'позвонить в банк', assigneeUserId: alone }, user(solo.ownerId), MON_10));
    const aloneText = await inOrg(solo.orgId, async (db) => notificationText(db, 'ru', await notifRow(solo.orgId, alone, 'task_now'), alone));
    expect(aloneText).toContain('позвонить в банк');
    expect(aloneText).not.toContain(name);
  });

  it('карточка дела А говорит, что таймер идёт в «Б», а «Стоп» со старой карточки не падает', async () => {
    const w = await twoCompanies();
    const { from } = await linkTelegram(w.person);
    const inA = await inOrg(w.orgA, (db) => createTask(
      db, { ...base, title: 'дело А', assigneeUserId: w.person }, agent(w.agentA, w.ownerA), MON_10));
    const inB = await inOrg(w.orgB, (db) => createTask(
      db, { ...base, title: 'дело Б', assigneeUserId: w.person }, agent(w.agentB, w.ownerB), MON_10));
    await inOrg(w.orgB, (db) => startTimer(db, w.person, inB.id));

    const card = await inOrg(w.orgA, async (db) => buildCard(db, await fresh(w.orgA, inA.id), 'ru',
      { sourceLang: 'ru', personal: false, viewerUserId: w.person }));
    expect(card.text).toContain(t('ru', 'card.timer_elsewhere', { org: w.nameB }));

    const a = await fresh(w.orgA, inA.id);
    await bot.handleUpdate(callbackUpdate(from, `a:te:${a.short_id}:${a.version}`, 6100));
    const edited = sent.filter((s) => s.method === 'editMessageText').at(-1);
    expect(String(edited?.payload.text ?? '')).toContain(t('ru', 'card.timer_elsewhere', { org: w.nameB }));
    // Таймер в Б не тронут.
    const open = await withSystem(async (db) => (await db.query(
      `select task_id from time_entries where user_id = $1 and ended_at is null`, [w.person])).rows);
    expect(open.map((r) => r.task_id)).toEqual([inB.id]);
  });

  it('/agents у человека с двумя компаниями — у строк метка компании', async () => {
    const owner = await makeUser();
    const a = await makeOrg(owner);
    const b = await makeOrg(owner);
    const nameA = `Апельсин ${uniq()}`;
    const nameB = `Гранат ${uniq()}`;
    await renameOrg(a.orgId, nameA);
    await renameOrg(b.orgId, nameB);
    await makeAgent(a.orgId, owner, 'Операционный');
    await makeAgent(b.orgId, owner, 'Операционный');
    const { from } = await linkTelegram(owner);

    await bot.handleUpdate(messageUpdate(from, '/agents'));

    const status = t('ru', 'agents.status_active');
    expect(texts()).toContain(t('ru', 'agents.line_company', { name: 'Операционный', status, org: nameA }));
    expect(texts()).toContain(t('ru', 'agents.line_company', { name: 'Операционный', status, org: nameB }));
  });
});

// ================================================================= блокировка бота (п.7)

describe('заблокировал бота — знают владельцы всех его компаний', () => {
  it('channel_dead уходит владельцу и компании А, и компании Б', async () => {
    const w = await twoCompanies();
    await linkTelegram(w.person);
    const task = await inOrg(w.orgA, (db) => createTask(
      db, { ...base, title: 'дело А', assigneeUserId: w.person }, agent(w.agentA, w.ownerA), MON_10));
    const n = (await inOrg(w.orgA, (db) => db.query(
      `select id from notifications where user_id = $1 and task_id = $2 and kind = 'task_now'`, [w.person, task.id]))).rows[0].id as string;
    blocked = true;

    expect(await deliverNotification(w.orgA, n)).toBe('skipped');

    const dead = async (orgId: string, ownerId: string): Promise<number> => (await inOrg(orgId, (db) => db.query(
      `select count(*)::int as n from notifications where user_id = $1 and kind = 'channel_dead'`, [ownerId]))).rows[0].n as number;
    expect(await dead(w.orgA, w.ownerA)).toBe(1);
    expect(await dead(w.orgB, w.ownerB)).toBe(1);
  });
});

// ================================================================= ревью блока 2

/** Сдвинуть время нажатий (ожиданий) человека в прошлое — как будто нажимали давно. */
async function ageWaits(tg: number, minutesAgo: number): Promise<void> {
  await withGlobal(async (db) => {
    const r = await db.query(`select data from bot_dialogs where user_key = $1`, [`tg:${tg}`]);
    const data = r.rows[0].data as { _waits: { at: string }[] };
    const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    for (const w of data._waits) w.at = at;
    await db.query(`update bot_dialogs set data = $2 where user_key = $1`, [`tg:${tg}`, JSON.stringify(data)]);
  });
}

async function oneCompanyTwoTasks() {
  const { orgId, ownerId } = await makeOrg();
  const person = await addPerson(orgId);
  const agentId = await makeAgent(orgId, ownerId);
  const link = await linkTelegram(person);
  const first = await inOrg(orgId, (db) => createTask(
    db, { ...base, title: 'первое дело', assigneeUserId: person }, agent(agentId, ownerId), MON_10));
  const second = await inOrg(orgId, (db) => createTask(
    db, { ...base, title: 'второе дело', assigneeUserId: person }, agent(agentId, ownerId), MON_10));
  return { orgId, person, first, second, ...link };
}

describe('ревью: «К какому делу?» — только между компаниями; подсказка с force_reply', () => {
  it('два нажатия в одной компании: без reply — в последнее, без вопроса', async () => {
    const s = await oneCompanyTwoTasks();
    await bot.handleUpdate(callbackUpdate(s.from, `a:q:${s.first.short_id}:${s.first.version}`, 8101));
    await bot.handleUpdate(callbackUpdate(s.from, `a:q:${s.second.short_id}:${s.second.version}`, 8102));

    await bot.handleUpdate(messageUpdate(s.from, 'что приложить?'));

    expect(texts()).not.toContain(t('ru', 'dialog.which_task'));
    expect(await questions(s.orgId, s.second.id)).toEqual(['что приложить?']);
    expect(await questions(s.orgId, s.first.id)).toEqual([]);
  });

  it('две компании: подсказка уходит с force_reply, и ответ на неё попадает своему делу', async () => {
    const w = await twoCompanies();
    const { from } = await linkTelegram(w.person);
    const inA = await inOrg(w.orgA, (db) => createTask(
      db, { ...base, title: 'дело А', assigneeUserId: w.person }, agent(w.agentA, w.ownerA), MON_10));
    const inB = await inOrg(w.orgB, (db) => createTask(
      db, { ...base, title: 'дело Б', assigneeUserId: w.person }, agent(w.agentB, w.ownerB), MON_10));
    await bot.handleUpdate(callbackUpdate(from, `a:q:${inA.short_id}:${inA.version}`, 8201));
    const promptA = lastPromptId();
    const prompt = sent.find((c) => c.messageId === promptA)!;
    expect(prompt.payload.reply_markup).toMatchObject({ force_reply: true, selective: true });
    const b = await fresh(w.orgB, inB.id);
    await bot.handleUpdate(callbackUpdate(from, `a:q:${b.short_id}:${b.version}`, 8202));

    await bot.handleUpdate(messageUpdate(from, 'про А', promptA));

    expect(await questions(w.orgA, inA.id)).toEqual(['про А']);
    expect(await questions(w.orgB, inB.id)).toEqual([]);
  });

  it('одна компания: после «Вопрос» карточка остаётся, просьба — одним сообщением, без force_reply-подсказки', async () => {
    const s = await oneCompanyTwoTasks();
    await bot.handleUpdate(callbackUpdate(s.from, `a:q:${s.first.short_id}:${s.first.version}`, 8203));

    // У карточки снимаются кнопки, текст не трогаем; просьба — отдельным сообщением.
    expect(sent.map((c) => c.method)).toEqual(['editMessageReplyMarkup', 'sendMessage', 'answerCallbackQuery']);
    expect(sent[1]!.payload.text).toBe(t('ru', 'question.ask'));
    // Ответ reply на саму карточку по-прежнему уходит её делу.
    await bot.handleUpdate(messageUpdate(s.from, 'про первое', 8203));
    expect(await questions(s.orgId, s.first.id)).toEqual(['про первое']);
  });
});

describe('ревью: reply мимо ожиданий, срок жизни, давнее разрушительное нажатие', () => {
  it('reply на сообщение, которое ответа не ждёт, — подсказка, а не последнее нажатие', async () => {
    const s = await oneCompanyTwoTasks();
    await bot.handleUpdate(callbackUpdate(s.from, `a:q:${s.first.short_id}:${s.first.version}`, 8301));

    await bot.handleUpdate(messageUpdate(s.from, 'это про другое', 999_999));

    expect(texts().at(-1)).toBe(t('ru', 'dialog.not_awaited'));
    expect(await questions(s.orgId, s.first.id)).toEqual([]);
  });

  it('reply мимо при двух ожиданиях — «К какому делу?»', async () => {
    const s = await oneCompanyTwoTasks();
    await bot.handleUpdate(callbackUpdate(s.from, `a:q:${s.first.short_id}:${s.first.version}`, 8401));
    await bot.handleUpdate(callbackUpdate(s.from, `a:q:${s.second.short_id}:${s.second.version}`, 8402));

    await bot.handleUpdate(messageUpdate(s.from, 'про что-то', 999_998));

    expect(texts().at(-1)).toBe(t('ru', 'dialog.which_task'));
    expect(await questions(s.orgId, s.first.id)).toEqual([]);
    expect(await questions(s.orgId, s.second.id)).toEqual([]);
  });

  it('ожидание старше суток текст не ловит', async () => {
    const s = await oneCompanyTwoTasks();
    // Реплика дела не меняет — правило «давнее разрушительное нажатие» здесь ни при чём, решает срок жизни.
    await bot.handleUpdate(callbackUpdate(s.from, `a:cm:${s.first.short_id}:${s.first.version}`, 8501));
    await ageWaits(s.tg, 25 * 60);

    await bot.handleUpdate(messageUpdate(s.from, 'вчерашняя реплика'));

    const comments = await inOrg(s.orgId, (db) => db.query(
      `select count(*)::int as n from task_messages where task_id = $1 and kind = 'comment'`, [s.first.id]));
    expect(comments.rows[0].n).toBe(0);
    expect(texts()).not.toContain(t('ru', 'comment.sent'));
  });

  it('отказ по нажатию старше 30 минут без reply — только после подтверждения', async () => {
    const s = await oneCompanyTwoTasks();
    await bot.handleUpdate(callbackUpdate(s.from, `a:dec:${s.first.short_id}:${s.first.version}`, 8601));
    await ageWaits(s.tg, 45);

    await bot.handleUpdate(messageUpdate(s.from, 'не моё'));

    expect(await statusOf(s.orgId, s.first.id)).not.toBe('declined');
    expect(texts().at(-1)).toBe(t('ru', 'dialog.which_task'));
    await bot.handleUpdate(callbackUpdate(s.from, `wq:${s.first.short_id}`, 8602));
    expect(await statusOf(s.orgId, s.first.id)).toBe('declined');
  });
});

describe('ревью: приглашение принимает только действие работы, в его транзакции', () => {
  async function invitedScene() {
    const a = await makeOrg();
    const b = await makeOrg();
    const person = await addPerson(a.orgId);
    await invite(b.orgId, b.ownerId, person);
    const agentB = await makeAgent(b.orgId, b.ownerId);
    const task = await inOrg(b.orgId, (db) => createTask(
      db, { ...base, title: `дело новой компании ${uniq()}`, assigneeUserId: person }, agent(agentB, b.ownerId), MON_10));
    const link = await linkTelegram(person);
    return { orgB: b.orgId, person, task, ...link };
  }
  const invitationStatus = async (orgId: string, userId: string): Promise<string> => (await inOrg(orgId, (db) => db.query(
    'select status from invitations where user_id = $1', [userId]))).rows[0].status as string;

  it('нажатия без работы (оригинал, вопрос без текста, таймер, устаревшая версия) не принимают', async () => {
    const s = await invitedScene();
    await bot.handleUpdate(callbackUpdate(s.from, `a:orig:${s.task.short_id}:${s.task.version}`, 8701));
    await bot.handleUpdate(callbackUpdate(s.from, `a:q:${s.task.short_id}:${s.task.version}`, 8702));
    await bot.handleUpdate(callbackUpdate(s.from, `a:take:${s.task.short_id}:${s.task.version + 5}`, 8703));
    await bot.handleUpdate(callbackUpdate(s.from, `a:ts:${s.task.short_id}:${s.task.version}`, 8704));
    expect(texts()).toContain(t('ru', 'invite.act_first'));
    expect(await membershipStatus(s.orgB, s.person)).toBe('invited');

    // А отправленный вопрос — работа: приглашение принято, вопрос записан.
    await bot.handleUpdate(messageUpdate(s.from, 'с чего начать?', lastPromptId()));
    expect(await membershipStatus(s.orgB, s.person)).toBe('active');
    expect(await questions(s.orgB, s.task.id)).toEqual(['с чего начать?']);
  });

  it('упало действие — приглашение не принято (приложение, устаревшая версия)', async () => {
    const s = await invitedScene();
    const r = await appPost(s.tg, `/app/api/tasks/${s.task.id}/take`).send({ version: s.task.version + 7 });
    expect(r.status).toBe(409);
    expect(await membershipStatus(s.orgB, s.person)).toBe('invited');
    expect(await acceptedEvents(s.orgB, s.person)).toBe(0);
  });

  it('«Отказаться» в боте — не вход: дело отклонено, приглашение declined, членство invited', async () => {
    const s = await invitedScene();
    await bot.handleUpdate(callbackUpdate(s.from, `a:dec:${s.task.short_id}:${s.task.version}`, 8801));
    await bot.handleUpdate(messageUpdate(s.from, 'не мой профиль', lastPromptId()));

    expect(await statusOf(s.orgB, s.task.id)).toBe('declined');
    expect(await invitationStatus(s.orgB, s.person)).toBe('declined');
    expect(await membershipStatus(s.orgB, s.person)).toBe('invited');
    expect(await acceptedEvents(s.orgB, s.person)).toBe(0);
  });

  it('«Отказаться» в приложении — то же самое', async () => {
    const s = await invitedScene();
    const r = await appPost(s.tg, `/app/api/tasks/${s.task.id}/decline`).send({ text: 'не мой профиль' });
    expect(r.status).toBe(200);
    expect(await statusOf(s.orgB, s.task.id)).toBe('declined');
    expect(await invitationStatus(s.orgB, s.person)).toBe('declined');
    expect(await membershipStatus(s.orgB, s.person)).toBe('invited');
  });
});

describe('ревью: гонки в диалоге бота', () => {
  it('параллельные нажатия — все ожидания записаны, ни одно не затёрто', async () => {
    const key = `tg:${nextTgId++}`;
    const ids = ['101', '102', '103', '104', '105'];
    // Пять нажатий одновременно: без замка строки каждое читало бы пустой список и затирало соседей.
    await Promise.all(ids.map((shortId) => dialogDb((db) => pushWait(db, key, 'await_question', { shortId }))));
    const waits = await dialogDb((db) => loadWaits(db, key));
    expect(waits.map((x) => String(x.data.shortId)).sort()).toEqual(ids);
  });

  it('два быстрых выбора на «К какому делу?» — текст уходит ровно в одно дело', async () => {
    const w = await twoCompanies();
    const { from } = await linkTelegram(w.person);
    const inA = await inOrg(w.orgA, (db) => createTask(
      db, { ...base, title: 'дело А', assigneeUserId: w.person }, agent(w.agentA, w.ownerA), MON_10));
    const inB = await inOrg(w.orgB, (db) => createTask(
      db, { ...base, title: 'дело Б', assigneeUserId: w.person }, agent(w.agentB, w.ownerB), MON_10));
    await bot.handleUpdate(callbackUpdate(from, `a:q:${inA.short_id}:${inA.version}`, 9001));
    const b = await fresh(w.orgB, inB.id);
    await bot.handleUpdate(callbackUpdate(from, `a:q:${b.short_id}:${b.version}`, 9002));
    await bot.handleUpdate(messageUpdate(from, 'один текст'));
    expect(texts().at(-1)).toBe(t('ru', 'dialog.which_task'));

    await Promise.all([
      bot.handleUpdate(callbackUpdate(from, `wq:${inA.short_id}`, 9003)),
      bot.handleUpdate(callbackUpdate(from, `wq:${inB.short_id}`, 9003)),
    ]);

    const total = (await questions(w.orgA, inA.id)).length + (await questions(w.orgB, inB.id)).length;
    expect(total).toBe(1);
  });
});

describe('ревью: мелочи', () => {
  it('вывод человека отзывает его висящие приглашения', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await makeUser();
    await invite(orgId, ownerId, person);
    await inOrg(orgId, (db) => offboardPerson(db, person, user(ownerId)), ownerId);
    const r = await inOrg(orgId, (db) => db.query('select status from invitations where user_id = $1', [person]));
    expect(r.rows.map((x) => x.status)).toEqual(['revoked']);
  });

  it('таймер в личном пространстве карточка компании не называет «другой компанией»', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const personal = await withGlobal((db) => ensurePersonalOrg(db, person));
    const mine = await inOrg(personal, (db) => createTask(
      db, { ...base, title: 'личное', assigneeUserId: person }, user(person), MON_10), person);
    await inOrg(personal, (db) => startTimer(db, person, mine.id), person);
    const task = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'рабочее', assigneeUserId: person }, user(ownerId), MON_10));
    const card = await inOrg(orgId, async (db) => buildCard(db, await fresh(orgId, task.id), 'ru',
      { sourceLang: 'ru', personal: false, viewerUserId: person }));
    const prefix = t('ru', 'card.timer_elsewhere', { org: '@' }).split('@')[0]!;
    expect(card.text).not.toContain(prefix);
  });

  it('шапка «Итогов» (компания и пояс) — только при двух и больше действующих компаниях', () => {
    expect(showStatsHeading([{ kind: 'company' }, { kind: 'personal' }])).toBe(false);
    expect(showStatsHeading([{ kind: 'company' }, { kind: 'company', invited: true }])).toBe(false);
    expect(showStatsHeading([{ kind: 'company' }, { kind: 'company' }])).toBe(true);
  });
});
