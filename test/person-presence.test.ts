process.env.TASKANO_DISABLE_RATE_LIMIT = '1';

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Update, UserFromGetMe } from 'grammy/types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { addPerson, inOrg, makeAgent, makeOrg, uniq } from './helpers.js';
import { closePools, withGlobal } from '../src/db/pool.js';
import { createBot } from '../src/bot/bot.js';
import { deliverNotification } from '../src/bot/deliver.js';
import { outbox } from '../src/email/send.js';
import { INVITE_LIMITS, invitePerson, resendInvitation } from '../src/core/invitations.js';
import { createTask } from '../src/core/tasks.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { miniappRoutes } from '../src/web/miniapp-api.js';
import { invitationMail } from '../src/email/templates/invitation.js';
import { openAppMail } from '../src/email/templates/open-app.js';
import { SEEN_TRACKED_SINCE, seenPhrase } from '../src/core/presence.js';
import { localDate } from '../src/core/calendar.js';
import { seenLabel, t as appT, type SeenFacts } from '../app/src/i18n.js';
import { t } from '../src/i18n/index.js';

// Видно, заходит ли человек, и повторное приглашение ведёт туда, где он застрял (спека person-presence).

// Отказ записи отметки включается флагом: ошибка базы на этой строке не должна стоить человеку ответа.
const fail = vi.hoisted(() => ({ app: false }));
vi.mock('../src/core/presence.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/core/presence.js')>();
  return {
    ...orig,
    touchAppSeen: async (userId: string) => {
      if (fail.app) throw new Error('db is down');
      return orig.touchAppSeen(userId);
    },
  };
});

afterAll(closePools);

const BOT_INFO: UserFromGetMe = {
  id: 10, is_bot: true, first_name: 'Taskano', username: 'taskano_test_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: true, has_topics_enabled: false,
  allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
};

let nextUpdateId = 1;
let nextMessageId = 1;
let tgSeq = 930000000;
const nextTg = (): number => (tgSeq += 1);

interface SentCall { method: string; payload: Record<string, unknown> }
let sent: SentCall[];
let bot: ReturnType<typeof createBot>;

beforeEach(() => {
  sent = [];
  fail.app = false;
  bot = createBot({ token: 'test-token', botInfo: BOT_INFO });
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, unknown> });
    const chatId = (payload as { chat_id?: number }).chat_id;
    if (method === 'sendMessage') {
      return {
        ok: true,
        result: { message_id: nextMessageId++, date: 0, chat: { id: chatId, type: 'private' }, text: String((payload as { text?: string }).text ?? '') },
      } as any;
    }
    return { ok: true, result: true } as any;
  });
});

type From = NonNullable<Update['message']>['from'];
const tgUser = (id: number, lang = 'ru'): From => ({ id, is_bot: false, first_name: 'Person', language_code: lang });

function messageUpdate(from: From, text: string, chat: { id: number; type: 'private' | 'supergroup' } = { id: from!.id, type: 'private' }): Update {
  const command = /^\/([a-zA-Z0-9_]+)/.exec(text);
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextMessageId++, date: Math.floor(Date.now() / 1000),
      chat: chat.type === 'private' ? { ...chat, first_name: 'Person' } : { ...chat, title: 'Работа' },
      from, text, entities: command ? [{ type: 'bot_command', offset: 0, length: command[0].length }] : undefined,
    },
  } as unknown as Update;
}

function callbackUpdate(from: From, data: string): Update {
  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: String(nextUpdateId), from, chat_instance: 'x', data,
      message: { message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: from!.id, type: 'private', first_name: 'Person' }, text: 'card' },
    },
  } as unknown as Update;
}

async function linkTelegram(userId: string, telegramUserId: number, blocked = false): Promise<void> {
  await withGlobal((db) => db.query(
    `insert into telegram_links(telegram_user_id, user_id, chat_id, blocked_at) values ($1, $2, $1, $3)`,
    [telegramUserId, userId, blocked ? new Date() : null]));
}

async function seen(userId: string): Promise<{ bot: Date | null; app: Date | null }> {
  const r = await withGlobal((db) => db.query('select last_seen_bot_at, last_seen_app_at from users where id = $1', [userId]));
  return { bot: r.rows[0].last_seen_bot_at, app: r.rows[0].last_seen_app_at };
}

async function setSeen(userId: string, col: 'last_seen_bot_at' | 'last_seen_app_at', hoursAgo: number | null): Promise<void> {
  await withGlobal((db) => db.query(
    `update users set ${col} = case when $2::int is null then null else now() - make_interval(hours => $2::int) end where id = $1`,
    [userId, hoursAgo]));
}

