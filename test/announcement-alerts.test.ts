process.env.TASKANO_DISABLE_RATE_LIMIT = '1';

import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserFromGetMe } from 'grammy/types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closePools, withGlobal } from '../src/db/pool.js';
import { buildMcpServer } from '../src/mcp/server.js';
import {
  AGENT_DAILY_LIMIT, ALERT_AGENT_DAILY_LIMIT, ALERT_OPEN_LIMIT, ALERT_ORG_DAILY_LIMIT, confirmAnnouncement, ORG_DAILY_LIMIT, raiseAlert, resolveAlert, runAlertRounds, sendAnnouncement,
} from '../src/core/announcements.js';
import { addWorkingMinutes, loadUserSchedule } from '../src/core/calendar.js';
import { sha256 } from '../src/core/crypto.js';
import { tickOrg } from '../src/worker/tick.js';
import { createBot } from '../src/bot/bot.js';
import { encodeAnnouncement } from '../src/bot/callbacks.js';
import { miniappRoutes } from '../src/web/miniapp-api.js';
import { addPerson, inOrg, makeAgent, makeOrg, makeUser, MON_10, uniq } from './helpers.js';

// Спека announcement-alerts: тревога — объявление, которое повторяется по ключу, пока событие
// не наступит. Расписание проверяется на runAlertRounds с явным `now` и графиком получателя 9–18 по
// Стамбулу (UTC+3); подъём и снятие — живым путём через коннектор (MCP-клиент); заслон — через
// GET /app/api/lists; доставка в бот — тик организации.

// Перевод в фоне: подмена записывает вызовы и зовёт настоящую функцию (модели в тестах нет — она быстро сдаётся).
// Нужна, чтобы увидеть, под каким id и с каким текстом тревога греет перевод.
const warmCalls = vi.hoisted(() => ({ list: [] as { orgId: string; inputs: { objectType: string; objectId: string; text: string; targetLang: string }[] }[] }));
vi.mock('../src/ai/translate.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/ai/translate.js')>();
  return {
    ...mod,
    warmTranslations: async (...a: Parameters<typeof mod.warmTranslations>) => {
      warmCalls.list.push({ orgId: a[0], inputs: a[1] as never });
      return mod.warmTranslations(...a);
    },
  };
});

afterAll(closePools);

const user = (userId: string) => ({ kind: 'user' as const, userId });
const agentActor = (agentId: string, userId: string) => ({ kind: 'agent' as const, agentId, userId });
/** Момент по Стамбулу: ist('2026-09-21T13:30'). */
const ist = (iso: string) => new Date(`${iso}+03:00`);

async function call(userId: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: any }> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildMcpServer({ userId }).connect(serverT);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientT);
  const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = r.content[0]!.text;
  // Отказ схемы аргументов приходит от SDK простой строкой, а не JSON инструмента.
  let data: any;
  try { data = JSON.parse(text); } catch { data = { code: 'schema', message: text }; }
  return { isError: !!r.isError, data };
}

/** Олег (владелец) и сторож от его агента; Админ, Мария, Ахмет и Рядовой — участники той же компании. */
async function world() {
  const ownerId = await makeUser({ name: 'Олег' });
  const { orgId } = await makeOrg(ownerId);
  const adminId = await addPerson(orgId, 'admin', { name: 'Админ' });
  const mariaId = await addPerson(orgId, 'member', { name: 'Мария' });
  const ahmetId = await addPerson(orgId, 'member', { name: 'Ахмет' });
  const memberId = await addPerson(orgId, 'member', { name: 'Рядовой' });
  // График задан явно: пн–пт 9:00–18:00 по Стамбулу, а не тем, что окажется по умолчанию.
  await withGlobal((db) => db.query(
    `update users set timezone = 'Europe/Istanbul', work_days = '{1,2,3,4,5}', work_start = '09:00', work_end = '18:00' where id = any($1::uuid[])`,
    [[ownerId, adminId, mariaId, ahmetId, memberId]]));
  return { orgId, ownerId, adminId, mariaId, ahmetId, memberId };
}
type World = Awaited<ReturnType<typeof world>>;

const ALERT_TEXT = 'Поставка ORD-1 стоит на этапе «в пути» уже 2 дня. Хозяин — Мария. Ждём факт: груз прошёл границу.';
const KEY = 'shipment-stage:ORD-1:in_transit';

type RaiseArgs = { key?: string; text?: string; to: 'all' | string[]; per_day?: number; escalated_per_day?: number; escalate_after_days?: number };

/** Подъём ядром с заданным временем — для расписания, которому нужен «понедельник, 10:00». */
async function raise(w: World, args: RaiseArgs, from = w.ownerId, now = MON_10) {
  return inOrg(w.orgId, (db) => raiseAlert(db, { key: KEY, text: ALERT_TEXT, ...args }, user(from), now));
}
const tickAlerts = (orgId: string, now: Date) => inOrg(orgId, (db) => runAlertRounds(db, now));

type Round = { id: string; text: string; created_at: Date; confirmed_at: Date | null; author_agent_id: string | null };
/** Раунды тревоги (объявления с alert_id) — у одного человека или у всех, старые первыми. */
async function roundsOf(orgId: string, alertId: string, userId?: string): Promise<Round[]> {
  return (await inOrg(orgId, (db) => db.query(
    `select a.id, a.text, a.created_at, r.confirmed_at, a.author_agent_id
       from announcements a join announcement_recipients r on r.announcement_id = a.id
      where a.alert_id = $1 and ($2::uuid is null or r.user_id = $2)
      order by a.created_at, a.id`, [alertId, userId ?? null]))).rows as Round[];
}

async function counter(orgId: string, alertId: string, userId: string) {
  return (await inOrg(orgId, (db) => db.query(
    'select rounds, last_round_at from announcement_alert_recipients where alert_id = $1 and user_id = $2', [alertId, userId]))).rows[0] as { rounds: number; last_round_at: Date | null };
}

async function notes(orgId: string, kind: string, userId: string) {
  return (await inOrg(orgId, (db) => db.query(
    `select id, payload, dedupe_key, delivered_at from notifications where kind = $1 and user_id = $2 order by created_at, dedupe_key`,
    [kind, userId]))).rows as { id: string; payload: { announcement_id: string; agent_id?: string }; dedupe_key: string | null; delivered_at: Date | null }[];
}

const count = async (orgId: string, table: string) =>
  (await inOrg(orgId, (db) => db.query(`select count(*)::int as n from ${table}`))).rows[0].n as number;

// ---------------------------------------------------------------- бот и приложение (как в announcements.test.ts)

const BOT_INFO: UserFromGetMe = {
  id: 10, is_bot: true, first_name: 'Taskano', username: 'taskano_test_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
  allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
};

type Sent = { method: string; payload: Record<string, any> };
let sent: Sent[];
let bot: ReturnType<typeof createBot>;
let nextMessageId = 1;
let nextTgId = 8_300_000 + Math.floor(Math.random() * 100_000);

