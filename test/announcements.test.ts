process.env.TASKANO_DISABLE_RATE_LIMIT = '1';

import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Update, UserFromGetMe } from 'grammy/types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closePools, withGlobal, withSystem } from '../src/db/pool.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { confirmAnnouncement, sendAnnouncement } from '../src/core/announcements.js';
import { addMember } from '../src/core/people.js';
import { createProject } from '../src/core/projects.js';
import { offboardPerson } from '../src/core/invitations.js';
import { addWorkingMinutes, loadUserSchedule } from '../src/core/calendar.js';
import { sha256 } from '../src/core/crypto.js';
import { tickOrg } from '../src/worker/tick.js';
import { createBot } from '../src/bot/bot.js';
import { encodeAnnouncement } from '../src/bot/callbacks.js';
import { miniappRoutes } from '../src/web/miniapp-api.js';
import { t } from '../src/i18n/index.js';
import { addPerson, inOrg, makeAgent, makeOrg, makeUser, MON_10, minutes, uniq } from './helpers.js';

// Спека announcements: объявление людям с подтверждением «Прочёл, подтверждаю» — отдельно
// от задач. Все пункты идут живым путём: коннектор (MCP-клиент), бот (handleUpdate + тик с доставкой),
// Mini App (supertest по miniappRoutes), тик организации.

// Перевод в фоне: подмена только записывает вызовы и зовёт настоящую функцию. Нужна, чтобы увидеть, греет ли
// отправка перевод после коммита и не ждёт ли модель `GET /lists`.
const warmCalls = vi.hoisted(() => ({ list: [] as { orgId: string; inputs: { objectType: string; objectId: string; targetLang: string }[] }[] }));
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

/** Олег (владелец) объявляет; Админ, Мария, Ахмет и Рядовой — участники той же компании. */
async function world() {
  const ownerId = await makeUser({ name: 'Олег' });
  const { orgId } = await makeOrg(ownerId);
  const adminId = await addPerson(orgId, 'admin', { name: 'Админ' });
  const mariaId = await addPerson(orgId, 'member', { name: 'Мария' });
  const ahmetId = await addPerson(orgId, 'member', { name: 'Ахмет' });
  const memberId = await addPerson(orgId, 'member', { name: 'Рядовой' });
  return { orgId, ownerId, adminId, mariaId, ahmetId, memberId };
}

const TEXT = 'С понедельника отгрузка до 15:00. Заявки после — на следующий день.';

/** Отправка ядром с заданным временем — для таймеров, которым нужен «понедельник, 10:00». */
async function send(orgId: string, from: string, to: 'all' | string[], text = TEXT, now = MON_10): Promise<string> {
  return (await inOrg(orgId, (db) => sendAnnouncement(db, { text, to }, user(from), now))).announcement_id;
}

async function recipientRow(orgId: string, announcementId: string, userId: string) {
  return (await inOrg(orgId, (db) => db.query(
    'select confirmed_at, confirmed_via, reminded_count, last_reminded_at from announcement_recipients where announcement_id = $1 and user_id = $2',
    [announcementId, userId]))).rows[0] as { confirmed_at: Date | null; confirmed_via: string | null; reminded_count: number; last_reminded_at: Date | null } | undefined;
}

async function notes(orgId: string, kind: string, userId: string) {
  return (await inOrg(orgId, (db) => db.query(
    `select id, payload, delivered_at, deliver_after from notifications where kind = $1 and user_id = $2 order by created_at`,
    [kind, userId]))).rows as { id: string; payload: { announcement_id: string }; delivered_at: Date | null; deliver_after: Date }[];
}

// ---------------------------------------------------------------- отправка