async function emailOf(userId: string): Promise<string> {
  return (await withGlobal((db) => db.query('select email::text as e from user_emails where user_id = $1 and is_primary', [userId]))).rows[0].e;
}

const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };

async function tool(userId: string, name: string, args: Record<string, unknown>): Promise<any> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildMcpServer({ userId }).connect(serverT);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientT);
  const r = await client.callTool({ name, arguments: args as never });
  await client.close();
  const text = (r.content as { text: string }[])[0]!.text;
  return r.isError ? { error: JSON.parse(text) } : JSON.parse(text);
}

describe('отметка «заходил в бота»', () => {
  it('сообщение в личном чате ставит отметку; второе через минуту её не двигает', async () => {
    const { orgId } = await makeOrg();
    const person = await addPerson(orgId);
    const from = tgUser(nextTg());
    await linkTelegram(person, from!.id);
    expect((await seen(person)).bot).toBeNull();

    await bot.handleUpdate(messageUpdate(from, 'привет'));
    const first = (await seen(person)).bot;
    expect(first).toBeInstanceOf(Date);

    // «Минуту назад» — сдвигаем отметку назад, а не ждём: порог в 5 минут её защищает.
    await withGlobal((db) => db.query(`update users set last_seen_bot_at = now() - interval '1 minute' where id = $1`, [person]));
    const minuteAgo = (await seen(person)).bot!;
    await bot.handleUpdate(messageUpdate(from, 'ещё раз'));
    expect((await seen(person)).bot!.getTime()).toBe(minuteAgo.getTime());

    // Через 5 минут и больше — снова пишется.
    await withGlobal((db) => db.query(`update users set last_seen_bot_at = now() - interval '6 minutes' where id = $1`, [person]));
    await bot.handleUpdate(callbackUpdate(from, 'nothing:here'));
    expect(Date.now() - (await seen(person)).bot!.getTime()).toBeLessThan(60_000);
  });

  it('блокировка бота (my_chat_member) заходом не считается', async () => {
    const { orgId } = await makeOrg();
    const person = await addPerson(orgId);
    const from = tgUser(nextTg());
    await linkTelegram(person, from!.id);
    await bot.handleUpdate({
      update_id: nextUpdateId++,
      my_chat_member: {
        chat: { id: from!.id, type: 'private', first_name: 'Person' }, from, date: Math.floor(Date.now() / 1000),
        old_chat_member: { status: 'member', user: { id: 10, is_bot: true, first_name: 'Taskano' } },
        new_chat_member: { status: 'kicked', until_date: 0, user: { id: 10, is_bot: true, first_name: 'Taskano' } },
      },
    } as unknown as Update);
    expect((await seen(person)).bot).toBeNull();
  });

  it('сообщение в рабочей группе отметку не ставит', async () => {
    const { orgId } = await makeOrg();
    const person = await addPerson(orgId);
    const from = tgUser(nextTg());
    await linkTelegram(person, from!.id);
    await bot.handleUpdate(messageUpdate(from, 'в группу', { id: -100123, type: 'supergroup' }));
    expect((await seen(person)).bot).toBeNull();
  });
});

describe('отметка «заходил в приложение»', () => {
  const BOT_TOKEN = 'test-bot-token-presence';
  const app = express();
  miniappRoutes(app, { botToken: BOT_TOKEN });

  function initDataFor(telegramUserId: number): string {
    const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: telegramUserId, first_name: 'T' }) });
    const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
    return params.toString();
  }

  it('запрос Mini App ставит отметку; ошибка записи не ломает ответ', async () => {
    const { orgId } = await makeOrg();
    const person = await addPerson(orgId);
    const tg = nextTg();
    await linkTelegram(person, tg);

    await request(app).get('/app/api/lists').set('X-Telegram-Init-Data', initDataFor(tg)).expect(200);
    expect((await seen(person)).app).toBeInstanceOf(Date);

    const other = await addPerson(orgId);
    const tg2 = nextTg();
    await linkTelegram(other, tg2);
    fail.app = true;
    await request(app).get('/app/api/lists').set('X-Telegram-Init-Data', initDataFor(tg2)).expect(200);
    expect((await seen(other)).app).toBeNull();
  });
});