beforeEach(() => {
  sent = [];
  // createBot ставит этот Api доставкой уведомлений: тик ниже шлёт через него же.
  bot = createBot({ token: 'test-token', botInfo: BOT_INFO });
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, any> });
    if (method === 'sendMessage') {
      const chatId = (payload as { chat_id?: number }).chat_id;
      return { ok: true, result: { message_id: nextMessageId++, date: 0, chat: { id: chatId, type: 'private' }, text: '' } } as any;
    }
    return { ok: true, result: true } as any;
  });
});

async function linkTelegram(userId: string): Promise<number> {
  const id = nextTgId++;
  await withGlobal((db) => db.query(`insert into telegram_links(telegram_user_id, user_id, chat_id) values ($1, $2, $1)`, [id, userId]));
  return id;
}

const messagesTo = (tg: number): Sent[] => sent.filter((s) => s.method === 'sendMessage' && s.payload.chat_id === tg);

const BOT_TOKEN = 'test-bot-token-alerts';
const app = express();
miniappRoutes(app, { botToken: BOT_TOKEN });

function initData(telegramUserId: number): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: telegramUserId, first_name: 'Test' }),
  });
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

const lists = (tg: number) => request(app).get('/app/api/lists').set('X-Telegram-Init-Data', initData(tg));
const listIds = async (tg: number): Promise<string[]> => (await lists(tg)).body.announcements.map((a: { id: string }) => a.id);
const confirmApp = (tg: number, id: string) => request(app).post(`/app/api/announcements/${id}/confirm`).set('X-Telegram-Init-Data', initData(tg));

// ---------------------------------------------------------------- подъём и права

describe('raise_alert: тревога и первый раунд', () => {
  it('владелец, админ и их агенты — тревога и первый раунд каждому получателю: объявление и уведомление announcement', async () => {
    const w = await world();
    const ownerAgent = await makeAgent(w.orgId, w.ownerId);
    const adminAgent = await makeAgent(w.orgId, w.adminId);

    const byOwner = await call(w.ownerId, 'raise_alert', { org: w.orgId, key: KEY, text: ALERT_TEXT, to: ['Мария', 'Ахмет'] });
    expect(byOwner.isError, JSON.stringify(byOwner.data)).toBe(false);
    expect(byOwner.data.created).toBe(true);
    expect(byOwner.data.recipients.map((r: { name: { untrusted: boolean; text: string } }) => r.name))
      .toEqual([{ untrusted: true, text: 'Мария' }, { untrusted: true, text: 'Ахмет' }]);
    const alertId = byOwner.data.alert_id as string;

    const alert = (await inOrg(w.orgId, (db) => db.query('select * from announcement_alerts where id = $1', [alertId]))).rows[0];
    expect(alert).toMatchObject({
      key: KEY, text: ALERT_TEXT, author_user_id: w.ownerId, author_agent_id: null, per_day: 2, escalated_per_day: 4, escalate_after_days: 2, resolved_at: null,
    });
    for (const id of [w.mariaId, w.ahmetId]) {
      const rounds = await roundsOf(w.orgId, alertId, id);
      expect(rounds).toHaveLength(1);
      expect(rounds[0]).toMatchObject({ text: ALERT_TEXT, confirmed_at: null });
      const [note] = await notes(w.orgId, 'announcement', id);
      expect(note!.payload.announcement_id).toBe(rounds[0]!.id);
      expect(note!.dedupe_key).toBe(`alert:${alertId}:${id}:1`);
      expect((await counter(w.orgId, alertId, id)).rounds).toBe(1);
    }
    // Раунд — объявление одному получателю: чужим он не достаётся.
    expect(await notes(w.orgId, 'announcement', w.memberId)).toHaveLength(0);
    expect((await inOrg(w.orgId, (db) => db.query('select to_all from announcements where alert_id = $1', [alertId]))).rows.every((r) => r.to_all === false)).toBe(true);

    const byAdmin = await call(w.adminId, 'raise_alert', { org: w.orgId, key: 'admin-key', text: 'От админа', to: ['Мария'] });
    expect(byAdmin.isError, JSON.stringify(byAdmin.data)).toBe(false);

    const viaOwnerAgent = await call(w.ownerId, 'raise_alert', { org: w.orgId, agent: ownerAgent, key: 'agent-key', text: 'От сторожа', to: ['Ахмет'] });
    expect(viaOwnerAgent.isError, JSON.stringify(viaOwnerAgent.data)).toBe(false);
    const agentAlert = (await inOrg(w.orgId, (db) => db.query('select author_user_id, author_agent_id from announcement_alerts where id = $1', [viaOwnerAgent.data.alert_id]))).rows[0];
    expect(agentAlert).toMatchObject({ author_user_id: w.ownerId, author_agent_id: ownerAgent });
    const agentRound = (await roundsOf(w.orgId, viaOwnerAgent.data.alert_id, w.ahmetId))[0]!;
    expect(agentRound.author_agent_id).toBe(ownerAgent);
    const agentNote = (await notes(w.orgId, 'announcement', w.ahmetId)).find((n) => n.payload.announcement_id === agentRound.id)!;
    expect(agentNote.payload.agent_id).toBe(ownerAgent);

    const viaAdminAgent = await call(w.adminId, 'raise_alert', { org: w.orgId, agent: adminAgent, key: 'admin-agent-key', text: 'От сторожа админа', to: ['Мария'] });
    expect(viaAdminAgent.isError, JSON.stringify(viaAdminAgent.data)).toBe(false);
  });

  it('рядовой участник и его агент — forbidden на подъём и на снятие, ничего не записано', async () => {
    const w = await world();
    const memberAgent = await makeAgent(w.orgId, w.memberId);
    const denied = await call(w.memberId, 'raise_alert', { org: w.orgId, key: KEY, text: ALERT_TEXT, to: ['Мария'] });
    expect(denied.isError).toBe(true);
    expect(denied.data.code).toBe('forbidden');
    const viaAgent = await call(w.memberId, 'raise_alert', { org: w.orgId, agent: memberAgent, key: KEY, text: ALERT_TEXT, to: 'all' });
    expect(viaAgent.isError).toBe(true);
    expect(viaAgent.data.code).toBe('forbidden');
    expect(await count(w.orgId, 'announcement_alerts')).toBe(0);
    expect(await count(w.orgId, 'announcements')).toBe(0);
    expect((await inOrg(w.orgId, (db) => db.query(`select count(*)::int as n from notifications where kind = 'announcement'`))).rows[0].n).toBe(0);

    // Снять тоже нельзя: открытую тревогу рядовой и его агент не трогают.
    const raised = await call(w.ownerId, 'raise_alert', { org: w.orgId, key: KEY, text: ALERT_TEXT, to: ['Мария'] });
    expect((await call(w.memberId, 'resolve_alert', { org: w.orgId, key: KEY })).data.code).toBe('forbidden');
    expect((await call(w.memberId, 'resolve_alert', { org: w.orgId, agent: memberAgent, key: KEY })).data.code).toBe('forbidden');
    expect((await inOrg(w.orgId, (db) => db.query('select resolved_at from announcement_alerts where id = $1', [raised.data.alert_id]))).rows[0].resolved_at).toBeNull();
  });

  it('первый раунд приходит в бот тем же сообщением и той же кнопкой, что объявление', async () => {
    const w = await world();
    const tg = await linkTelegram(w.mariaId);
    const { alert_id } = await raise(w, { to: [w.mariaId] });
    await tickOrg(w.orgId, MON_10);
    const [round] = await roundsOf(w.orgId, alert_id);
    const msg = messagesTo(tg);
    expect(msg).toHaveLength(1);
    expect(msg[0]!.payload.text).toContain(ALERT_TEXT);
    expect(msg[0]!.payload.reply_markup.inline_keyboard.flat()).toEqual([
      { text: 'Прочёл, подтверждаю', callback_data: encodeAnnouncement(round!.id) },
    ]);
  });

  it('в личном пространстве и без людей — отказ', async () => {
    const w = await world();
    const personal = await call(w.ownerId, 'raise_alert', { org: 'personal', key: KEY, text: ALERT_TEXT, to: 'all' });
    expect(personal.isError).toBe(true);
    expect(personal.data.code).toBe('validation_failed');
    expect((await call(w.ownerId, 'raise_alert', { org: w.orgId, key: KEY, text: ALERT_TEXT, to: ['Никто-Такой'] })).data.code).toBe('not_found');
    expect((await call(w.ownerId, 'raise_alert', { org: w.orgId, key: KEY, text: '   ', to: 'all' })).isError).toBe(true);
    expect((await call(w.ownerId, 'raise_alert', { org: w.orgId, key: 'к'.repeat(201), text: ALERT_TEXT, to: 'all' })).isError).toBe(true);
    expect((await call(w.ownerId, 'raise_alert', { org: w.orgId, key: KEY, text: ALERT_TEXT, to: 'all', per_day: 5 })).isError).toBe(true);
    expect((await call(w.ownerId, 'raise_alert', { org: w.orgId, key: KEY, text: ALERT_TEXT, to: 'all', per_day: 3, escalated_per_day: 2 })).data.code).toBe('validation_failed');
    expect(await count(w.orgId, 'announcement_alerts')).toBe(0);
  });
});