describe('send_announcement', () => {
  it('владелец и админ — создают объявление и уведомления; агент владельца и агент админа — тоже', async () => {
    const w = await world();
    const byOwner = await call(w.ownerId, 'send_announcement', { org: w.orgId, text: TEXT, to: ['Мария', 'Ахмет'], idempotency_key: uniq() });
    expect(byOwner.isError, JSON.stringify(byOwner.data)).toBe(false);
    expect(byOwner.data.recipients.map((r: { name: { text: string } }) => r.name.text).sort()).toEqual(['Ахмет', 'Мария']);
    const row = (await inOrg(w.orgId, (db) => db.query('select author_user_id, author_agent_id, text, to_all from announcements where id = $1', [byOwner.data.announcement_id]))).rows[0];
    expect(row).toMatchObject({ author_user_id: w.ownerId, author_agent_id: null, text: TEXT, to_all: false });
    expect(await notes(w.orgId, 'announcement', w.mariaId)).toHaveLength(1);
    expect(await notes(w.orgId, 'announcement', w.ahmetId)).toHaveLength(1);
    expect(await notes(w.orgId, 'announcement', w.memberId)).toHaveLength(0);
    expect((await recipientRow(w.orgId, byOwner.data.announcement_id, w.mariaId))!.confirmed_at).toBeNull();

    const byAdmin = await call(w.adminId, 'send_announcement', { org: w.orgId, text: 'Правило от админа', to: ['Мария'], idempotency_key: uniq() });
    expect(byAdmin.isError, JSON.stringify(byAdmin.data)).toBe(false);

    const ownerAgent = await makeAgent(w.orgId, w.ownerId);
    const viaOwnerAgent = await call(w.ownerId, 'send_announcement', { org: w.orgId, agent: ownerAgent, text: 'От агента владельца', to: ['Ахмет'], idempotency_key: uniq() });
    expect(viaOwnerAgent.isError, JSON.stringify(viaOwnerAgent.data)).toBe(false);
    const agentRow = (await inOrg(w.orgId, (db) => db.query('select author_user_id, author_agent_id from announcements where id = $1', [viaOwnerAgent.data.announcement_id]))).rows[0];
    expect(agentRow).toMatchObject({ author_user_id: w.ownerId, author_agent_id: ownerAgent });

    // Автор-человек не получатель и тогда, когда объявляет его агент.
    const toAll = await call(w.ownerId, 'send_announcement', { org: w.orgId, agent: ownerAgent, text: 'Всем от агента', to: 'all', idempotency_key: uniq() });
    expect(toAll.isError, JSON.stringify(toAll.data)).toBe(false);
    expect(toAll.data.recipients.map((x: { user_id: string }) => x.user_id).sort()).toEqual([w.adminId, w.mariaId, w.ahmetId, w.memberId].sort());
    expect((await call(w.ownerId, 'send_announcement', { org: w.orgId, agent: ownerAgent, text: 'Себе', to: ['Олег'], idempotency_key: uniq() })).data.code).toBe('validation_failed');

    const adminAgent = await makeAgent(w.orgId, w.adminId);
    expect((await call(w.adminId, 'send_announcement', { org: w.orgId, agent: adminAgent, text: 'От агента админа', to: ['Ахмет'], idempotency_key: uniq() })).isError).toBe(false);
  });

  it('рядовой участник и его агент — forbidden, ничего не записано', async () => {
    const w = await world();
    const denied = await call(w.memberId, 'send_announcement', { org: w.orgId, text: TEXT, to: ['Мария'], idempotency_key: uniq() });
    expect(denied.isError).toBe(true);
    expect(denied.data.code).toBe('forbidden');
    const memberAgent = await makeAgent(w.orgId, w.memberId);
    const viaAgent = await call(w.memberId, 'send_announcement', { org: w.orgId, agent: memberAgent, text: TEXT, to: 'all', idempotency_key: uniq() });
    expect(viaAgent.isError).toBe(true);
    expect(viaAgent.data.code).toBe('forbidden');
    expect((await inOrg(w.orgId, (db) => db.query('select count(*)::int as n from announcements'))).rows[0].n).toBe(0);
    expect((await inOrg(w.orgId, (db) => db.query(`select count(*)::int as n from notifications where kind = 'announcement'`))).rows[0].n).toBe(0);
  });

  it('to: "all" — все активные участники, кроме отправителя; приглашённые и выведенные не получают', async () => {
    const w = await world();
    const invitedId = await addPerson(w.orgId, 'member', { name: 'Приглашённый' });
    await withGlobal((db) => db.query(`update memberships set status = 'invited' where org_id = $1 and user_id = $2`, [w.orgId, invitedId]));
    const goneId = await addPerson(w.orgId, 'member', { name: 'Вышедший' });
    await withGlobal((db) => db.query(`update memberships set status = 'removed' where org_id = $1 and user_id = $2`, [w.orgId, goneId]));

    const r = await call(w.ownerId, 'send_announcement', { org: w.orgId, text: TEXT, to: 'all', idempotency_key: uniq() });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(r.data.recipients.map((x: { user_id: string }) => x.user_id).sort())
      .toEqual([w.adminId, w.mariaId, w.ahmetId, w.memberId].sort());
    const stored = (await inOrg(w.orgId, (db) => db.query('select user_id from announcement_recipients where announcement_id = $1', [r.data.announcement_id]))).rows;
    expect(stored.map((x) => x.user_id).sort()).toEqual([w.adminId, w.mariaId, w.ahmetId, w.memberId].sort());
    expect((await inOrg(w.orgId, (db) => db.query('select to_all from announcements where id = $1', [r.data.announcement_id]))).rows[0].to_all).toBe(true);

    // Список зафиксирован в момент отправки: пришедший позже объявления не получает.
    const lateId = await addPerson(w.orgId, 'member', { name: 'Опоздавший' });
    expect(await recipientRow(w.orgId, r.data.announcement_id, lateId)).toBeUndefined();
    expect(await notes(w.orgId, 'announcement', lateId)).toHaveLength(0);
  });

  it('себя в списке получателей не оставляет; пусто, чужой, приглашённый и незнакомый — отказ', async () => {
    const w = await world();
    const withSelf = await call(w.ownerId, 'send_announcement', { org: w.orgId, text: TEXT, to: ['Олег', 'Мария'], idempotency_key: uniq() });
    expect(withSelf.isError, JSON.stringify(withSelf.data)).toBe(false);
    expect(withSelf.data.recipients).toHaveLength(1);

    const onlySelf = await call(w.ownerId, 'send_announcement', { org: w.orgId, text: TEXT, to: ['Олег'], idempotency_key: uniq() });
    expect(onlySelf.data.code).toBe('validation_failed');

    const invitedId = await addPerson(w.orgId, 'member', { name: 'Ожидающий' });
    await withGlobal((db) => db.query(`update memberships set status = 'invited' where org_id = $1 and user_id = $2`, [w.orgId, invitedId]));
    expect((await call(w.ownerId, 'send_announcement', { org: w.orgId, text: TEXT, to: ['Ожидающий'], idempotency_key: uniq() })).data.code).toBe('validation_failed');
    expect((await call(w.ownerId, 'send_announcement', { org: w.orgId, text: TEXT, to: ['Никто-Такой'], idempotency_key: uniq() })).data.code).toBe('not_found');
  });

  it('текст — от 1 до 2000 знаков', async () => {
    const w = await world();
    const empty = await call(w.ownerId, 'send_announcement', { org: w.orgId, text: '', to: 'all', idempotency_key: uniq() });
    expect(empty.isError).toBe(true);
    const spaces = await call(w.ownerId, 'send_announcement', { org: w.orgId, text: '   ', to: 'all', idempotency_key: uniq() });
    expect(spaces.isError).toBe(true);
    const long = await call(w.ownerId, 'send_announcement', { org: w.orgId, text: 'я'.repeat(2001), to: 'all', idempotency_key: uniq() });
    expect(long.isError).toBe(true);
    // Предел держит и ядро, не только схема коннектора.
    await expect(inOrg(w.orgId, (db) => sendAnnouncement(db, { text: 'я'.repeat(2001), to: 'all' }, user(w.ownerId)))).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(inOrg(w.orgId, (db) => sendAnnouncement(db, { text: '  ', to: 'all' }, user(w.ownerId)))).rejects.toMatchObject({ code: 'validation_failed' });
    const exact = await call(w.ownerId, 'send_announcement', { org: w.orgId, text: 'я'.repeat(2000), to: 'all', idempotency_key: uniq() });
    expect(exact.isError, JSON.stringify(exact.data)).toBe(false);
  });

  it('два вызова с одним idempotency_key — одно объявление', async () => {
    const w = await world();
    const key = uniq();
    const args = { org: w.orgId, text: TEXT, to: ['Мария'], idempotency_key: key };
    const first = await call(w.ownerId, 'send_announcement', args);
    const second = await call(w.ownerId, 'send_announcement', args);
    expect(second.isError, JSON.stringify(second.data)).toBe(false);
    expect(second.data.announcement_id).toBe(first.data.announcement_id);
    expect((await inOrg(w.orgId, (db) => db.query('select count(*)::int as n from announcements'))).rows[0].n).toBe(1);
    expect(await notes(w.orgId, 'announcement', w.mariaId)).toHaveLength(1);
  });

  it('в личном пространстве — отказ', async () => {
    const w = await world();
    const r = await call(w.ownerId, 'send_announcement', { org: 'personal', text: TEXT, to: 'all', idempotency_key: uniq() });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe('validation_failed');
    // После переезда на проекты «личное» — закрытая доска внутри компании: `org: "personal"` ведёт в
    // саму компанию, и отказ обязан держать инструмент, а не вид организации.
    await inOrg(w.orgId, (db) => createProject(db, { name: 'Личное', private: true }, user(w.ownerId)), w.ownerId);
    const board = await call(w.ownerId, 'send_announcement', { org: 'personal', text: TEXT, to: 'all', idempotency_key: uniq() });
    expect(board.isError).toBe(true);
    expect(board.data.code).toBe('validation_failed');
    expect((await inOrg(w.orgId, (db) => db.query('select count(*)::int as n from announcements'))).rows[0].n).toBe(0);
    // И ядро не берётся за личную организацию, как бы к ней ни пришли.
    const personalOrg = (await withGlobal((db) => db.query(`select id from orgs where owner_user_id = $1 and kind = 'personal'`, [w.ownerId]))).rows[0].id as string;
    await expect(inOrg(personalOrg, (db) => sendAnnouncement(db, { text: TEXT, to: 'all' }, user(w.ownerId)))).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

// ---------------------------------------------------------------- бот

const BOT_INFO: UserFromGetMe = {
  id: 10, is_bot: true, first_name: 'Taskano', username: 'taskano_test_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
  allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
};

type Sent = { method: string; payload: Record<string, any> };
let sent: Sent[];
let bot: ReturnType<typeof createBot>;
let nextUpdateId = 1;
let nextMessageId = 1;
let nextTgId = 7_900_000 + Math.floor(Math.random() * 100_000);

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

function callback(tgId: number, data: string, text: string): Update {
  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: String(nextUpdateId), from: { id: tgId, is_bot: false, first_name: 'Person', language_code: 'ru' }, chat_instance: 'x', data,
      message: { message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: tgId, type: 'private', first_name: 'Person' }, text },
    },
  } as unknown as Update;
}

const messagesTo = (tg: number): Sent[] => sent.filter((s) => s.method === 'sendMessage' && s.payload.chat_id === tg);

describe('бот: кнопка «Прочёл, подтверждаю»', () => {
  it('уведомление приходит с одной кнопкой; нажатие пишет confirmed_at и via = bot; текст остаётся, кнопка уходит; повтор время не меняет', async () => {
    const w = await world();
    const tg = await linkTelegram(w.mariaId);
    const id = await send(w.orgId, w.ownerId, [w.mariaId]);
    await tickOrg(w.orgId, MON_10);

    const msg = messagesTo(tg);
    expect(msg).toHaveLength(1);
    expect(msg[0]!.payload.text).toContain('Объявление от Олег');
    expect(msg[0]!.payload.text).toContain(TEXT);
    const buttons = msg[0]!.payload.reply_markup.inline_keyboard.flat();
    expect(buttons).toEqual([{ text: t('ru', 'btn.announcement_confirm'), callback_data: encodeAnnouncement(id) }]);
    expect(buttons[0].text).toBe('Прочёл, подтверждаю');
    expect((await recipientRow(w.orgId, id, w.mariaId))!.confirmed_at).toBeNull();

    await bot.handleUpdate(callback(tg, encodeAnnouncement(id), msg[0]!.payload.text));
    const row = await recipientRow(w.orgId, id, w.mariaId);
    expect(row!.confirmed_at).not.toBeNull();
    expect(row!.confirmed_via).toBe('bot');
    const edit = sent.filter((s) => s.method === 'editMessageText');
    expect(edit).toHaveLength(1);
    // Текст остаётся, кнопка уходит, внизу время подтверждения.
    expect(edit[0]!.payload.text.startsWith(msg[0]!.payload.text)).toBe(true);
    expect(edit[0]!.payload.text).toMatch(/Подтверждено .*\d{2}:\d{2}$/);
    expect(edit[0]!.payload.reply_markup.inline_keyboard).toEqual([]);

    // Повторное нажатие (старое сообщение, второе устройство) время не трогает.
    const firstAt = row!.confirmed_at!.getTime();
    await new Promise((r) => setTimeout(r, 15));
    await bot.handleUpdate(callback(tg, encodeAnnouncement(id), msg[0]!.payload.text));
    const again = await recipientRow(w.orgId, id, w.mariaId);
    expect(again!.confirmed_at!.getTime()).toBe(firstAt);
    expect(again!.confirmed_via).toBe('bot');
    expect(sent.filter((s) => s.method === 'editMessageText')[1]!.payload.text).toBe(edit[0]!.payload.text);
  });

  it('текст объявления в боте экранируется как HTML', async () => {
    const w = await world();
    const tg = await linkTelegram(w.mariaId);
    await send(w.orgId, w.ownerId, [w.mariaId], '<b>не жирный</b> & <i>x</i>');
    await tickOrg(w.orgId, MON_10);
    const text = messagesTo(tg)[0]!.payload.text as string;
    expect(text).toContain('&lt;b&gt;не жирный&lt;/b&gt; &amp; &lt;i&gt;x&lt;/i&gt;');
    expect(text).not.toContain('<b>не жирный</b>');
    expect(messagesTo(tg)[0]!.payload.parse_mode).toBe('HTML');
  });

  it('чужое объявление кнопкой не подтвердить: отказ, запись не создана', async () => {
    const w = await world();
    const id = await send(w.orgId, w.ownerId, [w.mariaId]);
    const strangerTg = await linkTelegram(w.ahmetId);
    await bot.handleUpdate(callback(strangerTg, encodeAnnouncement(id), 'x'));
    expect(sent.some((s) => s.method === 'sendMessage' && s.payload.text === t('ru', 'announcement.not_found'))).toBe(true);
    expect(await recipientRow(w.orgId, id, w.ahmetId)).toBeUndefined();
    expect((await recipientRow(w.orgId, id, w.mariaId))!.confirmed_at).toBeNull();
  });

  it('текст приходит на языке получателя из кэша перевода', async () => {
    const w = await world();
    const enId = await addPerson(w.orgId, 'member', { name: 'Англичанин', language: 'en' });
    const tg = await linkTelegram(enId);
    const id = await send(w.orgId, w.ownerId, [enId]);
    await inOrg(w.orgId, (db) => db.query(
      `insert into translations(org_id, object_type, object_id, field, lang, source_hash, text)
       values (current_setting('app.org_id')::uuid, 'announcement', $1, 'text', 'en', $2, $3)`,
      [id, sha256(TEXT), 'From Monday shipping goes out before 15:00.']));
    await tickOrg(w.orgId, MON_10);
    const text = messagesTo(tg)[0]!.payload.text as string;
    expect(text).toContain('Announcement from Олег');
    expect(text).toContain('From Monday shipping goes out before 15:00.');
    expect(text).not.toContain('отгрузка');
    expect(messagesTo(tg)[0]!.payload.reply_markup.inline_keyboard.flat()[0].text).toBe(t('en', 'btn.announcement_confirm'));
  });
});

// ---------------------------------------------------------------- база

describe('база: подтверждение неизменно', () => {
  it('confirmed_at и confirmed_via после подтверждения не изменить; получателя не удалить; reminded_count менять можно', async () => {
    const w = await world();
    const id = await send(w.orgId, w.ownerId, [w.mariaId, w.ahmetId]);
    await inOrg(w.orgId, (db) => confirmAnnouncement(db, id, w.mariaId, 'app'));

    await expect(inOrg(w.orgId, (db) => db.query(
      `update announcement_recipients set confirmed_at = now() - interval '1 day' where announcement_id = $1 and user_id = $2`, [id, w.mariaId])))
      .rejects.toThrow(/confirmation cannot be changed/);
    await expect(inOrg(w.orgId, (db) => db.query(
      `update announcement_recipients set confirmed_at = null, confirmed_via = null where announcement_id = $1 and user_id = $2`, [id, w.mariaId])))
      .rejects.toThrow(/confirmation cannot be changed/);
    await expect(inOrg(w.orgId, (db) => db.query(
      `update announcement_recipients set confirmed_via = 'bot' where announcement_id = $1 and user_id = $2`, [id, w.mariaId])))
      .rejects.toThrow(/confirmation cannot be changed/);
    // Получатель — часть свидетельства «кому объявлено»: его не вычеркнуть, подтвердил он или нет.
    // Приложению удаление не выдано вовсе, а роли с правом удаления — триггер.
    const del = (userId: string) => withSystem((db) => db.query(
      'delete from announcement_recipients where announcement_id = $1 and user_id = $2', [id, userId]));
    await expect(del(w.mariaId)).rejects.toThrow(/cannot be removed/);
    await expect(del(w.ahmetId)).rejects.toThrow(/cannot be removed/);
    await expect(inOrg(w.orgId, (db) => db.query(
      'delete from announcement_recipients where announcement_id = $1 and user_id = $2', [id, w.ahmetId]))).rejects.toThrow(/permission denied/);
    // Триггер держит и роль с правом записи: подтверждение не переписать и ей.
    await expect(withSystem((db) => db.query(
      `update announcement_recipients set confirmed_at = now() - interval '1 day' where announcement_id = $1 and user_id = $2`, [id, w.mariaId])))
      .rejects.toThrow(/confirmation cannot be changed/);

    const row = await recipientRow(w.orgId, id, w.mariaId);
    expect(row!.confirmed_via).toBe('app');
    expect(row!.confirmed_at).not.toBeNull();
    await inOrg(w.orgId, (db) => db.query(
      'update announcement_recipients set reminded_count = 2 where announcement_id = $1 and user_id = $2', [id, w.mariaId]));
    expect((await recipientRow(w.orgId, id, w.mariaId))!.reminded_count).toBe(2);
  });

  it('удаление организации каскадом проходит: исчезают объявления и получатели', async () => {
    const w = await world();
    const id = await send(w.orgId, w.ownerId, [w.mariaId]);
    await inOrg(w.orgId, (db) => confirmAnnouncement(db, id, w.mariaId, 'bot'));
    await withSystem((db) => db.query('delete from orgs where id = $1', [w.orgId]));
    const left = await withSystem((db) => db.query(
      'select (select count(*) from announcements where org_id = $1)::int as a, (select count(*) from announcement_recipients where org_id = $1)::int as r', [w.orgId]));
    expect(left.rows[0]).toEqual({ a: 0, r: 0 });
  });

  it('приложение не правит и не удаляет объявления', async () => {
    const w = await world();
    const id = await send(w.orgId, w.ownerId, [w.mariaId]);
    await expect(inOrg(w.orgId, (db) => db.query(`update announcements set text = 'другой' where id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(inOrg(w.orgId, (db) => db.query('delete from announcements where id = $1', [id]))).rejects.toThrow(/permission denied/);
  });

  it('объявление чужой организации не видно (RLS)', async () => {
    const a = await world();
    const b = await world();
    const id = await send(a.orgId, a.ownerId, [a.mariaId]);
    const seen = await inOrg(b.orgId, (db) => db.query('select id from announcements where id = $1', [id]));
    expect(seen.rowCount).toBe(0);
    const seenRec = await inOrg(b.orgId, (db) => db.query('select 1 from announcement_recipients where announcement_id = $1', [id]));
    expect(seenRec.rowCount).toBe(0);
  });
});

// ---------------------------------------------------------------- приложение

const BOT_TOKEN = 'test-bot-token-announcements';
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
const confirmApp = (tg: number, id: string) => request(app).post(`/app/api/announcements/${id}/confirm`).set('X-Telegram-Init-Data', initData(tg));

describe('приложение: заслон', () => {
  it('/lists отдаёт неподтверждённые объявления, старые первыми, из всех компаний; подтверждение ставит via = app; после — пусто; чужое — 404', async () => {
    const w = await world();
    const second = await world();
    await withGlobal((db) => addMember(db, second.orgId, w.mariaId, 'member'));
    const tg = await linkTelegram(w.mariaId);

    const later = await send(second.orgId, second.ownerId, [w.mariaId], 'Второе: склад закрыт в пятницу', minutes(MON_10, 60));
    const earlier = await send(w.orgId, w.ownerId, [w.mariaId], 'Первое: отгрузка до 15:00', MON_10);
    // Объявление другой организации, где её нет в получателях, не видно.
    await send(w.orgId, w.ownerId, [w.ahmetId], 'Не про Марию');

    const r = await lists(tg);
    expect(r.status).toBe(200);
    expect(r.body.announcements.map((a: { id: string }) => a.id)).toEqual([earlier, later]);
    expect(r.body.announcements[0]).toMatchObject({
      id: earlier, org_id: w.orgId, from: 'Олег', text: 'Первое: отгрузка до 15:00', translated: false, sent_at: MON_10.toISOString(),
    });
    expect(r.body.announcements[1]).toMatchObject({ id: later, org_id: second.orgId });

    // Чужое объявление — 404, ничего не записано. Не-получатель и несуществующее id неотличимы.
    const strangerTg = await linkTelegram(w.ahmetId);
    expect((await confirmApp(strangerTg, earlier)).status).toBe(404);
    expect((await confirmApp(strangerTg, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await confirmApp(tg, 'не-uuid')).status).toBe(404);
    expect((await recipientRow(w.orgId, earlier, w.mariaId))!.confirmed_at).toBeNull();

    const ok = await confirmApp(tg, earlier);
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    const row = await recipientRow(w.orgId, earlier, w.mariaId);
    expect(row!.confirmed_via).toBe('app');
    expect(new Date(ok.body.confirmed_at).getTime()).toBe(row!.confirmed_at!.getTime());

    expect((await lists(tg)).body.announcements.map((a: { id: string }) => a.id)).toEqual([later]);
    // Повтор идемпотентен: время прежнее.
    const repeat = await confirmApp(tg, earlier);
    expect(repeat.status).toBe(200);
    expect(repeat.body.confirmed_at).toBe(ok.body.confirmed_at);
    expect((await confirmApp(tg, later)).status).toBe(200);
    expect((await lists(tg)).body.announcements).toEqual([]);
  });

  it('подтверждённое в боте из списка пропадает; текст на языке человека — из кэша перевода', async () => {
    const w = await world();
    const enId = await addPerson(w.orgId, 'member', { name: 'Англичанин', language: 'en' });
    const tg = await linkTelegram(enId);
    const id = await send(w.orgId, w.ownerId, [enId]);
    await inOrg(w.orgId, (db) => db.query(
      `insert into translations(org_id, object_type, object_id, field, lang, source_hash, text)
       values (current_setting('app.org_id')::uuid, 'announcement', $1, 'text', 'en', $2, $3)`,
      [id, sha256(TEXT), 'From Monday shipping goes out before 15:00.']));
    const r = await lists(tg);
    expect(r.body.announcements[0]).toMatchObject({ id, text: 'From Monday shipping goes out before 15:00.', translated: true });

    await inOrg(w.orgId, (db) => confirmAnnouncement(db, id, enId, 'bot'));
    expect((await lists(tg)).body.announcements).toEqual([]);
  });

  it('вышедшему из компании заслон не показывается и подтвердить прежнюю компанию нечем', async () => {
    const w = await world();
    const tg = await linkTelegram(w.mariaId);
    const id = await send(w.orgId, w.ownerId, [w.mariaId]);
    expect((await lists(tg)).body.announcements).toHaveLength(1);
    await inOrg(w.orgId, (db) => offboardPerson(db, w.mariaId, user(w.ownerId)));
    const after = await lists(tg);
    expect(after.status).toBe(200);
    expect(after.body.announcements).toEqual([]);
    expect((await confirmApp(tg, id)).status).toBe(404);
  });

  it('заслон лежит над любым экраном, его не закрыть «Назад» и без галочки; текст — не разметка', () => {
    const appSrc = readFileSync('app/src/App.tsx', 'utf8');
    const gateSrc = readFileSync('app/src/AnnouncementGate.tsx', 'utf8');
    // Заслон — в обёртке App, а не в ветках AppScreens с ранними выходами.
    const wrapper = appSrc.slice(appSrc.indexOf('export function App()'));
    expect(wrapper).toMatch(/\{current && \(\s*<AnnouncementGate/);
    expect(appSrc.slice(0, appSrc.indexOf('export function App()'))).not.toContain('<AnnouncementGate');
    // Пока заслон есть, «Назад» Telegram отключена и карточку под ним не закрывает.
    expect(appSrc).toMatch(/if \(!cardOpen \|\| blocked\) \{ back\.hide\(\); return; \}/);
    // Заслон закрывает экран по логике очереди, а не по константе; список с сервера питает очередь.
    expect(wrapper).toMatch(/<AppScreens onAnnouncements=\{onAnnouncements\} blocked=\{isBlocking\(gate\)\} \/>/);
    expect(appSrc).toMatch(/onAnnouncements\(data\.announcements \?\? \[\], data\.lang\)/);
    // OK неактивна без галочки (логика в announcement-gate.ts), галочка снята вначале; 404 снимает объявление из очереди.
    expect(gateSrc).toMatch(/useState\(INITIAL_CHECKED\)/);
    expect(gateSrc).toMatch(/disabled=\{!canConfirm\(checked, busy\)\}/);
    expect(gateSrc).toMatch(/if \(!canConfirm\(checked, busy\)\) return;/);
    expect(gateSrc).toMatch(/e instanceof ApiError && e\.status === 404\) props\.onConfirmed\(props\.item\.id\)/);
    expect(gateSrc).not.toMatch(/BackButton|dangerouslySetInnerHTML|innerHTML|onClose/);
    // Тексты заслона — на всех четырёх языках приложения.
    const i18n = readFileSync('app/src/i18n.ts', 'utf8');
    for (const key of ['announcement_title', 'announcement_from', 'announcement_progress', 'announcement_check', 'announcement_ok']) {
      expect(i18n.split(`${key}:`).length - 1, key).toBe(4);
    }
    // Заслон выше просмотра фото (z-index 100).
    expect(readFileSync('app/src/styles.css', 'utf8')).toMatch(/\.announcement-gate \{[^}]*z-index: 200/);
  });
});

// ---------------------------------------------------------------- напоминания

/** Тик организации на рабочей минуте получателя с отправки (понедельник 10:00 + N рабочих минут). */
async function tickAt(orgId: string, userId: string, workingMinutes: number): Promise<Date> {
  const schedule = await inOrg(orgId, (db) => loadUserSchedule(db, userId));
  const at = addWorkingMinutes(schedule, MON_10, workingMinutes);
  await tickOrg(orgId, at);
  return at;
}

const remindersOf = async (orgId: string, userId: string) => (await notes(orgId, 'announcement_reminder', userId)).length;

describe('напоминания', () => {
  it('239 рабочих минут — нет, 240 — есть; тот же тик повторно второе не создаёт', async () => {
    const w = await world();
    const id = await send(w.orgId, w.ownerId, [w.mariaId]);
    await tickAt(w.orgId, w.mariaId, 239);
    expect(await remindersOf(w.orgId, w.mariaId)).toBe(0);
    expect((await recipientRow(w.orgId, id, w.mariaId))!.reminded_count).toBe(0);

    const at = await tickAt(w.orgId, w.mariaId, 240);
    expect(await remindersOf(w.orgId, w.mariaId)).toBe(1);
    const row = await recipientRow(w.orgId, id, w.mariaId);
    expect(row!.reminded_count).toBe(1);
    expect(row!.last_reminded_at!.getTime()).toBe(at.getTime());
    const rem = (await notes(w.orgId, 'announcement_reminder', w.mariaId))[0]!;
    expect(rem.payload.announcement_id).toBe(id);

    // Тот же день позже и тот же момент ещё раз — второго напоминания нет.
    await tickOrg(w.orgId, at);
    await tickAt(w.orgId, w.mariaId, 400);
    expect(await remindersOf(w.orgId, w.mariaId)).toBe(1);
  });

  it('рабочие минуты получателя, а не часы на стене: объявление в нерабочее время считается с начала рабочего дня', async () => {
    const w = await world();
    // Воскресенье 20:00 по Стамбулу: рабочие минуты пойдут с понедельника 09:00.
    const sunday = new Date('2026-09-20T17:00:00Z');
    await send(w.orgId, w.ownerId, [w.mariaId], TEXT, sunday);
    await tickOrg(w.orgId, new Date('2026-09-21T09:59:00Z')); // пн 12:59 = 239 рабочих минут
    expect(await remindersOf(w.orgId, w.mariaId)).toBe(0);
    await tickOrg(w.orgId, new Date('2026-09-21T10:00:00Z')); // пн 13:00 = 240
    expect(await remindersOf(w.orgId, w.mariaId)).toBe(1);
  });

  it('следующее — в первый рабочий час следующего рабочего дня; всего не больше трёх', async () => {
    const w = await world();
    const id = await send(w.orgId, w.ownerId, [w.mariaId]);
    await tickAt(w.orgId, w.mariaId, 240); // пн 14:00 — первое
    await tickOrg(w.orgId, new Date('2026-09-22T05:59:00Z')); // вт 08:59 — ещё не рабочий час
    expect(await remindersOf(w.orgId, w.mariaId)).toBe(1);
    await tickOrg(w.orgId, new Date('2026-09-22T06:00:00Z')); // вт 09:00 — второе
    expect(await remindersOf(w.orgId, w.mariaId)).toBe(2);
    await tickOrg(w.orgId, new Date('2026-09-22T12:00:00Z')); // вт 15:00 — в тот же день повтора нет
    expect(await remindersOf(w.orgId, w.mariaId)).toBe(2);
    await tickOrg(w.orgId, new Date('2026-09-23T06:00:00Z')); // ср 09:00 — третье
    expect(await remindersOf(w.orgId, w.mariaId)).toBe(3);
    // После третьего — тишина, сколько бы дней ни прошло.
    await tickOrg(w.orgId, new Date('2026-09-24T06:00:00Z'));
    await tickOrg(w.orgId, new Date('2026-09-29T06:00:00Z'));
    expect(await remindersOf(w.orgId, w.mariaId)).toBe(3);
    expect((await recipientRow(w.orgId, id, w.mariaId))!.reminded_count).toBe(3);
    const keys = (await inOrg(w.orgId, (db) => db.query(
      `select dedupe_key from notifications where kind = 'announcement_reminder' and user_id = $1 order by dedupe_key`, [w.mariaId]))).rows.map((r) => r.dedupe_key);
    expect(keys).toEqual([1, 2, 3].map((n) => `ann_rem:${id}:${w.mariaId}:${n}`));
  });

  it('выходные не съедают напоминание: после пятницы — понедельник', async () => {
    const w = await world();
    // Пятница 2026-09-25 10:00 по Стамбулу.
    const friday = new Date('2026-09-25T07:00:00Z');
    await send(w.orgId, w.ownerId, [w.mariaId], TEXT, friday);
    await tickOrg(w.orgId, new Date('2026-09-25T11:00:00Z')); // пт 14:00 — первое
    expect(await remindersOf(w.orgId, w.mariaId)).toBe(1);
    await tickOrg(w.orgId, new Date('2026-09-26T07:00:00Z')); // сб
    await tickOrg(w.orgId, new Date('2026-09-27T07:00:00Z')); // вс
    expect(await remindersOf(w.orgId, w.mariaId)).toBe(1);
    await tickOrg(w.orgId, new Date('2026-09-28T05:59:00Z')); // пн 08:59
    expect(await remindersOf(w.orgId, w.mariaId)).toBe(1);
    await tickOrg(w.orgId, new Date('2026-09-28T06:00:00Z')); // пн 09:00 — второе
    expect(await remindersOf(w.orgId, w.mariaId)).toBe(2);
  });

  it('подтвердившему напоминаний нет — ни первого, ни следующих', async () => {
    const w = await world();
    const id = await send(w.orgId, w.ownerId, [w.mariaId, w.ahmetId]);
    await inOrg(w.orgId, (db) => confirmAnnouncement(db, id, w.mariaId, 'bot'));
    await tickAt(w.orgId, w.mariaId, 240);
    expect(await remindersOf(w.orgId, w.mariaId)).toBe(0);
    expect(await remindersOf(w.orgId, w.ahmetId)).toBe(1);
    // Подтвердил после первого напоминания — следующие не идут.
    await inOrg(w.orgId, (db) => confirmAnnouncement(db, id, w.ahmetId, 'app'));
    await tickOrg(w.orgId, new Date('2026-09-22T06:00:00Z'));
    expect(await remindersOf(w.orgId, w.ahmetId)).toBe(1);
  });

  it('вышедшему из компании напоминаний нет, а в статусе он остаётся «не подтвердил»', async () => {
    const w = await world();
    const id = await send(w.orgId, w.ownerId, [w.mariaId, w.ahmetId]);
    await inOrg(w.orgId, (db) => offboardPerson(db, w.mariaId, user(w.ownerId)));
    await tickAt(w.orgId, w.ahmetId, 240);
    expect(await remindersOf(w.orgId, w.mariaId)).toBe(0);
    expect(await remindersOf(w.orgId, w.ahmetId)).toBe(1);

    const status = await call(w.ownerId, 'announcement_status', { org: w.orgId, announcement: id });
    const gone = status.data.announcements[0].recipients.find((r: { user_id: string }) => r.user_id === w.mariaId);
    expect(gone).toMatchObject({ confirmed_at: null, status: 'not_confirmed', reminded_count: 0 });
  });

  it('напоминание уходит в бот с текстом и той же кнопкой; тихие часы откладывают его', async () => {
    const w = await world();
    const tg = await linkTelegram(w.mariaId);
    const ahmetTg = await linkTelegram(w.ahmetId);
    const id = await send(w.orgId, w.ownerId, [w.mariaId, w.ahmetId]);
    // У Ахмет тихие часы накрывают 14:00 по Стамбулу.
    await withGlobal((db) => db.query(`update users set quiet_start = '13:00', quiet_end = '15:00' where id = $1`, [w.ahmetId]));
    await tickOrg(w.orgId, MON_10);
    sent.length = 0;

    const at = await tickAt(w.orgId, w.mariaId, 240);
    const got = messagesTo(tg);
    expect(got).toHaveLength(1);
    expect(got[0]!.payload.text).toContain('Напоминание');
    expect(got[0]!.payload.text).toContain(TEXT);
    expect(got[0]!.payload.reply_markup.inline_keyboard.flat()).toEqual([
      { text: 'Прочёл, подтверждаю', callback_data: encodeAnnouncement(id) },
    ]);

    // Ахмет: напоминание записано, но до конца тихих часов не доставлено.
    expect(messagesTo(ahmetTg)).toHaveLength(0);
    const [held] = await notes(w.orgId, 'announcement_reminder', w.ahmetId);
    expect(held!.delivered_at).toBeNull();
    expect(held!.deliver_after.getTime()).toBeGreaterThan(at.getTime());
  });
});

// ---------------------------------------------------------------- статус

describe('announcement_status', () => {
  it('по каждому получателю — время подтверждения или его отсутствие и число напоминаний', async () => {
    const w = await world();
    const id = await send(w.orgId, w.ownerId, [w.mariaId, w.ahmetId, w.memberId]);
    await inOrg(w.orgId, (db) => confirmAnnouncement(db, id, w.mariaId, 'app'));
    await tickAt(w.orgId, w.ahmetId, 240);
    const confirmedAt = (await recipientRow(w.orgId, id, w.mariaId))!.confirmed_at!;

    const r = await call(w.ownerId, 'announcement_status', { org: w.orgId, announcement: id });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    const a = r.data.announcements[0];
    expect(a).toMatchObject({ id, confirmed: 1, total: 3, to_all: false, via_agent: null });
    expect(a.text).toEqual({ untrusted: true, text: TEXT });
    expect(a.from).toEqual({ untrusted: true, text: 'Олег' });
    const byName = Object.fromEntries(a.recipients.map((x: { name: { text: string } }) => [x.name.text, x]));
    expect(byName['Мария']).toMatchObject({ status: 'confirmed', confirmed_via: 'app', reminded_count: 0 });
    expect(new Date(byName['Мария'].confirmed_at).getTime()).toBe(confirmedAt.getTime());
    expect(byName['Ахмет']).toMatchObject({ status: 'not_confirmed', confirmed_at: null, confirmed_via: null, reminded_count: 1 });
    // Тик организации напомнил всем неподтвердившим сразу: рабочие часы у них одинаковые.
    expect(byName['Рядовой']).toMatchObject({ status: 'not_confirmed', confirmed_at: null, reminded_count: 1 });
  });

  it('без номера — последние 20, новые первыми; чужой и неизвестный номер — not_found', async () => {
    const w = await world();
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) ids.push(await send(w.orgId, w.ownerId, [w.mariaId], `Объявление ${i}`, minutes(MON_10, i * 180)));
    const r = await call(w.adminId, 'announcement_status', { org: w.orgId });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(r.data.announcements).toHaveLength(20);
    expect(r.data.announcements[0].id).toBe(ids[20]);
    expect(r.data.announcements.at(-1).id).toBe(ids[1]);

    expect((await call(w.ownerId, 'announcement_status', { org: w.orgId, announcement: '00000000-0000-4000-8000-000000000000' })).data.code).toBe('not_found');
    const other = await world();
    expect((await call(other.ownerId, 'announcement_status', { org: other.orgId, announcement: ids[0] })).data.code).toBe('not_found');
  });

  it('рядовой участник и его агент статус не видят; агент владельца — видит', async () => {
    const w = await world();
    await send(w.orgId, w.ownerId, [w.mariaId]);
    expect((await call(w.memberId, 'announcement_status', { org: w.orgId })).data.code).toBe('forbidden');
    const memberAgent = await makeAgent(w.orgId, w.memberId);
    expect((await call(w.memberId, 'announcement_status', { org: w.orgId, agent: memberAgent })).data.code).toBe('forbidden');
    const ownerAgent = await makeAgent(w.orgId, w.ownerId);
    const viaAgent = await call(w.ownerId, 'announcement_status', { org: w.orgId, agent: ownerAgent });
    expect(viaAgent.isError, JSON.stringify(viaAgent.data)).toBe(false);
    expect(viaAgent.data.announcements).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- навык и каталог

describe('навык taskano и каталог инструментов', () => {
  it('навык описывает объявление и отличает его от задачи; инструментов 62', () => {
    const assigning = readFileSync('skill/skills/taskano/assigning.md', 'utf8');
    expect(assigning).toMatch(/## Announcement or task[\s\S]*`send_announcement`[\s\S]*`announcement_status`[\s\S]*## From vague to checkable/);
    expect(assigning).toMatch(/not a task|There is nothing to do/);
    expect(readFileSync('skill/skills/taskano/SKILL.md', 'utf8')).toContain('`send_announcement`');

    const names = new Set<string>();
    for (const f of readdirSync('src/mcp/tools')) {
      for (const m of readFileSync(join('src/mcp/tools', f), 'utf8').matchAll(/registerTool\(\s*'([a-z_]+)'/g)) names.add(m[1]!);
    }
    expect(names.has('send_announcement') && names.has('announcement_status')).toBe(true);
    expect(names.size).toBe(62);
  });
});

// ---------------------------------------------------------------- база: вставка и перепривязка

describe('база: вставка неподтверждённой и узкие права приложения', () => {
  it('вставка с confirmed_at/confirmed_via хранится неподтверждённой', async () => {
    const w = await world();
    const id = await send(w.orgId, w.ownerId, [w.mariaId]);
    await inOrg(w.orgId, (db) => db.query(
      `insert into announcement_recipients(org_id, announcement_id, user_id, confirmed_at, confirmed_via)
       values (current_setting('app.org_id')::uuid, $1, $2, now(), 'app')`, [id, w.ahmetId]));
    const row = await recipientRow(w.orgId, id, w.ahmetId);
    expect(row).toMatchObject({ confirmed_at: null, confirmed_via: null });
  });

  it('получателя не перепривязать: триггер держит org_id, announcement_id, user_id даже у роли с правом записи', async () => {
    const w = await world();
    const id = await send(w.orgId, w.ownerId, [w.mariaId]);
    await expect(withSystem((db) => db.query(
      'update announcement_recipients set user_id = $3 where announcement_id = $1 and user_id = $2', [id, w.mariaId, w.ahmetId])))
      .rejects.toThrow(/cannot be reassigned/);
    const other = await send(w.orgId, w.ownerId, [w.mariaId], 'Другое');
    await expect(withSystem((db) => db.query(
      'update announcement_recipients set announcement_id = $3 where announcement_id = $1 and user_id = $2', [id, w.mariaId, other])))
      .rejects.toThrow(/cannot be reassigned/);
  });

  it('приложению выдан update только по четырём колонкам: другие поля — permission denied', async () => {
    const w = await world();
    const id = await send(w.orgId, w.ownerId, [w.mariaId]);
    await expect(inOrg(w.orgId, (db) => db.query(
      'update announcement_recipients set user_id = $3 where announcement_id = $1 and user_id = $2', [id, w.mariaId, w.ahmetId])))
      .rejects.toThrow(/permission denied/);
    await expect(inOrg(w.orgId, (db) => db.query(
      'update announcement_recipients set announcement_id = announcement_id where announcement_id = $1 and user_id = $2', [id, w.mariaId])))
      .rejects.toThrow(/permission denied/);
    // Свои четыре колонки — можно.
    await inOrg(w.orgId, (db) => db.query(
      `update announcement_recipients set reminded_count = 1, last_reminded_at = now() where announcement_id = $1 and user_id = $2`, [id, w.mariaId]));
    expect((await recipientRow(w.orgId, id, w.mariaId))!.reminded_count).toBe(1);
  });
});

// ---------------------------------------------------------------- доставка подтвердившему

describe('доставка не шлёт то, что уже подтверждено', () => {
  it('уведомление встало в тихие часы, человек подтвердил в приложении — после тихих часов не уходит ничего', async () => {
    const w = await world();
    const tg = await linkTelegram(w.ahmetId);
    await withGlobal((db) => db.query(`update users set quiet_start = '13:00', quiet_end = '15:00' where id = $1`, [w.ahmetId]));
    const at14 = new Date('2026-09-21T11:00:00Z'); // пн 14:00 по Стамбулу — тихие часы Ахмет
    const id = await send(w.orgId, w.ownerId, [w.ahmetId], TEXT, at14);
    await tickOrg(w.orgId, at14);
    expect(messagesTo(tg)).toHaveLength(0);
    expect((await notes(w.orgId, 'announcement', w.ahmetId))[0]!.delivered_at).toBeNull();

    await inOrg(w.orgId, (db) => confirmAnnouncement(db, id, w.ahmetId, 'app'));
    await tickOrg(w.orgId, new Date('2026-09-21T12:01:00Z')); // пн 15:01 — тихие часы кончились
    expect(messagesTo(tg)).toHaveLength(0);
    // Помечено обработанным, а не висит вечно в очереди.
    expect((await notes(w.orgId, 'announcement', w.ahmetId))[0]!.delivered_at).not.toBeNull();
  });

  it('напоминание подтвердившему тоже не уходит', async () => {
    const w = await world();
    const tg = await linkTelegram(w.ahmetId);
    const id = await send(w.orgId, w.ownerId, [w.ahmetId]);
    await tickOrg(w.orgId, MON_10);
    await tickAt(w.orgId, w.ahmetId, 240); // напоминание поставлено и доставлено
    expect(messagesTo(tg)).toHaveLength(2);
    // Новое напоминание уже в очереди, а человек подтвердил — его отправка пропускается.
    await tickOrg(w.orgId, new Date('2026-09-22T05:00:00Z'));
    await inOrg(w.orgId, (db) => db.query(
      `insert into notifications(org_id, user_id, kind, level, payload, deliver_after)
       values (current_setting('app.org_id')::uuid, $1, 'announcement_reminder', 'work', $2, $3)`,
      [w.ahmetId, { announcement_id: id }, new Date('2026-09-22T05:30:00Z')]));
    await inOrg(w.orgId, (db) => confirmAnnouncement(db, id, w.ahmetId, 'bot'));
    await tickOrg(w.orgId, new Date('2026-09-22T05:31:00Z'));
    expect(messagesTo(tg)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- потолки

describe('потолки отправки', () => {
  it('десять объявлений на организацию за скользящие сутки; одиннадцатое — limit_exceeded; через сутки снова можно', async () => {
    const w = await world();
    const now = new Date();
    for (let i = 0; i < 10; i++) await send(w.orgId, w.ownerId, [w.mariaId], `Объявление ${i}`, now);
    const r = await call(w.adminId, 'send_announcement', { org: w.orgId, text: 'Одиннадцатое', to: ['Мария'], idempotency_key: uniq() });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe('limit_exceeded');
    expect(r.data.message).toMatch(/10 announcements per organization in 24 hours/);
    expect((await inOrg(w.orgId, (db) => db.query('select count(*)::int as n from announcements'))).rows[0].n).toBe(10);
    await expect(inOrg(w.orgId, (db) => sendAnnouncement(db, { text: 'Через сутки', to: [w.mariaId] }, user(w.ownerId), new Date(now.getTime() + 24 * 3600e3 + 60e3))))
      .resolves.toHaveProperty('announcement_id');
  });

  it('от одного агента — три за сутки; другой агент и человек не затронуты', async () => {
    const w = await world();
    const agent = await makeAgent(w.orgId, w.ownerId);
    for (let i = 0; i < 3; i++) {
      const ok = await call(w.ownerId, 'send_announcement', { org: w.orgId, agent, text: `От агента ${i}`, to: ['Мария'], idempotency_key: uniq() });
      expect(ok.isError, JSON.stringify(ok.data)).toBe(false);
    }
    const over = await call(w.ownerId, 'send_announcement', { org: w.orgId, agent, text: 'Четвёртое', to: ['Мария'], idempotency_key: uniq() });
    expect(over.isError).toBe(true);
    expect(over.data.code).toBe('limit_exceeded');
    expect(over.data.message).toMatch(/3 announcements per agent/);
    const other = await makeAgent(w.orgId, w.ownerId);
    expect((await call(w.ownerId, 'send_announcement', { org: w.orgId, agent: other, text: 'Другой агент', to: ['Мария'], idempotency_key: uniq() })).isError).toBe(false);
    expect((await call(w.ownerId, 'send_announcement', { org: w.orgId, text: 'Человек', to: ['Мария'], idempotency_key: uniq() })).isError).toBe(false);
  });

  it('в to — не больше 200 имён', async () => {
    const w = await world();
    const many = Array.from({ length: 201 }, (_, i) => `Человек ${i}`);
    const r = await call(w.ownerId, 'send_announcement', { org: w.orgId, text: TEXT, to: many, idempotency_key: uniq() });
    expect(r.isError).toBe(true);
    // Отказ схемы коннектора, а не поиск 201 имени по базе.
    expect(r.data.code).toBe('schema');
    expect((await inOrg(w.orgId, (db) => db.query('select count(*)::int as n from announcements'))).rows[0].n).toBe(0);
  });
});

// ---------------------------------------------------------------- честная подпись агента

describe('объявление от агента подписано честно', () => {
  it('в боте: «от <человек> через агента <агент>», имя агента экранировано; то же в напоминании и в приложении', async () => {
    const w = await world();
    const tg = await linkTelegram(w.mariaId);
    const agent = await makeAgent(w.orgId, w.ownerId, '<i>Секретарь</i>');
    const sentByAgent = await inOrg(w.orgId, (db) => sendAnnouncement(db, { text: TEXT, to: [w.mariaId] }, { kind: 'agent', agentId: agent, userId: w.ownerId }, MON_10));
    const id = sentByAgent.announcement_id;
    // Id агента лежит в данных уведомления, имя — не в них.
    expect((await notes(w.orgId, 'announcement', w.mariaId))[0]!.payload).toEqual({ announcement_id: id, agent_id: agent });

    await tickOrg(w.orgId, MON_10);
    const text = messagesTo(tg)[0]!.payload.text as string;
    expect(text).toContain('Объявление от Олег через агента &lt;i&gt;Секретарь&lt;/i&gt;');
    expect(text).not.toContain('<i>Секретарь</i>');

    await tickAt(w.orgId, w.mariaId, 240);
    expect(messagesTo(tg)[1]!.payload.text).toContain('от Олег через агента &lt;i&gt;Секретарь&lt;/i&gt;');

    const r = await lists(tg);
    expect(r.body.announcements[0]).toMatchObject({ id, from: 'Олег', agent: '<i>Секретарь</i>' });
  });

  it('от человека агента в подписи нет; на других языках подпись тоже есть', async () => {
    const w = await world();
    const enId = await addPerson(w.orgId, 'member', { name: 'Англичанин', language: 'en' });
    const tg = await linkTelegram(enId);
    const agent = await makeAgent(w.orgId, w.ownerId, 'Secretary');
    await inOrg(w.orgId, (db) => sendAnnouncement(db, { text: TEXT, to: [enId] }, { kind: 'agent', agentId: agent, userId: w.ownerId }, MON_10));
    await tickOrg(w.orgId, MON_10);
    expect(messagesTo(tg)[0]!.payload.text).toContain('Announcement from Олег via the agent Secretary');

    const mariaTg = await linkTelegram(w.mariaId);
    await send(w.orgId, w.ownerId, [w.mariaId]);
    await tickOrg(w.orgId, MON_10);
    expect(messagesTo(mariaTg)[0]!.payload.text).not.toContain('через агента');
    expect((await lists(mariaTg)).body.announcements[0].agent).toBeNull();
    for (const lang of ['ru', 'en', 'tr', 'vi']) {
      for (const key of ['notif.announcement_via', 'notif.announcement_reminder_via']) {
        expect(t(lang, key, { name: 'N', agent: 'A' }), `${lang} ${key}`).toMatch(/N[\s\S]*A/);
      }
    }
  });

  it('announcement_status: via_agent под untrusted', async () => {
    const w = await world();
    const agent = await makeAgent(w.orgId, w.ownerId, 'Секретарь');
    const sentBy = await call(w.ownerId, 'send_announcement', { org: w.orgId, agent, text: TEXT, to: ['Мария'], idempotency_key: uniq() });
    const st = await call(w.ownerId, 'announcement_status', { org: w.orgId, announcement: sentBy.data.announcement_id });
    expect(st.data.announcements[0].via_agent).toEqual({ untrusted: true, text: 'Секретарь' });
  });
});

// ---------------------------------------------------------------- перевод не держит приложение

describe('перевод и список приложения', () => {
  it('отправка греет перевод на языки получателей после коммита; /lists модель не ждёт и показывает оригинал', async () => {
    const w = await world();
    const enId = await addPerson(w.orgId, 'member', { name: 'Англичанин', language: 'en' });
    const tg = await linkTelegram(enId);
    warmCalls.list.length = 0;
    const id = await send(w.orgId, w.ownerId, [w.mariaId, enId]);
    const warmed = warmCalls.list.filter((c) => c.inputs.some((i) => i.objectType === 'announcement' && i.objectId === id));
    expect(warmed).toHaveLength(1);
    expect(warmed[0]!.orgId).toBe(w.orgId);
    // Язык автора и получателя совпадает с оригиналом — греть незачем; остаётся английский.
    expect(warmed[0]!.inputs.map((i) => i.targetLang)).toEqual(['en']);

    // Дать фоновому прогреву договорить (ключа модели нет — он быстро сдаётся), затем проверить список.
    await new Promise((r) => setTimeout(r, 50));
    warmCalls.list.length = 0;
    const r = await lists(tg);
    expect(r.status).toBe(200);
    expect(warmCalls.list).toEqual([]);
    expect(r.body.announcements[0]).toMatchObject({ id, text: TEXT, translated: false });
  });
});

// ---------------------------------------------------------------- сайт

describe('страница docs', () => {
  it('в таблице инструментов — группа Announcements с обоими инструментами; число совпадает с реальным', () => {
    const html = readFileSync('src/web/site/docs.html', 'utf8');
    expect(html).toMatch(/Announcements<\/td>[^\n]*<code>send_announcement<\/code>[^\n]*<code>announcement_status<\/code>/);
    expect(html).toContain('The connector has 62 tools');
    const listed = new Set([...html.matchAll(/<code>([a-z]+(?:_[a-z]+)*)<\/code>/g)].map((m) => m[1]));
    const names = new Set<string>();
    for (const f of readdirSync('src/mcp/tools')) {
      for (const m of readFileSync(join('src/mcp/tools', f), 'utf8').matchAll(/registerTool\(\s*'([a-z_]+)'/g)) names.add(m[1]!);
    }
    expect([...names].filter((n) => !listed.has(n))).toEqual([]);
  });
});