describe('кто видит отметки', () => {
  it('find_person: владельцу — last_seen_* и seen_tracked_since, рядовому — без них', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId, 'member', { name: `Ахмет ${uniq()}` });
    await setSeen(person, 'last_seen_bot_at', 5);

    const forOwner = (await tool(ownerId, 'find_person', { org: orgId })) as any[];
    const row = forOwner.find((p) => p.id === person);
    // Словами и днём, без времени: «в 15:00» при заходе в 15:54 владелец читал как ошибку.
    expect(['today', 'yesterday']).toContain(row.last_seen_bot);
    expect(row.last_seen_bot_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row.last_seen_app).toBeNull();
    expect(row.last_seen_app_on).toBeNull();
    expect(row.seen_tracked_since).toBe(SEEN_TRACKED_SINCE);
    expect(row).not.toHaveProperty('last_seen_bot_at');
    expect(row).not.toHaveProperty('last_seen_app_at');

    const forMember = (await tool(person, 'find_person', { org: orgId })) as any[];
    for (const p of forMember) {
      for (const k of ['last_seen_bot', 'last_seen_app', 'last_seen_bot_on', 'last_seen_bot_at', 'seen_tracked_since']) {
        expect(p).not.toHaveProperty(k);
      }
    }
  });

  it('find_person: день захода — в часовом поясе смотрящего', async () => {
    const { orgId, ownerId } = await makeOrg();
    await withGlobal((db) => db.query(`update users set timezone = 'Europe/Moscow' where id = $1`, [ownerId]));
    const person = await addPerson(orgId);
    // 21:30 UTC — это уже 00:30 следующего дня по Москве: по UTC и по Москве день захода разный.
    const at = new Date();
    at.setUTCDate(at.getUTCDate() - 3);
    at.setUTCHours(21, 30, 0, 0);
    await withGlobal((db) => db.query('update users set last_seen_app_at = $2 where id = $1', [person, at]));

    const row = ((await tool(ownerId, 'find_person', { org: orgId })) as any[]).find((p) => p.id === person);
    expect(row.last_seen_app_on).toBe(localDate(at, 'Europe/Moscow'));
    expect(row.last_seen_app_on).not.toBe(localDate(at, 'UTC'));
    expect(row.last_seen_app).toBe(seenPhrase(at, 'Europe/Moscow').phrase);
  });

  it('review_person: агент владельца видит отметки, агент рядового — нет', async () => {
    const { orgId, ownerId } = await makeOrg();
    const member = await addPerson(orgId, 'member');
    const person = await addPerson(orgId, 'member');
    const ownerAgent = await makeAgent(orgId, ownerId);
    const memberAgent = await makeAgent(orgId, member);

    const forOwner = await tool(ownerId, 'review_person', { org: orgId, agent: ownerAgent, person });
    expect(forOwner).toHaveProperty('last_seen_app', null);
    expect(forOwner).not.toHaveProperty('last_seen_app_at');
    expect(forOwner.seen_tracked_since).toBe(SEEN_TRACKED_SINCE);

    const forMember = await tool(member, 'review_person', { org: orgId, agent: memberAgent, person });
    expect(forMember).not.toHaveProperty('last_seen_app');
    expect(forMember).not.toHaveProperty('seen_tracked_since');
  });
});

describe('приглашённый, но не принявший, — ещё не человек компании', () => {
  const BOT_TOKEN = 'test-bot-token-presence-inv';
  const app = express();
  miniappRoutes(app, { botToken: BOT_TOKEN });
  function initDataFor(telegramUserId: number): string {
    const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: telegramUserId, first_name: 'T' }) });
    const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
    return params.toString();
  }

  // Открытая регистрация: владелец любой компании может пригласить чужой адрес. Отметки и Telegram
  // жертвы — её жизнь в других компаниях, и приглашение не должно их раскрывать.
  it('find_person, review_person, «Компания» и resend не отдают ни отметок, ни Telegram', async () => {
    const victimOrg = await makeOrg();
    const victim = await addPerson(victimOrg.orgId, 'member', { name: `Жертва ${uniq()}` });
    await linkTelegram(victim, nextTg());
    await setSeen(victim, 'last_seen_bot_at', 2);
    await setSeen(victim, 'last_seen_app_at', 3);
    const email = await emailOf(victim);

    const { orgId, ownerId } = await makeOrg();
    const ownerTg = nextTg();
    await linkTelegram(ownerId, ownerTg);
    await inOrg(orgId, (db) => invitePerson(db, { email, role: 'member' }, { kind: 'user', userId: ownerId }));
    const hidden = ['last_seen_bot', 'last_seen_app', 'last_seen_bot_on', 'last_seen_app_on', 'last_seen_bot_at', 'last_seen_app_at', 'seen_tracked_since'];

    const row = ((await tool(ownerId, 'find_person', { org: orgId })) as any[]).find((p) => p.id === victim);
    expect(row.status).toBe('invited');
    for (const k of hidden) expect(row, k).not.toHaveProperty(k);
    expect(row.in_telegram).toBe(false);

    const agent = await makeAgent(orgId, ownerId);
    const review = await tool(ownerId, 'review_person', { org: orgId, agent, person: victim });
    for (const k of hidden) expect(review, k).not.toHaveProperty(k);

    const company = await request(app).get('/app/api/company').set('X-Telegram-Init-Data', initDataFor(ownerTg)).expect(200);
    const person = (company.body.people as any[]).find((p) => p.id === victim);
    expect(person).toMatchObject({ status: 'invited', in_telegram: false, last_seen_bot: null, last_seen_app: null, last_seen_app_on: null });
    expect(seenLabel('ru', person)).toBeNull();

    const resent = await inOrg(orgId, (db) => resendInvitation(db, email, { kind: 'user', userId: ownerId }));
    expect(resent.result).toBe('invitation_resent');
    for (const k of hidden) expect(resent, k).not.toHaveProperty(k);
  });
});