// ---------------------------------------------------------------- повтор и снятие по ключу

describe('raise_alert повторно и resolve_alert', () => {
  it('открытый ключ — та же тревога, новый текст, раунда нет; получатели и частота прежние', async () => {
    const w = await world();
    const first = await call(w.ownerId, 'raise_alert', { org: w.orgId, key: KEY, text: 'Стоит 2 дня', to: ['Мария'], per_day: 3 });
    expect(first.data.created).toBe(true);
    const notesBefore = (await notes(w.orgId, 'announcement', w.mariaId)).length;

    const again = await call(w.ownerId, 'raise_alert', { org: w.orgId, key: KEY, text: 'Стоит 3 дня', to: ['Ахмет'], per_day: 1 });
    expect(again.isError, JSON.stringify(again.data)).toBe(false);
    expect(again.data.created).toBe(false);
    expect(again.data.alert_id).toBe(first.data.alert_id);
    expect(again.data.recipients.map((r: { user_id: string }) => r.user_id)).toEqual([w.mariaId]);

    expect(await count(w.orgId, 'announcement_alerts')).toBe(1);
    const alert = (await inOrg(w.orgId, (db) => db.query('select text, per_day from announcement_alerts where id = $1', [first.data.alert_id]))).rows[0];
    expect(alert).toEqual({ text: 'Стоит 3 дня', per_day: 3 });
    // Ни лишнего раунда, ни уведомления; Ахмет, которого нет в списке открытой тревоги, ничего не получил.
    expect(await roundsOf(w.orgId, first.data.alert_id)).toHaveLength(1);
    expect((await notes(w.orgId, 'announcement', w.mariaId)).length).toBe(notesBefore);
    expect(await notes(w.orgId, 'announcement', w.ahmetId)).toHaveLength(0);
    expect((await counter(w.orgId, first.data.alert_id, w.mariaId)).rounds).toBe(1);

    // Тот же текст ещё раз — тоже ничего не меняется.
    const same = await call(w.ownerId, 'raise_alert', { org: w.orgId, key: KEY, text: 'Стоит 3 дня', to: ['Мария'] });
    expect(same.data).toMatchObject({ created: false, alert_id: first.data.alert_id });
    expect(await roundsOf(w.orgId, first.data.alert_id)).toHaveLength(1);
  });

  it('следующий раунд идёт с новым текстом', async () => {
    const w = await world();
    const { alert_id } = await raise(w, { text: 'Стоит 2 дня', to: [w.mariaId] });
    await raise(w, { text: 'Стоит 3 дня', to: [w.mariaId] }, w.ownerId, ist('2026-09-21T11:00'));
    await tickAlerts(w.orgId, ist('2026-09-21T13:30'));
    expect((await roundsOf(w.orgId, alert_id)).map((r) => r.text)).toEqual(['Стоит 2 дня', 'Стоит 3 дня']);
  });

  it('повторный подъём, когда один из получателей вышел из компании: не ошибка, текст обновлён, ушедшего в ответе нет', async () => {
    const w = await world();
    const to = ['Мария', 'Ахмет'];
    const first = await call(w.ownerId, 'raise_alert', { org: w.orgId, key: KEY, text: 'Стоит 2 дня', to });
    expect(first.data.recipients).toHaveLength(2);
    await withGlobal((db) => db.query(`update memberships set status = 'removed' where org_id = $1 and user_id = $2`, [w.orgId, w.ahmetId]));

    const again = await call(w.ownerId, 'raise_alert', { org: w.orgId, key: KEY, text: 'Стоит 3 дня', to });
    expect(again.isError, JSON.stringify(again.data)).toBe(false);
    expect(again.data.created).toBe(false);
    expect(again.data.alert_id).toBe(first.data.alert_id);
    expect(again.data.recipients.map((r: { user_id: string }) => r.user_id)).toEqual([w.mariaId]);
    expect((await inOrg(w.orgId, (db) => db.query('select text from announcement_alerts where id = $1', [first.data.alert_id]))).rows[0].text).toBe('Стоит 3 дня');
    expect(await roundsOf(w.orgId, first.data.alert_id)).toHaveLength(2);
  });

  it('несколько подъёмов разом с одним ключом: одна тревога, created: true у одного, ни у кого не ошибка, первый раунд один на получателя', async () => {
    const w = await world();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => raise(w, { to: [w.mariaId, w.ahmetId] })));
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason?.message)).toEqual([]);
    const done = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof raise>>>).value);
    expect(done.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(done.map((r) => r.alert_id)).size).toBe(1);
    expect(await count(w.orgId, 'announcement_alerts')).toBe(1);
    const alertId = done[0]!.alert_id;
    for (const id of [w.mariaId, w.ahmetId]) {
      expect(await roundsOf(w.orgId, alertId, id)).toHaveLength(1);
      expect(await notes(w.orgId, 'announcement', id)).toHaveLength(1);
      expect((await counter(w.orgId, alertId, id)).rounds).toBe(1);
    }
  });

  it('смена текста открытой тревоги греет перевод под id тревоги, с новым текстом; тот же текст — не греет', async () => {
    const w = await world();
    const enId = await addPerson(w.orgId, 'member', { name: 'Англичанин', language: 'en' });
    const { alert_id } = await raise(w, { text: 'Стоит 2 дня', to: [enId] });
    const warmedFor = () => warmCalls.list.flatMap((c) => c.inputs).filter((i) => i.objectType === 'announcement' && i.objectId === alert_id);
    expect(warmedFor().map((i) => i.text)).toEqual(['Стоит 2 дня']);

    warmCalls.list.length = 0;
    await raise(w, { text: 'Стоит 2 дня', to: [enId] });
    expect(warmedFor()).toEqual([]);
    await raise(w, { text: 'Стоит 3 дня', to: [enId] });
    expect(warmedFor().map((i) => [i.targetLang, i.text])).toEqual([['en', 'Стоит 3 дня']]);
  });

  it('resolve_alert закрывает тревогу; тот же ключ после этого — новая тревога с первым раундом', async () => {
    const w = await world();
    const first = await call(w.ownerId, 'raise_alert', { org: w.orgId, key: KEY, text: ALERT_TEXT, to: ['Мария'] });
    const closed = await call(w.ownerId, 'resolve_alert', { org: w.orgId, key: KEY, reason: 'этап сдвинулся' });
    expect(closed.isError, JSON.stringify(closed.data)).toBe(false);
    expect(closed.data).toEqual({ resolved: true, alert_id: first.data.alert_id });
    expect((await inOrg(w.orgId, (db) => db.query('select resolved_at, resolved_reason from announcement_alerts where id = $1', [first.data.alert_id]))).rows[0])
      .toMatchObject({ resolved_reason: 'этап сдвинулся' });

    // Закрытой тревоги нет: ответ resolved: false, не ошибка; то же для ключа, которого не было.
    const twice = await call(w.ownerId, 'resolve_alert', { org: w.orgId, key: KEY });
    expect(twice.isError).toBe(false);
    expect(twice.data).toEqual({ resolved: false, alert_id: null });
    expect((await call(w.ownerId, 'resolve_alert', { org: w.orgId, key: 'нет-такого' })).data.resolved).toBe(false);

    const second = await call(w.ownerId, 'raise_alert', { org: w.orgId, key: KEY, text: 'Застряло снова', to: ['Мария'] });
    expect(second.data.created).toBe(true);
    expect(second.data.alert_id).not.toBe(first.data.alert_id);
    expect(await roundsOf(w.orgId, second.data.alert_id, w.mariaId)).toHaveLength(1);
    expect(await count(w.orgId, 'announcement_alerts')).toBe(2);
  });

  it('снимает агент владельца и агент админа; агент рядового — нет', async () => {
    const w = await world();
    const ownerAgent = await makeAgent(w.orgId, w.ownerId);
    await call(w.ownerId, 'raise_alert', { org: w.orgId, key: KEY, text: ALERT_TEXT, to: ['Мария'] });
    expect((await call(w.ownerId, 'resolve_alert', { org: w.orgId, agent: ownerAgent, key: KEY })).data.resolved).toBe(true);
    await call(w.adminId, 'raise_alert', { org: w.orgId, key: KEY, text: ALERT_TEXT, to: ['Мария'] });
    const adminAgent = await makeAgent(w.orgId, w.adminId);
    expect((await call(w.adminId, 'resolve_alert', { org: w.orgId, agent: adminAgent, key: KEY })).data.resolved).toBe(true);
  });
});