describe('отметка словами, в поясе смотрящего', () => {
  // Смотрящий в Москве (UTC+3). «Сейчас» — 10 октября, 12:00 по Москве.
  const MSK = 'Europe/Moscow';
  const now = new Date('2026-10-10T09:00:00Z');

  it('меньше часа — within the last hour, по прошедшему времени, а не по календарю', () => {
    expect(seenPhrase(new Date('2026-10-10T08:01:00Z'), MSK, now)).toEqual({ phrase: 'within the last hour', on: '2026-10-10' });
    // Ровно час назад — уже «сегодня».
    expect(seenPhrase(new Date('2026-10-10T08:00:00Z'), MSK, now).phrase).toBe('today');
  });

  it('сегодня и вчера — по календарю смотрящего', () => {
    // 00:10 по Москве сегодня (21:10 UTC вчера): для Москвы — today, для UTC — был бы yesterday.
    expect(seenPhrase(new Date('2026-10-09T21:10:00Z'), MSK, now)).toEqual({ phrase: 'today', on: '2026-10-10' });
    expect(seenPhrase(new Date('2026-10-09T21:10:00Z'), 'UTC', now).phrase).toBe('yesterday');
    // 23:30 по Москве вчера — yesterday.
    expect(seenPhrase(new Date('2026-10-09T20:30:00Z'), MSK, now)).toEqual({ phrase: 'yesterday', on: '2026-10-09' });
  });

  it('два дня и больше — N days ago; нет отметки — null', () => {
    expect(seenPhrase(new Date('2026-10-08T20:59:00Z'), MSK, now)).toEqual({ phrase: '2 days ago', on: '2026-10-08' });
    expect(seenPhrase(new Date('2026-10-01T10:00:00Z'), MSK, now).phrase).toBe('9 days ago');
    expect(seenPhrase(null, MSK, now)).toEqual({ phrase: null, on: null });
  });
});

describe('строка «заходит ли» в разделе «Компания»', () => {
  const base: SeenFacts = {
    status: 'active', in_telegram: true, last_seen_bot: null, last_seen_bot_on: null, last_seen_app: null, last_seen_app_on: null,
    seen_tracked_since: SEEN_TRACKED_SINCE, joined_at: null,
  };

  it('пришёл после начала учёта и не открывал — «ещё не заходил»', () => {
    expect(seenLabel('ru', { ...base, joined_at: '2026-10-01T09:00:00Z' })).toBe(appT('ru', 'app_never'));
  });

  it('пришёл до начала учёта — «не заходил с <даты>», а не выдуманное «никогда»', () => {
    for (const joined of ['2026-09-19T09:00:00Z', null]) {
      const line = seenLabel('ru', { ...base, joined_at: joined })!;
      expect(line, String(joined)).not.toBe(appT('ru', 'app_never'));
      expect(line).toMatch(/^В приложение не заходил с 29 сент/);
    }
    expect(seenLabel('en', { ...base, joined_at: null })).toMatch(/^Has not opened the app since 29 Sept?/);
  });

  it('заходил — свежее из двух каналов; «в течение часа»; приглашённому — ничего', () => {
    expect(seenLabel('ru', { ...base, last_seen_app: 'yesterday', last_seen_app_on: '2026-10-09', last_seen_bot: '5 days ago', last_seen_bot_on: '2026-10-05' }))
      .toBe(appT('ru', 'seen_yesterday'));
    expect(seenLabel('ru', { ...base, last_seen_app: 'today', last_seen_app_on: '2026-10-10', last_seen_bot: 'within the last hour', last_seen_bot_on: '2026-10-10' }))
      .toBe('Заходил: в течение часа');
    expect(seenLabel('ru', { ...base, last_seen_app: '4 days ago', last_seen_app_on: '2026-10-06' })).toBe(appT('ru', 'seen_days_ago', { n: 4 }));
    for (const lang of ['en', 'tr', 'vi']) expect(seenLabel(lang, { ...base, last_seen_app: 'within the last hour', last_seen_app_on: '2026-10-10' })).toBe(appT(lang, 'seen_hour'));
    expect(seenLabel('ru', { ...base, status: 'invited', joined_at: '2026-10-01T09:00:00Z' })).toBeNull();
  });
});

describe('get_briefing: people_not_seen', () => {
  it('показывает человека с делом в работе, не заходившего 3+ суток, и не показывает заходившего вчера', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agentId = await makeAgent(orgId, ownerId);
    const actor = { kind: 'agent' as const, agentId, userId: ownerId };
    const quiet = await addPerson(orgId, 'member', { name: `Тихий ${uniq()}` });
    const active = await addPerson(orgId, 'member', { name: `Живой ${uniq()}` });
    const never = await addPerson(orgId, 'member', { name: `Без отметок ${uniq()}` });
    const idle = await addPerson(orgId, 'member', { name: `Без дел ${uniq()}` });
    for (const p of [quiet, active, never, ownerId]) {
      await inOrg(orgId, (db) => createTask(db, { ...base, title: `дело ${uniq()}`, assigneeUserId: p }, actor));
    }
    await setSeen(quiet, 'last_seen_bot_at', 4 * 24);
    await setSeen(active, 'last_seen_app_at', 24);
    await setSeen(idle, 'last_seen_bot_at', 10 * 24);

    const briefing = await tool(ownerId, 'get_briefing', { org: orgId });
    const ids = (briefing.people_not_seen as any[]).map((p) => p.user_id);
    expect(ids).toContain(quiet);
    expect(ids).not.toContain(active);
    // Без дел в работе молчание — не сигнал.
    expect(ids).not.toContain(idle);
    // Владелец сам читает эту сводку и работает через claude.ai — о себе ему сигнал не нужен.
    expect(ids).not.toContain(ownerId);
    // Отметок нет — человек в списке, но с датой, с которой их пишут: «никогда» о прошлом не скажешь.
    const nv = (briefing.people_not_seen as any[]).find((p) => p.user_id === never);
    expect(nv).toMatchObject({ last_seen_bot: null, last_seen_app: null, last_seen_bot_on: null, seen_tracked_since: SEEN_TRACKED_SINCE });
    expect(nv).not.toHaveProperty('last_seen_bot_at');
    const q = (briefing.people_not_seen as any[]).find((p) => p.user_id === quiet);
    expect(q.last_seen_bot).toMatch(/^[45] days ago$/);
    expect(nv.tasks_in_work).toBe(1);
    // Имя человек задаёт сам — в сводке оно под untrusted, как авторы и заголовки.
    expect(nv.name).toMatchObject({ untrusted: true });
  });
});