// ---------------------------------------------------------------- расписание

describe('расписание раундов: окно 9–18', () => {
  it('per_day 2: в 13:29 раунда нет, в 13:30 есть; следующий — 9:00 следующего рабочего дня', async () => {
    const w = await world();
    const { alert_id } = await raise(w, { to: [w.mariaId], escalate_after_days: 30 });
    const rounds = async () => (await roundsOf(w.orgId, alert_id, w.mariaId)).length;

    await tickAlerts(w.orgId, ist('2026-09-21T13:29'));
    expect(await rounds()).toBe(1);
    await tickAlerts(w.orgId, ist('2026-09-21T13:30'));
    expect(await rounds()).toBe(2);
    // Второй тик в ту же минуту раунда не задвоит.
    await tickAlerts(w.orgId, ist('2026-09-21T13:30'));
    await tickAlerts(w.orgId, ist('2026-09-21T17:59'));
    expect(await rounds()).toBe(2);
    await tickAlerts(w.orgId, ist('2026-09-22T08:59'));
    expect(await rounds()).toBe(2);
    await tickAlerts(w.orgId, ist('2026-09-22T09:00'));
    expect(await rounds()).toBe(3);
    expect(await notes(w.orgId, 'announcement', w.mariaId)).toHaveLength(3);
    expect((await counter(w.orgId, alert_id, w.mariaId)).rounds).toBe(3);
  });

  it('после escalate_after_days — четыре раунда в день: 9:00, 11:15, 13:30, 15:45', async () => {
    const w = await world();
    const { alert_id } = await raise(w, { to: [w.mariaId], escalate_after_days: 1 });
    const rounds = async () => (await roundsOf(w.orgId, alert_id, w.mariaId)).length;
    const steps: [string, number][] = [
      ['2026-09-21T13:29', 1], ['2026-09-21T13:30', 2], ['2026-09-21T13:30', 2],
      // Меньше суток с открытия — всё ещё два раза в день: следующий раунд во вторник в 9:00.
      ['2026-09-22T08:59', 2], ['2026-09-22T09:00', 3],
      // Сутки прошли в 10:00: частота четыре — после 9:00 следующий момент 11:15.
      ['2026-09-22T10:30', 3], ['2026-09-22T11:14', 3], ['2026-09-22T11:15', 4],
      ['2026-09-22T13:29', 4], ['2026-09-22T13:30', 5], ['2026-09-22T15:44', 5], ['2026-09-22T15:45', 6],
      ['2026-09-22T16:00', 6], ['2026-09-23T08:59', 6], ['2026-09-23T09:00', 7],
    ];
    for (const [at, expected] of steps) {
      await tickAlerts(w.orgId, ist(at));
      expect(await rounds(), at).toBe(expected);
    }
    expect((await roundsOf(w.orgId, alert_id, w.mariaId)).map((r) => r.created_at.toISOString())).toEqual([
      '2026-09-21T10:00', '2026-09-21T13:30', '2026-09-22T09:00', '2026-09-22T11:15', '2026-09-22T13:30', '2026-09-22T15:45', '2026-09-23T09:00',
    ].map((t) => ist(t).toISOString()));
  });

  it('простой не даёт пачку: тик через три дня — один раунд, а не по раунду за каждый пропущенный момент', async () => {
    const w = await world();
    const { alert_id } = await raise(w, { to: [w.mariaId], escalate_after_days: 30 });
    await tickAlerts(w.orgId, ist('2026-09-24T12:00'));
    expect(await roundsOf(w.orgId, alert_id, w.mariaId)).toHaveLength(2);
    await tickAlerts(w.orgId, ist('2026-09-24T12:00'));
    await tickAlerts(w.orgId, ist('2026-09-24T13:29'));
    expect(await roundsOf(w.orgId, alert_id, w.mariaId)).toHaveLength(2);
    // Отсчёт пошёл от этого раунда: дальше — обычный момент расписания.
    await tickAlerts(w.orgId, ist('2026-09-24T13:30'));
    expect(await roundsOf(w.orgId, alert_id, w.mariaId)).toHaveLength(3);
  });

  it('выходные раундов не дают: после пятницы — понедельник 9:00', async () => {
    const w = await world();
    const friday = ist('2026-09-25T10:00');
    const { alert_id } = await raise(w, { to: [w.mariaId], escalate_after_days: 30 }, w.ownerId, friday);
    await tickAlerts(w.orgId, ist('2026-09-25T13:30'));
    expect(await roundsOf(w.orgId, alert_id, w.mariaId)).toHaveLength(2);
    await tickAlerts(w.orgId, ist('2026-09-26T12:00'));
    await tickAlerts(w.orgId, ist('2026-09-27T12:00'));
    await tickAlerts(w.orgId, ist('2026-09-28T08:59'));
    expect(await roundsOf(w.orgId, alert_id, w.mariaId)).toHaveLength(2);
    await tickAlerts(w.orgId, ist('2026-09-28T09:00'));
    expect(await roundsOf(w.orgId, alert_id, w.mariaId)).toHaveLength(3);
  });

  it('два тика разом на моменте раунда — ровно один раунд на получателя', async () => {
    const w = await world();
    const { alert_id } = await raise(w, { to: [w.mariaId, w.ahmetId], escalate_after_days: 30 });
    const at = ist('2026-09-21T13:30');
    await Promise.all([tickAlerts(w.orgId, at), tickAlerts(w.orgId, at)]);
    for (const id of [w.mariaId, w.ahmetId]) {
      expect(await roundsOf(w.orgId, alert_id, id)).toHaveLength(2);
      expect((await counter(w.orgId, alert_id, id)).rounds).toBe(2);
      expect((await notes(w.orgId, 'announcement', id)).map((n) => n.dedupe_key))
        .toEqual([1, 2].map((n) => `alert:${alert_id}:${id}:${n}`));
    }
  });

  it('тик организации ведёт раунды сам; вышедшему из компании раундов нет', async () => {
    const w = await world();
    const { alert_id } = await raise(w, { to: [w.mariaId, w.ahmetId] });
    await withGlobal((db) => db.query(`update memberships set status = 'removed' where org_id = $1 and user_id = $2`, [w.orgId, w.ahmetId]));
    await tickOrg(w.orgId, ist('2026-09-21T13:30'));
    expect(await roundsOf(w.orgId, alert_id, w.mariaId)).toHaveLength(2);
    expect(await roundsOf(w.orgId, alert_id, w.ahmetId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- «Прочёл» и снятие

describe('подтверждение раунда и resolve_alert', () => {
  it('подтверждение раунда не останавливает следующие', async () => {
    const w = await world();
    const { alert_id } = await raise(w, { to: [w.mariaId], escalate_after_days: 30 });
    const [first] = await roundsOf(w.orgId, alert_id, w.mariaId);
    await inOrg(w.orgId, (db) => confirmAnnouncement(db, first!.id, w.mariaId, 'app'));
    await tickAlerts(w.orgId, ist('2026-09-21T13:30'));
    await tickAlerts(w.orgId, ist('2026-09-22T09:00'));
    const rounds = await roundsOf(w.orgId, alert_id, w.mariaId);
    expect(rounds).toHaveLength(3);
    expect(rounds[0]!.confirmed_at).not.toBeNull();
    expect(rounds[1]!.confirmed_at).toBeNull();
    expect(rounds[2]!.confirmed_at).toBeNull();
    expect((await notes(w.orgId, 'announcement', w.mariaId)).map((n) => n.dedupe_key))
      .toEqual([1, 2, 3].map((n) => `alert:${alert_id}:${w.mariaId}:${n}`));
  });

  it('после resolve_alert раундов больше нет, а неподтверждённый раунд уходит из GET /lists', async () => {
    const w = await world();
    const tg = await linkTelegram(w.mariaId);
    const keep = await raise(w, { key: 'другая', to: [w.mariaId], escalate_after_days: 30 });
    const { alert_id } = await raise(w, { to: [w.mariaId], escalate_after_days: 30 });
    await tickAlerts(w.orgId, ist('2026-09-21T13:30'));
    const [, lastOfKept] = await roundsOf(w.orgId, keep.alert_id, w.mariaId);
    const [, lastRound] = await roundsOf(w.orgId, alert_id, w.mariaId);
    expect((await listIds(tg)).sort()).toEqual([lastOfKept!.id, lastRound!.id].sort());

    const closed = await call(w.ownerId, 'resolve_alert', { org: w.orgId, key: KEY, reason: 'этап сдвинулся' });
    expect(closed.data.resolved).toBe(true);
    // Неподтверждённый раунд снятой тревоги ушёл; чужая открытая остаётся.
    expect(await listIds(tg)).toEqual([lastOfKept!.id]);

    const notesBefore = (await notes(w.orgId, 'announcement', w.mariaId)).length;
    await tickAlerts(w.orgId, ist('2026-09-22T09:00'));
    await tickAlerts(w.orgId, ist('2026-09-23T09:00'));
    expect(await roundsOf(w.orgId, alert_id, w.mariaId)).toHaveLength(2);
    expect((await counter(w.orgId, alert_id, w.mariaId)).rounds).toBe(2);
    // У другой, открытой, раунды идут: по одному на каждый из двух дней.
    expect(await roundsOf(w.orgId, keep.alert_id, w.mariaId)).toHaveLength(4);
    expect((await notes(w.orgId, 'announcement', w.mariaId)).length).toBe(notesBefore + 2);
    expect(await listIds(tg)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- доставка в бот

describe('доставка раунда в бот', () => {
  it('раунд тревоги, снятой до доставки (тихие часы), в бот не уходит; раунд открытой тревоги уходит', async () => {
    const w = await world();
    const tg = await linkTelegram(w.mariaId);
    await withGlobal((db) => db.query(`update users set quiet_start = '13:00', quiet_end = '15:00' where id = $1`, [w.mariaId]));
    const at14 = ist('2026-09-21T14:00');
    const closed = await raise(w, { key: 'снимем', text: 'Тревога, которую снимут', to: [w.mariaId] }, w.ownerId, at14);
    await raise(w, { key: 'останется', text: 'Тревога, которая остаётся', to: [w.mariaId] }, w.ownerId, at14);
    await tickOrg(w.orgId, at14);
    // В тихие часы не доставлено ничего: оба раунда ждут.
    expect(messagesTo(tg)).toHaveLength(0);
    expect((await notes(w.orgId, 'announcement', w.mariaId)).every((n) => n.delivered_at === null)).toBe(true);

    const resolved = await call(w.ownerId, 'resolve_alert', { org: w.orgId, key: 'снимем' });
    expect(resolved.data).toEqual({ resolved: true, alert_id: closed.alert_id });
    await tickOrg(w.orgId, ist('2026-09-21T15:01'));

    const texts = messagesTo(tg).map((m) => m.payload.text as string);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('Тревога, которая остаётся');
    expect(texts.some((x) => x.includes('Тревога, которую снимут'))).toBe(false);
    // Снятый раунд помечен обработанным, а не висит в очереди.
    const held = (await notes(w.orgId, 'announcement', w.mariaId)).filter((n) => n.dedupe_key?.startsWith(`alert:${closed.alert_id}:`));
    expect(held).toHaveLength(1);
    expect(held[0]!.delivered_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------- заслон

describe('заслон: по каждой тревоге только последний раунд', () => {
  it('из двух неподтверждённых раундов GET /lists отдаёт только последний; подтверждённый последний — пусто до нового раунда', async () => {
    const w = await world();
    const tg = await linkTelegram(w.mariaId);
    const { alert_id } = await raise(w, { to: [w.mariaId], escalate_after_days: 30 });
    await tickAlerts(w.orgId, ist('2026-09-21T13:30'));
    const [first, second] = await roundsOf(w.orgId, alert_id, w.mariaId);
    expect(await listIds(tg)).toEqual([second!.id]);

    // Подтверждение под старым раундом (кнопка в боте) — не ошибка, но заслон держит последний.
    expect((await confirmApp(tg, first!.id)).status).toBe(200);
    expect(await listIds(tg)).toEqual([second!.id]);
    expect((await confirmApp(tg, second!.id)).status).toBe(200);
    expect(await listIds(tg)).toEqual([]);

    // Новый раунд встаёт на место: заслон снова с ним.
    await tickAlerts(w.orgId, ist('2026-09-22T09:00'));
    const third = (await roundsOf(w.orgId, alert_id, w.mariaId))[2]!;
    expect(await listIds(tg)).toEqual([third.id]);
  });

  it('тревога идёт в общую очередь с обычным объявлением, а не вместо него', async () => {
    const w = await world();
    const tg = await linkTelegram(w.mariaId);
    const regular = (await inOrg(w.orgId, (db) => sendAnnouncement(db, { text: 'Правило', to: [w.mariaId] }, user(w.ownerId), ist('2026-09-21T09:00')))).announcement_id;
    const { alert_id } = await raise(w, { to: [w.mariaId] });
    const [round] = await roundsOf(w.orgId, alert_id, w.mariaId);
    expect(await listIds(tg)).toEqual([regular, round!.id]);
  });

  it('перевод текста тревоги лежит под id тревоги: раунды не переводятся заново', async () => {
    const w = await world();
    const enId = await addPerson(w.orgId, 'member', { name: 'Англичанин', language: 'en' });
    const tg = await linkTelegram(enId);
    const { alert_id } = await raise(w, { to: [enId], escalate_after_days: 30 });
    await tickAlerts(w.orgId, ist('2026-09-21T13:30'));
    await inOrg(w.orgId, (db) => db.query(
      `insert into translations(org_id, object_type, object_id, field, lang, source_hash, text)
       values (current_setting('app.org_id')::uuid, 'announcement', $1, 'text', 'en', $2, $3)`,
      [alert_id, sha256(ALERT_TEXT), 'Shipment ORD-1 has been in transit for 2 days.']));
    const r = await lists(tg);
    expect(r.body.announcements).toHaveLength(1);
    expect(r.body.announcements[0]).toMatchObject({ text: 'Shipment ORD-1 has been in transit for 2 days.', translated: true });
  });
});

// ---------------------------------------------------------------- потолки

describe('потолки: раунды не съедают объявления, у тревог свои', () => {
  it('раунды не входят в потолок объявлений организации и агента', async () => {
    const w = await world();
    // Три тревоги всем: двенадцать раундов, больше потолка в десять.
    for (const key of ['a', 'b', 'c']) await inOrg(w.orgId, (db) => raiseAlert(db, { key, text: ALERT_TEXT, to: 'all' }, user(w.ownerId)));
    expect(await count(w.orgId, 'announcements')).toBe(12);
    for (let i = 0; i < ORG_DAILY_LIMIT; i++) {
      await inOrg(w.orgId, (db) => sendAnnouncement(db, { text: `Объявление ${i}`, to: [w.mariaId] }, user(w.ownerId), new Date()));
    }
    const over = await call(w.adminId, 'send_announcement', { org: w.orgId, text: 'Одиннадцатое', to: ['Мария'], idempotency_key: uniq() });
    expect(over.data.code).toBe('limit_exceeded');
    expect(over.data.message).toMatch(/10 announcements per organization/);

    // Агент сторожа: тревога с его подписью, и всё равно три обычных объявления ему доступны.
    const w2 = await world();
    const agent = await makeAgent(w2.orgId, w2.ownerId);
    await inOrg(w2.orgId, (db) => raiseAlert(db, { key: KEY, text: ALERT_TEXT, to: 'all' }, agentActor(agent, w2.ownerId)));
    for (let i = 0; i < AGENT_DAILY_LIMIT; i++) {
      const ok = await call(w2.ownerId, 'send_announcement', { org: w2.orgId, agent, text: `От агента ${i}`, to: ['Мария'], idempotency_key: uniq() });
      expect(ok.isError, JSON.stringify(ok.data)).toBe(false);
    }
    const overAgent = await call(w2.ownerId, 'send_announcement', { org: w2.orgId, agent, text: 'Четвёртое', to: ['Мария'], idempotency_key: uniq() });
    expect(overAgent.data.code).toBe('limit_exceeded');
    expect(overAgent.data.message).toMatch(/3 announcements per agent/);
  });

  it('раунды не получают напоминаний «не подтвердил»; у обычного объявления они есть', async () => {
    const w = await world();
    const { alert_id } = await raise(w, { to: [w.mariaId] });
    await inOrg(w.orgId, (db) => sendAnnouncement(db, { text: 'Обычное', to: [w.ahmetId] }, user(w.ownerId), MON_10));
    const schedule = await inOrg(w.orgId, (db) => loadUserSchedule(db, w.mariaId));
    // 240 рабочих минут с отправки — порог первого напоминания; потом ещё день.
    await tickOrg(w.orgId, addWorkingMinutes(schedule, MON_10, 240));
    await tickOrg(w.orgId, ist('2026-09-22T09:00'));
    expect((await notes(w.orgId, 'announcement_reminder', w.ahmetId)).length).toBeGreaterThanOrEqual(1);
    expect(await notes(w.orgId, 'announcement_reminder', w.mariaId)).toHaveLength(0);
    for (const r of await roundsOf(w.orgId, alert_id, w.mariaId)) {
      const row = (await inOrg(w.orgId, (db) => db.query(
        'select reminded_count, last_reminded_at from announcement_recipients where announcement_id = $1 and user_id = $2', [r.id, w.mariaId]))).rows[0];
      expect(row).toEqual({ reminded_count: 0, last_reminded_at: null });
    }
    // Раунды при этом шли: сам повтор и есть напоминание.
    expect((await roundsOf(w.orgId, alert_id, w.mariaId)).length).toBeGreaterThanOrEqual(3);
  });

  it(`открытых тревог в организации — не больше ${ALERT_OPEN_LIMIT}; снятая место освобождает`, async () => {
    const w = await world();
    for (let i = 0; i < ALERT_OPEN_LIMIT; i++) await raise(w, { key: `k${i}`, to: [w.mariaId] });
    const over = await call(w.ownerId, 'raise_alert', { org: w.orgId, key: 'лишняя', text: ALERT_TEXT, to: ['Мария'] });
    expect(over.isError).toBe(true);
    expect(over.data.code).toBe('limit_exceeded');
    expect(await count(w.orgId, 'announcement_alerts')).toBe(ALERT_OPEN_LIMIT);
    // Повтор уже открытого ключа потолком не считается.
    expect((await call(w.ownerId, 'raise_alert', { org: w.orgId, key: 'k0', text: 'Новый текст', to: ['Мария'] })).data.created).toBe(false);

    await call(w.ownerId, 'resolve_alert', { org: w.orgId, key: 'k0' });
    // Через сутки — чтобы не упереться в суточный потолок организации, проверяемый отдельно.
    expect((await raise(w, { key: 'лишняя', to: [w.mariaId] }, w.ownerId, new Date(MON_10.getTime() + 25 * 3600e3))).created).toBe(true);
  });

  it(`новых тревог в организации — не больше ${ALERT_ORG_DAILY_LIMIT} за сутки, и от человека: подъём со снятием по кругу не обходит`, async () => {
    const w = await world();
    for (let i = 0; i < ALERT_ORG_DAILY_LIMIT; i++) {
      await raise(w, { key: `k${i}`, to: [w.mariaId] });
      await inOrg(w.orgId, (db) => resolveAlert(db, { key: `k${i}` }, user(w.ownerId), MON_10));
    }
    await expect(raise(w, { key: 'лишняя', to: [w.mariaId] })).rejects.toMatchObject({ code: 'limit_exceeded' });
    await expect(raise(w, { key: 'лишняя', to: [w.mariaId] }, w.adminId)).rejects.toMatchObject({ code: 'limit_exceeded' });
    expect((await raise(w, { key: 'лишняя', to: [w.mariaId] }, w.ownerId, new Date(MON_10.getTime() + 25 * 3600e3))).created).toBe(true);
  });

  it('текст чужой открытой тревоги не сменить — conflict; тот же текст — та же тревога', async () => {
    const w = await world();
    const first = await raise(w, { to: [w.mariaId] });
    await expect(raise(w, { text: 'Другой текст', to: [w.mariaId] }, w.adminId)).rejects.toMatchObject({ code: 'conflict' });
    expect(await raise(w, { to: [w.mariaId] }, w.adminId)).toMatchObject({ alert_id: first.alert_id, created: false });
    const text = (await inOrg(w.orgId, (db) => db.query('select text from announcement_alerts where id = $1', [first.alert_id]))).rows[0].text;
    expect(text).toBe(ALERT_TEXT);
  });

  it(`новых тревог от одного агента — не больше ${ALERT_AGENT_DAILY_LIMIT} за сутки; другой агент и человек не затронуты`, async () => {
    const w = await world();
    const agent = await makeAgent(w.orgId, w.ownerId);
    const now = new Date();
    for (let i = 0; i < ALERT_AGENT_DAILY_LIMIT; i++) {
      await inOrg(w.orgId, (db) => raiseAlert(db, { key: `k${i}`, text: ALERT_TEXT, to: [w.mariaId] }, agentActor(agent, w.ownerId), now));
      // Снятые тоже считаются: потолок на новые, а не на открытые.
      await inOrg(w.orgId, (db) => resolveAlert(db, { key: `k${i}` }, agentActor(agent, w.ownerId), now));
    }
    const over = await call(w.ownerId, 'raise_alert', { org: w.orgId, agent, key: 'лишняя', text: ALERT_TEXT, to: ['Мария'] });
    expect(over.isError).toBe(true);
    expect(over.data.code).toBe('limit_exceeded');
    expect(over.data.message).toMatch(/20 new alerts per agent/);

    const other = await makeAgent(w.orgId, w.ownerId);
    expect((await call(w.ownerId, 'raise_alert', { org: w.orgId, agent: other, key: 'лишняя', text: ALERT_TEXT, to: ['Мария'] })).isError).toBe(false);
    expect((await call(w.ownerId, 'raise_alert', { org: w.orgId, key: 'человек', text: ALERT_TEXT, to: ['Мария'] })).isError).toBe(false);
    // Через сутки агент снова может.
    await expect(inOrg(w.orgId, (db) => raiseAlert(db, { key: 'через сутки', text: ALERT_TEXT, to: [w.mariaId] }, agentActor(agent, w.ownerId), new Date(now.getTime() + 25 * 3600e3))))
      .resolves.toHaveProperty('created', true);
  });
});

// ---------------------------------------------------------------- автор

describe('автор тревоги', () => {
  it('названный в to — получает раунды; при "all" — нет', async () => {
    const w = await world();
    const named = await call(w.ownerId, 'raise_alert', { org: w.orgId, key: 'named', text: ALERT_TEXT, to: ['Олег', 'Мария'] });
    expect(named.isError, JSON.stringify(named.data)).toBe(false);
    expect(named.data.recipients.map((r: { user_id: string }) => r.user_id).sort()).toEqual([w.ownerId, w.mariaId].sort());
    expect(await roundsOf(w.orgId, named.data.alert_id, w.ownerId)).toHaveLength(1);
    expect(await notes(w.orgId, 'announcement', w.ownerId)).toHaveLength(1);
    // Следующие раунды по расписанию придут и автору.
    await tickAlerts(w.orgId, new Date(Date.now() + 7 * 86400e3));
    expect((await roundsOf(w.orgId, named.data.alert_id, w.ownerId)).length).toBeGreaterThanOrEqual(2);

    const all = await call(w.ownerId, 'raise_alert', { org: w.orgId, key: 'all', text: ALERT_TEXT, to: 'all' });
    expect(all.isError, JSON.stringify(all.data)).toBe(false);
    expect(all.data.recipients.map((r: { user_id: string }) => r.user_id).sort()).toEqual([w.adminId, w.mariaId, w.ahmetId, w.memberId].sort());
    expect(await roundsOf(w.orgId, all.data.alert_id, w.ownerId)).toHaveLength(0);

    // Подъём от агента: автор-человек тот же — названный явно получает, при "all" — нет.
    const agent = await makeAgent(w.orgId, w.ownerId);
    const viaAgentAll = await call(w.ownerId, 'raise_alert', { org: w.orgId, agent, key: 'agent-all', text: ALERT_TEXT, to: 'all' });
    expect(await roundsOf(w.orgId, viaAgentAll.data.alert_id, w.ownerId)).toHaveLength(0);
    const viaAgentNamed = await call(w.ownerId, 'raise_alert', { org: w.orgId, agent, key: 'agent-named', text: ALERT_TEXT, to: ['Олег'] });
    expect(await roundsOf(w.orgId, viaAgentNamed.data.alert_id, w.ownerId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- статус

describe('announcement_status: alerts', () => {
  it('раунды и подтверждения по получателям; раунды не засоряют список объявлений; ключ и текст под untrusted', async () => {
    const w = await world();
    const agent = await makeAgent(w.orgId, w.ownerId, 'Сторож');
    const regular = (await inOrg(w.orgId, (db) => sendAnnouncement(db, { text: 'Обычное правило', to: [w.mariaId] }, user(w.ownerId), new Date()))).announcement_id;
    const raised = await call(w.ownerId, 'raise_alert', { org: w.orgId, agent, key: KEY, text: ALERT_TEXT, to: ['Мария', 'Ахмет'] });
    const [roundOfMaria] = await roundsOf(w.orgId, raised.data.alert_id, w.mariaId);
    await inOrg(w.orgId, (db) => confirmAnnouncement(db, roundOfMaria!.id, w.mariaId, 'app'));
    const confirmedAt = (await roundsOf(w.orgId, raised.data.alert_id, w.mariaId))[0]!.confirmed_at!;

    const st = await call(w.ownerId, 'announcement_status', { org: w.orgId });
    expect(st.isError, JSON.stringify(st.data)).toBe(false);
    // В списке объявлений — только обычное, без раундов.
    expect(st.data.announcements.map((a: { id: string }) => a.id)).toEqual([regular]);
    expect(st.data.alerts).toHaveLength(1);
    const a = st.data.alerts[0];
    expect(a).toMatchObject({ id: raised.data.alert_id, status: 'open', resolved_at: null, resolved_reason: null, days_open: 0, per_day_now: 2 });
    expect(a.key).toEqual({ untrusted: true, text: KEY });
    expect(a.text).toEqual({ untrusted: true, text: ALERT_TEXT });
    expect(a.from).toEqual({ untrusted: true, text: 'Олег' });
    expect(a.via_agent).toEqual({ untrusted: true, text: 'Сторож' });
    expect(a.recipients.map((r: { name: { text: string } }) => r.name.text)).toEqual(['Ахмет', 'Мария']);
    const [ahmet, maria] = a.recipients;
    expect(maria).toMatchObject({ user_id: w.mariaId, rounds: 1, last_confirmed_via: 'app' });
    expect(new Date(maria.last_confirmed_at).getTime()).toBe(confirmedAt.getTime());
    expect(maria.last_round_at).not.toBeNull();
    expect(ahmet).toMatchObject({ user_id: w.ahmetId, rounds: 1, last_confirmed_at: null, last_confirmed_via: null });
  });

  it('закрытая тревога видна неделю, с причиной; старше — уходит; рядовой статус не видит', async () => {
    const w = await world();
    const raised = await call(w.ownerId, 'raise_alert', { org: w.orgId, key: KEY, text: ALERT_TEXT, to: ['Мария'] });
    await call(w.ownerId, 'resolve_alert', { org: w.orgId, key: KEY, reason: 'этап сдвинулся' });
    const st = await call(w.adminId, 'announcement_status', { org: w.orgId });
    expect(st.data.alerts).toHaveLength(1);
    expect(st.data.alerts[0]).toMatchObject({ id: raised.data.alert_id, status: 'resolved', per_day_now: 0 });
    expect(st.data.alerts[0].resolved_at).not.toBeNull();
    expect(st.data.alerts[0].resolved_reason).toEqual({ untrusted: true, text: 'этап сдвинулся' });

    await inOrg(w.orgId, (db) => db.query(`update announcement_alerts set resolved_at = now() - interval '8 days' where id = $1`, [raised.data.alert_id]));
    expect((await call(w.ownerId, 'announcement_status', { org: w.orgId })).data.alerts).toEqual([]);

    expect((await call(w.memberId, 'announcement_status', { org: w.orgId })).data.code).toBe('forbidden');
  });
});

// ---------------------------------------------------------------- база

describe('база: тревогу и получателя не удалить, ключ открытой уникален', () => {
  it('приложение не может delete из announcement_alerts и announcement_alert_recipients', async () => {
    const w = await world();
    const { alert_id } = await raise(w, { to: [w.mariaId] });
    await expect(inOrg(w.orgId, (db) => db.query('delete from announcement_alerts where id = $1', [alert_id]))).rejects.toThrow(/permission denied/);
    await expect(inOrg(w.orgId, (db) => db.query('delete from announcement_alert_recipients where alert_id = $1', [alert_id]))).rejects.toThrow(/permission denied/);
    expect(await count(w.orgId, 'announcement_alerts')).toBe(1);
    expect(await count(w.orgId, 'announcement_alert_recipients')).toBe(1);
    // Закрывать можно: update разрешён.
    await inOrg(w.orgId, (db) => db.query('update announcement_alerts set resolved_at = now() where id = $1', [alert_id]));
  });

  it('второй открытый с тем же ключом — ошибка уникальности; после закрытия ключ свободен; ключ другой организации не мешает', async () => {
    const w = await world();
    const { alert_id } = await raise(w, { to: [w.mariaId] });
    const insert = (org: string, key: string, resolved: boolean) => inOrg(org, (db) => db.query(
      `insert into announcement_alerts(org_id, key, author_user_id, text, resolved_at)
       values (current_setting('app.org_id')::uuid, $1, $2, 'текст', ${resolved ? 'now()' : 'null'})`, [key, w.ownerId]));
    await expect(insert(w.orgId, KEY, false)).rejects.toThrow(/announcement_alerts_open_key|duplicate key/);
    // Закрытые с тем же ключом копятся свободно.
    await insert(w.orgId, KEY, true);
    await insert(w.orgId, KEY, true);

    const other = await world();
    await insert(other.orgId, KEY, false);

    await inOrg(w.orgId, (db) => db.query('update announcement_alerts set resolved_at = now() where id = $1', [alert_id]));
    await insert(w.orgId, KEY, false);
  });

  it('тревога видна только своей организации', async () => {
    const a = await world();
    const b = await world();
    const { alert_id } = await raise(a, { to: [a.mariaId] });
    expect((await inOrg(b.orgId, (db) => db.query('select id from announcement_alerts where id = $1', [alert_id]))).rowCount).toBe(0);
    expect((await inOrg(b.orgId, (db) => db.query('select 1 from announcement_alert_recipients where alert_id = $1', [alert_id]))).rowCount).toBe(0);
  });
});

// ---------------------------------------------------------------- каталог и навык

describe('каталог инструментов и навык', () => {
  it('инструментов 62; raise_alert и resolve_alert зарегистрированы; навык описывает тревогу', () => {
    const names = new Set<string>();
    for (const f of readdirSync('src/mcp/tools')) {
      for (const m of readFileSync(join('src/mcp/tools', f), 'utf8').matchAll(/registerTool\(\s*'([a-z_]+)'/g)) names.add(m[1]!);
    }
    expect(names.size).toBe(62);
    expect(names.has('raise_alert') && names.has('resolve_alert')).toBe(true);

    const assigning = readFileSync('skill/skills/taskano/assigning.md', 'utf8');
    expect(assigning).toMatch(/## Announcement or task[\s\S]*`raise_alert`[\s\S]*`resolve_alert`[\s\S]*## From vague to checkable/);
    expect(assigning).toMatch(/does not stop an alert/);
    expect(readFileSync('src/web/site/docs.html', 'utf8')).toMatch(/Announcements<\/td>[^\n]*<code>raise_alert<\/code>[^\n]*<code>resolve_alert<\/code>/);
    expect(readFileSync('src/worker/tick.ts', 'utf8')).toContain('runAlertRounds');
  });
});