describe('повторное приглашение по состоянию человека', () => {
  const byOwner = (ownerId: string) => ({ kind: 'user' as const, userId: ownerId });
  const openApp = async (orgId: string, userId: string) =>
    (await inOrg(orgId, (db) => db.query(`select payload from notifications where user_id = $1 and kind = 'open_app'`, [userId]))).rows;

  it('приглашение ждёт — письмо-приглашение с новой ссылкой (invitation_resent)', async () => {
    const { orgId, ownerId } = await makeOrg();
    const email = `pending-${uniq()}@test.local`;
    await inOrg(orgId, (db) => invitePerson(db, { email, role: 'member' }, byOwner(ownerId)));
    outbox.length = 0;

    const r = await inOrg(orgId, (db) => resendInvitation(db, email, byOwner(ownerId)));

    expect(r.result).toBe('invitation_resent');
    expect(r.sent).toEqual(['email']);
    // Непринявший ещё не в компании: его отметок в ответе нет.
    expect(r).not.toHaveProperty('last_seen_bot_at');
    expect(r).not.toHaveProperty('seen_tracked_since');
    expect(outbox.filter((m) => m.to === email)).toHaveLength(1);
    expect(outbox[0]!.text).toContain('?start=inv_');
  });

  it('активен, в приложение не заходил — письмо «откройте приложение» и сообщение бота (app_nudge_sent)', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    await linkTelegram(person, nextTg());
    await setSeen(person, 'last_seen_bot_at', 100);
    const email = await emailOf(person);
    outbox.length = 0;

    const r = await inOrg(orgId, (db) => resendInvitation(db, email, byOwner(ownerId)));

    expect(r.result).toBe('app_nudge_sent');
    expect(r.sent).toEqual(['email', 'telegram']);
    expect(r.last_seen_bot).toMatch(/days ago$/);
    expect(r.last_seen_app).toBeNull();
    expect(r).not.toHaveProperty('last_seen_bot_at');
    const mails = outbox.filter((m) => m.to === email);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain('?startapp');
    expect(mails[0]!.text).not.toContain('start=inv_');
    expect(await openApp(orgId, person)).toHaveLength(1);
  });

  it('Telegram заблокировал бота — уходит только письмо', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    await linkTelegram(person, nextTg(), true);
    const email = await emailOf(person);
    outbox.length = 0;

    const r = await inOrg(orgId, (db) => resendInvitation(db, email, byOwner(ownerId)));

    expect(r.result).toBe('app_nudge_sent');
    expect(r.sent).toEqual(['email']);
    expect(outbox.filter((m) => m.to === email)).toHaveLength(1);
    expect(await openApp(orgId, person)).toHaveLength(0);
  });

  it('в приложение заходил — ничего не отправляется (already_using_app)', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    await linkTelegram(person, nextTg());
    await setSeen(person, 'last_seen_app_at', 30);
    const email = await emailOf(person);
    outbox.length = 0;

    const r = await inOrg(orgId, (db) => resendInvitation(db, email, byOwner(ownerId)));

    expect(r.result).toBe('already_using_app');
    expect(r.sent).toEqual([]);
    // 30 часов назад — «вчера» или «2 days ago» смотря по часу прогона; здесь важно, что заход виден.
    expect(r.last_seen_app).toMatch(/^(today|yesterday|\d+ days ago)$/);
    expect(outbox.filter((m) => m.to === email)).toHaveLength(0);
    expect(await openApp(orgId, person)).toHaveLength(0);
  });

  it('повтор в течение суток — app_nudge_recent, второго письма и сообщения нет', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    await linkTelegram(person, nextTg());
    const email = await emailOf(person);
    outbox.length = 0;

    const first = await inOrg(orgId, (db) => resendInvitation(db, email, byOwner(ownerId)));
    const second = await inOrg(orgId, (db) => resendInvitation(db, email, byOwner(ownerId)));

    expect(first.result).toBe('app_nudge_sent');
    expect(second.result).toBe('app_nudge_recent');
    expect(second.sent).toEqual([]);
    expect(outbox.filter((m) => m.to === email)).toHaveLength(1);
    expect(await openApp(orgId, person)).toHaveLength(1);

    // Сутки прошли — напоминание уходит снова.
    await inOrg(orgId, (db) => db.query(
      `update events set at = at - interval '25 hours' where type = 'invitation_resent' and data->>'user_id' = $1`, [person]));
    const third = await inOrg(orgId, (db) => resendInvitation(db, email, byOwner(ownerId)));
    expect(third.result).toBe('app_nudge_sent');
  });

  it('нет в компании или выведен — not_found', async () => {
    const { orgId, ownerId } = await makeOrg();
    await expect(inOrg(orgId, (db) => resendInvitation(db, `nobody-${uniq()}@test.local`, byOwner(ownerId))))
      .rejects.toMatchObject({ code: 'not_found' });

    const gone = await addPerson(orgId);
    await withGlobal((db) => db.query(`update memberships set status = 'removed' where org_id = $1 and user_id = $2`, [orgId, gone]));
    outbox.length = 0;
    await expect(inOrg(orgId, async (db) => resendInvitation(db, await emailOf(gone), byOwner(ownerId))))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(outbox).toHaveLength(0);
  });

  it('бюджет писем исчерпан — та же ошибка, что у приглашений; ничего не отправлено', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    await linkTelegram(person, nextTg());
    const email = await emailOf(person);
    // Свежая компания: суточный потолок — youngPerDay писем-приглашений.
    await inOrg(orgId, async (db) => {
      for (let i = 0; i < INVITE_LIMITS.youngPerDay; i++) {
        await db.query(`insert into events(org_id, type, data) values ($1, 'person_invited', '{}')`, [orgId]);
      }
    });
    outbox.length = 0;

    await expect(inOrg(orgId, (db) => resendInvitation(db, email, byOwner(ownerId)))).rejects.toMatchObject({ code: 'limit_exceeded' });
    expect(outbox).toHaveLength(0);
    expect(await openApp(orgId, person)).toHaveLength(0);
  });

  it('invite_person без resend для активного — писем нет, отметки в ответе', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    await setSeen(person, 'last_seen_app_at', 2);
    outbox.length = 0;

    const r = await inOrg(orgId, async (db) => invitePerson(db, { email: await emailOf(person), role: 'member' }, byOwner(ownerId)));

    expect(r.alreadyMember).toBe(true);
    expect(r).toMatchObject({ seen_tracked_since: SEEN_TRACKED_SINCE, last_seen_bot: null });
    expect(['today', 'yesterday']).toContain((r as { last_seen_app: string }).last_seen_app);
    expect(r).not.toHaveProperty('last_seen_app_at');
    expect(outbox).toHaveLength(0);
  });

  it('invite_person(resend) через коннектор отвечает result и sent', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    await linkTelegram(person, nextTg());
    const r = await tool(ownerId, 'invite_person', { org: orgId, email: await emailOf(person), resend: true });
    expect(r).toMatchObject({ result: 'app_nudge_sent', sent: ['email', 'telegram'], seen_tracked_since: SEEN_TRACKED_SINCE });
  });
});

describe('сообщение бота open_app', () => {
  it('доходит с кнопкой web_app на приложение и называет, кто просит и какая компания', async () => {
    const { orgId, ownerId } = await makeOrg();
    await withGlobal((db) => db.query(`update users set display_name = 'Олег' where id = $1`, [ownerId]));
    const person = await addPerson(orgId);
    await linkTelegram(person, nextTg());
    await inOrg(orgId, async (db) => resendInvitation(db, await emailOf(person), { kind: 'user', userId: ownerId }));
    const n = (await inOrg(orgId, (db) => db.query(`select id from notifications where user_id = $1 and kind = 'open_app'`, [person]))).rows[0];
    const orgName = (await withGlobal((db) => db.query('select name from orgs where id = $1', [orgId]))).rows[0].name;

    expect(await deliverNotification(orgId, n.id)).toBe('sent');

    const msg = sent.find((s) => s.method === 'sendMessage')!;
    expect(msg.payload.text).toBe(`<b>${t('ru', 'notif.open_app', { name: 'Олег' })}</b>\n\n${t('ru', 'notif.open_app_body', { org: orgName })}`);
    const markup = JSON.stringify(msg.payload.reply_markup);
    expect(markup).toContain('web_app');
    expect(markup).toContain('/app/');
    expect(markup).toContain(t('ru', 'btn.open_app'));
  });
});

describe('письма', () => {
  const LANGS = ['ru', 'en', 'tr', 'vi'] as const;
  const botStrings = (lang: string) => JSON.parse(readFileSync(new URL(`../src/i18n/${lang}.json`, import.meta.url), 'utf8'));
  const invitation = (lang: string) => invitationMail('w@example.com', {
    inviterName: 'Олег', orgName: 'Northwind', link: 'https://t.me/taskano_bot?start=inv_tok',
  }, lang);
  const openApp = (lang: string) => openAppMail('w@example.com', { requesterName: 'Олег', orgName: 'Northwind', botUsername: 'taskano_bot' }, lang);
  const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((h) => h[1]);

  it('приглашение ведёт на ?start=inv_, «откройте приложение» — на ?startapp; на каждом языке', () => {
    for (const lang of LANGS) {
      expect(hrefs(invitation(lang).html), lang).toEqual(['https://t.me/taskano_bot?start=inv_tok']);
      expect(hrefs(openApp(lang).html), lang).toEqual(['https://t.me/taskano_bot?startapp']);
      expect(openApp(lang).text, lang).toContain('https://t.me/taskano_bot?startapp');
    }
  });

  it('тексты своего языка, а не английский запасной', () => {
    const subjects = new Set(LANGS.map((l) => openApp(l).subject));
    expect(subjects.size).toBe(4);
    expect(openApp('ru').subject).toBe('Ваши дела в «Northwind» — в приложении Taskano');
    for (const lang of LANGS) {
      expect(openApp(lang).text, lang).toContain('Олег');
      expect(openApp(lang).text, lang).toContain('@taskano_bot');
    }
  });

  it('приглашение: цель под заголовком и кнопки, которые человек увидит', () => {
    for (const lang of LANGS) {
      const m = invitation(lang);
      const strings = botStrings(lang);
      for (const key of ['btn.yes_its_me', 'btn.open_app', 'menu.app_button']) {
        expect(m.html, `${lang} ${key}`).toContain(strings[key].replace(/"/g, '&quot;'));
        expect(m.text, `${lang} ${key}`).toContain(strings[key]);
      }
    }
    expect(invitation('ru').text.split('\n')[1]).toMatch(/^Чтобы начать, два шага/);
    expect(invitation('ru').html).toContain('Шаг 1: открыть бота в Telegram →');
    expect(invitation('ru').text).toContain('«Старт»');
    expect(invitation('en').text).toContain('“Start”');
    expect(invitation('tr').text).toContain('“Başlat”');
    expect(invitation('vi').text).toContain('“Bắt đầu”');
  });

  it('шаг про значок на экране — одними словами в обоих письмах и как в боте', () => {
    expect(openApp('tr').text).toContain('2. Ana ekrana ekleyin.');
    expect(openApp('vi').text).toContain('2. Thêm vào màn hình chính.');
    expect(invitation('tr').text).toContain('3. Ana ekrana ekleyin.');
    expect(invitation('vi').text).toContain('3. Thêm vào màn hình chính.');
  });

  it('«откройте приложение»: запасной путь называет кнопку слева от поля ввода, как в боте', () => {
    for (const lang of LANGS) {
      expect(openApp(lang).html, lang).toContain(botStrings(lang)['menu.app_button']);
    }
  });

  it('в нерусских языках нет ёлочек, а стили — с одинарными кавычками', () => {
    for (const lang of ['en', 'tr', 'vi']) {
      const m = openApp(lang);
      expect(`${m.subject}${m.text}${m.html}`, lang).not.toMatch(/[«»]/);
    }
    for (const lang of LANGS) expect(openApp(lang).html, lang).not.toContain('"Segoe UI"');
  });
});

describe('совет после входа несёт кнопку в приложение', () => {
  const webAppTip = (lang: string) => sent.find((s) => s.method === 'sendMessage' && s.payload.text === t(lang, 'menu.home_screen'));

  it('после согласия', async () => {
    const { orgId, ownerId } = await makeOrg();
    outbox.length = 0;
    await inOrg(orgId, (db) => invitePerson(db, { email: `tip-${uniq()}@test.local`, role: 'member' }, { kind: 'user', userId: ownerId }));
    const token = /start=inv_([^\s"<]+)/.exec(outbox.at(-1)!.text)![1]!;
    const from = tgUser(nextTg());

    await bot.handleUpdate(messageUpdate(from, `/start inv_${token}`));
    await bot.handleUpdate(callbackUpdate(from, 'inv:yes'));
    await bot.handleUpdate(callbackUpdate(from, 'lang:ru'));
    await bot.handleUpdate(callbackUpdate(from, 'tz:ok'));
    await bot.handleUpdate(callbackUpdate(from, 'consent:ok'));

    const tip = webAppTip('ru');
    expect(tip, JSON.stringify(sent.map((s) => s.payload.text))).toBeTruthy();
    const markup = JSON.stringify(tip!.payload.reply_markup);
    expect(markup).toContain('web_app');
    expect(markup).toContain(t('ru', 'btn.open_app'));
  });

  it('после входа по почте', async () => {
    const email = `mail-login-${uniq()}@test.local`;
    const { orgId } = await makeOrg();
    await withGlobal(async (db) => {
      const { ensureUserByEmail, addMember } = await import('../src/core/people.js');
      const { user } = await ensureUserByEmail(db, email, { verified: true, language: 'ru' });
      await addMember(db, orgId, user.id, 'member');
    });
    const from = tgUser(nextTg());
    outbox.length = 0;

    await bot.handleUpdate(messageUpdate(from, '/start'));
    await bot.handleUpdate(messageUpdate(from, email));
    const code = /(\d{6})/.exec(outbox.filter((m) => m.to === email).at(-1)!.text)![1]!;
    await bot.handleUpdate(messageUpdate(from, code));

    const tip = webAppTip('ru');
    expect(tip, JSON.stringify(sent.map((s) => s.payload.text))).toBeTruthy();
    expect(JSON.stringify(tip!.payload.reply_markup)).toContain('web_app');
  });
});
