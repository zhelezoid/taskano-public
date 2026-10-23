process.env.TASKANO_DISABLE_RATE_LIMIT = '1';

import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import sharp from 'sharp';
import type { Update, UserFromGetMe } from 'grammy/types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePools, withGlobal } from '../src/db/pool.js';
import { createTask } from '../src/core/tasks.js';
import { attachImage, PHOTO_DAILY_LIMIT } from '../src/core/attachments.js';
import { AppError } from '../src/core/errors.js';
import { setMediaFetchForTests, UnsupportedImageError } from '../src/groups/media.js';
import { createBot } from '../src/bot/bot.js';
import { notificationText, type NotifRow } from '../src/bot/notif-text.js';
import { miniappRoutes } from '../src/web/miniapp-api.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { t } from '../src/i18n/index.js';
import { addPerson, inOrg, makeOrg, minutes, MON_10, uniq } from './helpers.js';

// Спека task-photos, машинные пункты Acceptance: ядро `attachImage`, уведомление второй стороне, бот
// (кнопка «📎», ответ на карточку, фото без контекста, фото в ожидании реплики), ручки Mini App и
// досье агента. Сеть Telegram и скачивание файлов подменены, файлы пишутся во временный каталог.

const MEDIA_DIR = mkdtempSync(join(tmpdir(), 'taskano-photos-'));
const prevEnv = { MEDIA_DIR: process.env.MEDIA_DIR, TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN };
process.env.MEDIA_DIR = MEDIA_DIR;
process.env.TELEGRAM_BOT_TOKEN = 'test-token';

afterAll(async () => {
  setMediaFetchForTests(undefined);
  for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(MEDIA_DIR, { recursive: true, force: true });
  await closePools();
});

// Файлы «на серверах Telegram»: file_id → содержимое.
const telegramFiles = new Map<string, Buffer>();

beforeAll(() => {
  setMediaFetchForTests(async (url) => {
    const getFile = /\/getFile\?file_id=(.+)$/.exec(url);
    if (getFile) {
      const id = decodeURIComponent(getFile[1]!);
      const buf = telegramFiles.get(id);
      return new Response(JSON.stringify(buf
        ? { ok: true, result: { file_id: id, file_path: `photos/${id}.jpg`, file_size: buf.length } }
        : { ok: false, description: 'Bad Request: wrong file_id' }));
    }
    const file = /\/file\/bottest-token\/photos\/(.+)\.jpg$/.exec(url);
    if (file) return new Response(new Uint8Array(telegramFiles.get(file[1]!)!));
    return new Response('not found', { status: 404 });
  });
});

let colorSeq = 0;
/** Скриншот: PNG своего цвета — разные байты, разный sha256 после очистки. */
async function screenshot(): Promise<Buffer> {
  colorSeq += 1;
  return sharp({ create: { width: 640, height: 480, channels: 3, background: { r: colorSeq % 256, g: (colorSeq * 7) % 256, b: 90 } } })
    .png().toBuffer();
}

const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };

interface World { orgId: string; ownerId: string; authorId: string; workerId: string; taskId: string; shortId: string; version: number }

/** Дело, поставленное человеком (постановщик — участник организации) исполнителю. */
async function world(title = `сверить накладную ${uniq()}`): Promise<World> {
  const { orgId, ownerId } = await makeOrg();
  const authorId = await addPerson(orgId, 'member', { name: 'Мария' });
  const workerId = await addPerson(orgId, 'member', { name: 'Ахмет' });
  const task = await inOrg(orgId, (db) => createTask(db, { ...base, title, assigneeUserId: workerId }, { kind: 'user', userId: authorId }, MON_10), authorId);
  return { orgId, ownerId, authorId, workerId, taskId: task.id, shortId: String(task.short_id), version: task.version };
}

const attach = async (w: World, userId: string, image: Buffer, now = MON_10) =>
  inOrg(w.orgId, (db) => attachImage(db, { taskId: w.taskId, userId, image, now }), userId);

async function refusal(p: Promise<unknown>): Promise<unknown> {
  try { await p; } catch (e) { return e; }
  throw new Error('ожидался отказ');
}

describe('attachImage — ядро', () => {
  it('открытое дело и право писать → task_attachments(source person, автор), событие attachment_added', async () => {
    const w = await world();
    const r = await attach(w, w.workerId, await screenshot());
    expect(r).toMatchObject({ added: true, photos: 1 });
    const rows = await inOrg(w.orgId, (db) => db.query('select id, source, author_user_id from task_attachments where task_id = $1', [w.taskId]));
    expect(rows.rows).toEqual([{ id: r.id, source: 'person', author_user_id: w.workerId }]);
    const ev = await inOrg(w.orgId, (db) => db.query(`select actor_user_id, data from events where task_id = $1 and type = 'attachment_added'`, [w.taskId]));
    expect(ev.rows).toEqual([{ actor_user_id: w.workerId, data: { by_user_id: w.workerId, attachment_id: r.id } }]);
  });

  it('повтор того же фото — без дубля и без второго события', async () => {
    const w = await world();
    const img = await screenshot();
    const first = await attach(w, w.workerId, img);
    const again = await attach(w, w.workerId, img, minutes(MON_10, 1));
    expect(again).toMatchObject({ id: first.id, added: false, photos: 1 });
    const ev = await inOrg(w.orgId, (db) => db.query(`select 1 from events where task_id = $1 and type = 'attachment_added'`, [w.taskId]));
    expect(ev.rowCount).toBe(1);
  });

  it('закрытое дело и посторонний — отказ; не картинка — UnsupportedImageError', async () => {
    const w = await world();
    const stranger = await addPerson(w.orgId, 'member');
    const e1 = await refusal(attach(w, stranger, await screenshot()));
    expect(e1).toBeInstanceOf(AppError);
    expect((e1 as AppError).code).toBe('forbidden');
    expect(await refusal(attach(w, w.workerId, Buffer.from('%PDF-1.4 not an image')))).toBeInstanceOf(UnsupportedImageError);
    // SVG и прочие форматы отсекаются по сигнатуре — до того, как libvips запустит их декодер (ревью 07.10).
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    expect(await refusal(attach(w, w.workerId, svg))).toBeInstanceOf(UnsupportedImageError);

    await inOrg(w.orgId, (db) => db.query(`update tasks set status = 'done' where id = $1`, [w.taskId]));
    const e2 = await refusal(attach(w, w.workerId, await screenshot()));
    expect((e2 as AppError).code).toBe('validation_failed');
    expect((e2 as AppError).details).toEqual({ closed: true });
    expect((await inOrg(w.orgId, (db) => db.query('select 1 from task_attachments where task_id = $1', [w.taskId]))).rowCount).toBe(0);
  });

  it(`предел — ${PHOTO_DAILY_LIMIT} фото на человека на дело за сутки`, async () => {
    const w = await world();
    // Предел считается по строкам вложений автора: заводим их напрямую, без перекодирования 30 картинок.
    await inOrg(w.orgId, (db) => db.query(
      `with m as (
         insert into media(org_id, sha256, path, expires_at)
         select current_setting('app.org_id')::uuid, md5(random()::text || g::text), 'x/' || g || '.jpg', $3::timestamptz + interval '30 days'
           from generate_series(1, $4::int) g returning id)
       insert into task_attachments(org_id, task_id, media_id, source, author_user_id, created_at)
       select current_setting('app.org_id')::uuid, $1, m.id, 'person', $2, $3 from m`,
      [w.taskId, w.workerId, minutes(MON_10, -60), PHOTO_DAILY_LIMIT]));
    const e = await refusal(attach(w, w.workerId, await screenshot()));
    expect((e as AppError).code).toBe('limit_exceeded');
    // Сутки спустя — снова можно; у другого причастного свой счёт.
    expect((await attach(w, w.authorId, await screenshot())).added).toBe(true);
    expect((await attach(w, w.workerId, await screenshot(), minutes(MON_10, 24 * 60))).added).toBe(true);
  });
});

describe('уведомление task_photo', () => {
  it('исполнитель прикрепил — постановщику; три фото подряд — одно уведомление; текст называет автора', async () => {
    const w = await world();
    for (let i = 0; i < 3; i++) await attach(w, w.workerId, await screenshot(), minutes(MON_10, i));
    const n = await inOrg(w.orgId, (db) => db.query(
      `select id, kind, level, task_id, payload, created_at, user_id from notifications where task_id = $1 and kind = 'task_photo'`, [w.taskId]));
    expect(n.rows.map((r) => [r.user_id, r.level, r.payload])).toEqual([[w.authorId, 'work', { by_user_id: w.workerId }]]);
    const text = await inOrg(w.orgId, (db) => notificationText(db, 'ru', n.rows[0] as NotifRow, w.authorId));
    expect(text).toContain(t('ru', 'notif.task_photo', { name: 'Ахмет' }));
    expect(text).toContain('сверить накладную');

    // Постановщик прикрепил — исполнителю; через 10 минут от того же автора — новое уведомление.
    await attach(w, w.authorId, await screenshot(), minutes(MON_10, 5));
    await attach(w, w.workerId, await screenshot(), minutes(MON_10, 15));
    const all = await inOrg(w.orgId, (db) => db.query(
      `select user_id from notifications where task_id = $1 and kind = 'task_photo' order by created_at`, [w.taskId]));
    expect(all.rows.map((r) => r.user_id)).toEqual([w.authorId, w.workerId, w.authorId]);
  });
});

// ---------------------------------------------------------------- бот

const BOT_INFO: UserFromGetMe = {
  id: 10, is_bot: true, first_name: 'Taskano', username: 'taskano_test_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
  allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
};

let nextUpdateId = 1;
let nextMessageId = 1;
let nextTgId = 77_000;

interface SentCall { method: string; payload: Record<string, unknown> }
let sent: SentCall[];
let bot: ReturnType<typeof createBot>;

beforeEach(() => {
  sent = [];
  bot = createBot({ token: 'test-token', botInfo: BOT_INFO });
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, unknown> });
    const chatId = (payload as { chat_id?: number }).chat_id;
    if (method === 'sendMessage') {
      return { ok: true, result: { message_id: nextMessageId++, date: 0, chat: { id: chatId, type: 'private' }, text: String((payload as { text?: string }).text ?? '') } } as any;
    }
    return { ok: true, result: true } as any;
  });
});

type TgUser = NonNullable<Update['message']>['from'];
const tgUser = (id: number): TgUser => ({ id, is_bot: false, first_name: 'Person', language_code: 'ru' });

async function linkTelegram(userId: string, telegramUserId: number): Promise<void> {
  await withGlobal((db) => db.query(`insert into telegram_links(telegram_user_id, user_id, chat_id) values ($1, $2, $1)`, [telegramUserId, userId]));
}

/** Фото «из лички»: file_id → содержимое кладётся «на сервер Telegram». */
async function photoMessage(from: TgUser, opts: {
  caption?: string; mediaGroupId?: string; replyTo?: { message_id: number; reply_markup?: unknown };
  document?: { mime: string; name: string };
} = {}): Promise<Update> {
  const fileId = `f-${uniq()}`;
  telegramFiles.set(fileId, await screenshot());
  const media = opts.document
    ? { document: { file_id: fileId, file_unique_id: `u-${fileId}`, mime_type: opts.document.mime, file_name: opts.document.name, file_size: 1000 } }
    : { photo: [{ file_id: `${fileId}-s`, file_unique_id: `u-${fileId}-s`, width: 90, height: 60 }, { file_id: fileId, file_unique_id: `u-${fileId}`, width: 640, height: 480 }] };
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: from!.id, type: 'private', first_name: 'P' }, from,
      ...media,
      ...(opts.caption ? { caption: opts.caption } : {}),
      ...(opts.mediaGroupId ? { media_group_id: opts.mediaGroupId } : {}),
      ...(opts.replyTo ? { reply_to_message: { ...opts.replyTo, date: 0, chat: { id: from!.id, type: 'private', first_name: 'P' }, text: 'карточка' } } : {}),
    },
  } as unknown as Update;
}

function callbackUpdate(from: TgUser, data: string, messageId = nextMessageId++): Update {
  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: String(nextUpdateId), from, chat_instance: 'x', data,
      message: { message_id: messageId, date: 0, chat: { id: from!.id, type: 'private', first_name: 'P' }, text: 'карточка' },
    },
  } as unknown as Update;
}

async function attachmentsOf(w: World): Promise<{ source: string; author_user_id: string }[]> {
  return (await inOrg(w.orgId, (db) => db.query('select source, author_user_id from task_attachments where task_id = $1 order by created_at', [w.taskId]))).rows;
}

const texts = (method = 'sendMessage'): string[] => sent.filter((s) => s.method === method).map((s) => String(s.payload.text ?? ''));

describe('бот: фото к делу', () => {
  it('«📎 Прикрепить фото» → просьба → фото прикрепляется, подтверждение закрывает ожидание', async () => {
    const w = await world();
    const worker = tgUser(nextTgId++);
    await linkTelegram(w.workerId, worker!.id);

    await bot.handleUpdate(callbackUpdate(worker, `a:ph:${w.shortId}:${w.version}`));
    expect(texts()).toContain(t('ru', 'photo.ask'));

    sent = [];
    await bot.handleUpdate(await photoMessage(worker));
    expect(await attachmentsOf(w)).toEqual([{ source: 'person', author_user_id: w.workerId }]);
    expect(texts().some((x) => x.startsWith('✓ ') && x.includes('сверить накладную') && x.includes(': 1 фото'))).toBe(true);

    // Ожидание закрыто: следующее фото — уже без контекста, бот спрашивает «К какому делу?».
    sent = [];
    await bot.handleUpdate(await photoMessage(worker));
    expect(texts()).toContain(t('ru', 'photo.which_task'));
    expect(await attachmentsOf(w)).toHaveLength(1);
  });

  it('альбом в ожидании «📎»: все фото прикреплены, подтверждение одно — число правится в нём', async () => {
    const w = await world();
    const worker = tgUser(nextTgId++);
    await linkTelegram(w.workerId, worker!.id);
    await bot.handleUpdate(callbackUpdate(worker, `a:ph:${w.shortId}:${w.version}`));
    sent = [];
    const album = `alb-${uniq()}`;
    for (let i = 0; i < 3; i++) await bot.handleUpdate(await photoMessage(worker, { mediaGroupId: album }));
    expect(await attachmentsOf(w)).toHaveLength(3);
    const confirms = texts().filter((x) => x.startsWith('✓ '));
    expect(confirms).toHaveLength(1);
    expect(texts('editMessageText').some((x) => x.startsWith('✓ ') && x.includes(': 3 фото'))).toBe(true);
    expect(texts()).not.toContain(t('ru', 'photo.which_task'));
  });

  it('фото ответом на карточку дела прикрепляется без вопросов', async () => {
    const w = await world();
    const worker = tgUser(nextTgId++);
    await linkTelegram(w.workerId, worker!.id);
    const card = { message_id: 4242, reply_markup: { inline_keyboard: [[{ text: 'Написать', callback_data: `a:cm:${w.shortId}:${w.version}` }]] } };
    await bot.handleUpdate(await photoMessage(worker, { replyTo: card }));
    expect(await attachmentsOf(w)).toEqual([{ source: 'person', author_user_id: w.workerId }]);
    expect(texts()).not.toContain(t('ru', 'photo.which_task'));
  });

  it('фото без контекста → «К какому делу прикрепить?» с делами и «Отмена» → выбор → прикреплено', async () => {
    const w = await world();
    const worker = tgUser(nextTgId++);
    await linkTelegram(w.workerId, worker!.id);
    await bot.handleUpdate(await photoMessage(worker));
    const ask = [...sent].reverse().find((s) => s.method === 'sendMessage' && s.payload.text === t('ru', 'photo.which_task'))!;
    const buttons = (ask.payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat();
    const pick = buttons.find((b) => b.text.includes('сверить накладную'))!;
    expect(pick.callback_data).toMatch(new RegExp(`^pt:${w.shortId}:\\d+$`));
    expect(buttons.at(-1)).toMatchObject({ text: t('ru', 'btn.cancel') });
    expect(await attachmentsOf(w)).toHaveLength(0);

    sent = [];
    await bot.handleUpdate(callbackUpdate(worker, pick.callback_data));
    expect(await attachmentsOf(w)).toEqual([{ source: 'person', author_user_id: w.workerId }]);
    expect(texts('editMessageText').some((x) => x.startsWith('✓ ') && x.includes(': 1 фото'))).toBe(true);
    // Второе нажатие той же кнопки фото второй раз не прикрепит.
    await bot.handleUpdate(callbackUpdate(worker, pick.callback_data));
    expect(await attachmentsOf(w)).toHaveLength(1);
  });

  it('альбом без контекста — один вопрос; открытых дел нет — «фото некуда прикрепить»', async () => {
    const w = await world();
    const worker = tgUser(nextTgId++);
    await linkTelegram(w.workerId, worker!.id);
    const album = `alb-${uniq()}`;
    for (let i = 0; i < 2; i++) await bot.handleUpdate(await photoMessage(worker, { mediaGroupId: album }));
    expect(texts().filter((x) => x === t('ru', 'photo.which_task'))).toHaveLength(1);
    const ask = sent.find((s) => s.payload.text === t('ru', 'photo.which_task'))!;
    const pick = (ask.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat()
      .find((b) => b.callback_data.startsWith(`pt:${w.shortId}:`))!;
    await bot.handleUpdate(callbackUpdate(worker, pick.callback_data));
    expect(await attachmentsOf(w)).toHaveLength(2);

    const { orgId } = await makeOrg();
    const idle = await addPerson(orgId, 'member');
    const idleTg = tgUser(nextTgId++);
    await linkTelegram(idle, idleTg!.id);
    sent = [];
    await bot.handleUpdate(await photoMessage(idleTg));
    expect(texts()).toEqual([t('ru', 'photo.no_open_tasks')]);
  });

  it('PDF — «Пока можно прикрепить только фото и скриншоты»: и без контекста, и в ожидании «📎»', async () => {
    const w = await world();
    const worker = tgUser(nextTgId++);
    await linkTelegram(w.workerId, worker!.id);
    const pdf = { mime: 'application/pdf', name: 'счёт.pdf' };
    await bot.handleUpdate(await photoMessage(worker, { document: pdf }));
    expect(texts()).toEqual([t('ru', 'photo.only_images')]);

    await bot.handleUpdate(callbackUpdate(worker, `a:ph:${w.shortId}:${w.version}`));
    sent = [];
    await bot.handleUpdate(await photoMessage(worker, { document: pdf }));
    expect(texts()).toEqual([t('ru', 'photo.only_images')]);
    expect(await attachmentsOf(w)).toHaveLength(0);
    // Ожидание не закрылось: скриншот файлом-изображением после отказа прикрепляется.
    await bot.handleUpdate(await photoMessage(worker, { document: { mime: 'image/png', name: 'screen.png' } }));
    expect(await attachmentsOf(w)).toHaveLength(1);
  });

  it('текст в ожидании «📎» — подсказка, и ожидание снимается: следующее сообщение идёт своим путём', async () => {
    const w = await world();
    const worker = tgUser(nextTgId++);
    await linkTelegram(w.workerId, worker!.id);
    await bot.handleUpdate(callbackUpdate(worker, `a:ph:${w.shortId}:${w.version}`));
    sent = [];
    await bot.handleUpdate({
      update_id: nextUpdateId++,
      message: { message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: worker!.id, type: 'private', first_name: 'P' }, from: worker, text: 'а где фото?' },
    } as unknown as Update);
    expect(texts()).toContain(t('ru', 'photo.only_images'));
    sent = [];
    await bot.handleUpdate(await photoMessage(worker));
    expect(texts()).toContain(t('ru', 'photo.which_task'));
    expect(await attachmentsOf(w)).toHaveLength(0);
  });

  it('ожидание реплики: фото с подписью → реплика и фото; без подписи → только фото, без comment.empty', async () => {
    const w = await world();
    const worker = tgUser(nextTgId++);
    await linkTelegram(w.workerId, worker!.id);
    const comments = async () => (await inOrg(w.orgId, (db) => db.query(
      `select text from task_messages where task_id = $1 and kind = 'comment'`, [w.taskId]))).rows.map((r) => r.text);

    await bot.handleUpdate(callbackUpdate(worker, `a:cm:${w.shortId}:${w.version}`));
    await bot.handleUpdate(await photoMessage(worker, { caption: 'вот накладная' }));
    expect(await comments()).toEqual(['вот накладная']);
    expect(await attachmentsOf(w)).toHaveLength(1);
    expect(texts()).toContain(t('ru', 'comment.sent'));

    await bot.handleUpdate(callbackUpdate(worker, `a:cm:${w.shortId}:${w.version}`));
    sent = [];
    await bot.handleUpdate(await photoMessage(worker));
    expect(await comments()).toEqual(['вот накладная']);
    expect(await attachmentsOf(w)).toHaveLength(2);
    expect(texts()).not.toContain(t('ru', 'comment.empty'));
  });

  it('ожидание вопроса: подпись — текст вопроса, фото прикрепляется к тому же делу', async () => {
    const w = await world();
    const worker = tgUser(nextTgId++);
    await linkTelegram(w.workerId, worker!.id);
    await bot.handleUpdate(callbackUpdate(worker, `a:q:${w.shortId}:${w.version}`));
    await bot.handleUpdate(await photoMessage(worker, { caption: 'какая из двух накладных?' }));
    const q = await inOrg(w.orgId, (db) => db.query(`select text from task_messages where task_id = $1 and kind = 'question'`, [w.taskId]));
    expect(q.rows.map((r) => r.text)).toEqual(['какая из двух накладных?']);
    expect(await attachmentsOf(w)).toHaveLength(1);
    // Фото к вопросу дело не начинает (спека auto-start): вопрос — «делать пока не могу».
    const started = await inOrg(w.orgId, (db) => db.query('select started_at, started_via from tasks where id = $1', [w.taskId]), w.workerId);
    expect(started.rows[0]).toEqual({ started_at: null, started_via: null });
  });

  it('ожидание вопроса: фото без подписи, потом текст — вопрос уходит, дело не начато (спека auto-start)', async () => {
    const w = await world();
    const worker = tgUser(nextTgId++);
    await linkTelegram(w.workerId, worker!.id);
    await bot.handleUpdate(callbackUpdate(worker, `a:q:${w.shortId}:${w.version}`));
    await bot.handleUpdate(await photoMessage(worker));
    await bot.handleUpdate({
      update_id: nextUpdateId++,
      message: { message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: worker!.id, type: 'private', first_name: 'P' }, from: worker, text: 'какая из двух накладных?' },
    } as unknown as Update);
    const q = await inOrg(w.orgId, (db) => db.query(`select text from task_messages where task_id = $1 and kind = 'question'`, [w.taskId]));
    expect(q.rows.map((r) => r.text)).toEqual(['какая из двух накладных?']);
    expect(await attachmentsOf(w)).toHaveLength(1);
    const started = await inOrg(w.orgId, (db) => db.query('select started_at from tasks where id = $1', [w.taskId]), w.workerId);
    expect(started.rows[0].started_at).toBeNull();
  });

  it('карточка открытого дела — с «📎 Прикрепить фото», «Фото (N)» — с числом фото дела', async () => {
    const w = await world();
    await attach(w, w.workerId, await screenshot());
    const worker = tgUser(nextTgId++);
    await linkTelegram(w.workerId, worker!.id);
    await bot.handleUpdate({
      update_id: nextUpdateId++,
      message: { message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: worker!.id, type: 'private', first_name: 'P' }, from: worker, text: `/start t_${w.shortId}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] },
    } as unknown as Update);
    const card = [...sent].reverse().find((s) => s.method === 'sendMessage' && s.payload.reply_markup)!;
    const buttons = (card.payload.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] }).inline_keyboard.flat();
    // Фото исполнителя начало дело (спека auto-start) — версия карточки уже новая.
    const version = (await inOrg(w.orgId, (db) => db.query('select version from tasks where id = $1', [w.taskId]), w.workerId)).rows[0].version;
    expect(buttons.find((b) => b.text === t('ru', 'btn.attach_photo'))?.callback_data).toBe(`a:ph:${w.shortId}:${version}`);
    expect(buttons.find((b) => b.text === t('ru', 'btn.show_photos', { count: 1 }))?.callback_data).toMatch(/^a:gph:/);
  });
});

// ---------------------------------------------------------------- Mini App

const MINIAPP_TOKEN = 'test-bot-token-photos';
const app = express();
miniappRoutes(app, { botToken: MINIAPP_TOKEN });

function initDataFor(telegramUserId: number): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: telegramUserId, first_name: 'Test' }),
  });
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(MINIAPP_TOKEN).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

describe('Mini App: фото дела', () => {
  it('POST прикрепляет, GET списка и GET байтов отдают; чужое и закрытое дело — 404; не изображение — 415', async () => {
    const w = await world();
    const tg = nextTgId++;
    await linkTelegram(w.workerId, tg);
    const as = (id: number) => ({ 'X-Telegram-Init-Data': initDataFor(id) });

    const up = await request(app).post(`/app/api/tasks/${w.taskId}/attachments`).set(as(tg)).set('Content-Type', 'image/png').send(await screenshot());
    expect(up.status).toBe(200);
    expect(up.body).toEqual({ id: expect.any(String), photos: 1 });
    expect(await attachmentsOf(w)).toEqual([{ source: 'person', author_user_id: w.workerId }]);

    const list = await request(app).get(`/app/api/tasks/${w.taskId}/attachments`).set(as(tg));
    expect(list.status).toBe(200);
    expect(list.body.attachments).toEqual([{ id: up.body.id, source: 'person', author: 'Ахмет', at: expect.any(String) }]);

    const bytes = await request(app).get(`/app/api/tasks/${w.taskId}/attachments/${up.body.id}`).set(as(tg)).buffer(true);
    expect(bytes.status).toBe(200);
    expect(bytes.headers['content-type']).toBe('image/jpeg');
    expect(bytes.headers['cache-control']).toBe('private, max-age=3600');
    expect((await sharp(bytes.body as Buffer).metadata()).format).toBe('jpeg');

    // Не изображение: чужой тип тела и «картинка», которая не разбирается.
    const text = await request(app).post(`/app/api/tasks/${w.taskId}/attachments`).set(as(tg)).set('Content-Type', 'text/plain').send('hello');
    expect(text.status).toBe(415);
    const broken = await request(app).post(`/app/api/tasks/${w.taskId}/attachments`).set(as(tg)).set('Content-Type', 'image/png').send(Buffer.from('not a png'));
    expect(broken.status).toBe(415);

    // Человек другой компании: ни прикрепить, ни список, ни байты.
    const other = await makeOrg();
    const strangerTg = nextTgId++;
    await linkTelegram(other.ownerId, strangerTg);
    expect((await request(app).post(`/app/api/tasks/${w.taskId}/attachments`).set(as(strangerTg)).set('Content-Type', 'image/png').send(await screenshot())).status).toBe(404);
    expect((await request(app).get(`/app/api/tasks/${w.taskId}/attachments`).set(as(strangerTg))).status).toBe(404);
    expect((await request(app).get(`/app/api/tasks/${w.taskId}/attachments/${up.body.id}`).set(as(strangerTg))).status).toBe(404);

    // Вложение другого дела по адресу своего — 404.
    const second = await inOrg(w.orgId, (db) => createTask(db, { ...base, title: 'второе дело', assigneeUserId: w.workerId }, { kind: 'user', userId: w.authorId }, MON_10), w.authorId);
    expect((await request(app).get(`/app/api/tasks/${second.id}/attachments/${up.body.id}`).set(as(tg))).status).toBe(404);

    // Закрытое дело: прикрепить нельзя.
    await inOrg(w.orgId, (db) => db.query(`update tasks set status = 'done' where id = $1`, [w.taskId]));
    expect((await request(app).post(`/app/api/tasks/${w.taskId}/attachments`).set(as(tg)).set('Content-Type', 'image/png').send(await screenshot())).status).toBe(404);
    await inOrg(w.orgId, (db) => db.query(`update tasks set status = 'cancelled' where id = $1`, [w.taskId]));
    expect((await request(app).get(`/app/api/tasks/${w.taskId}/attachments`).set(as(tg))).status).toBe(404);

    // Без подписи Telegram — 401, как у остальных ручек.
    expect((await request(app).get(`/app/api/tasks/${w.taskId}/attachments`)).status).toBe(401);
  });
});

// ---------------------------------------------------------------- досье агента

async function mcpClient(userId: string): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildMcpServer({ userId }).connect(serverT);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientT);
  return client;
}

describe('MCP: фото в досье', () => {
  it('get_task отдаёт attachments с source и author (имя — под untrusted); get_attachment отдаёт личное фото', async () => {
    const w = await world();
    const added = await attach(w, w.workerId, await screenshot());
    const owner = await mcpClient(w.ownerId);
    const got = await owner.callTool({ name: 'get_task', arguments: { org: w.orgId, task: w.taskId } }) as { isError?: boolean; content: { text: string }[] };
    expect(got.isError).toBeFalsy();
    const dossier = JSON.parse(got.content[0]!.text);
    expect(dossier.attachments).toEqual([expect.objectContaining({
      id: added.id, source: 'person', author: { untrusted: true, text: 'Ахмет' },
    })]);

    const img = await owner.callTool({ name: 'get_attachment', arguments: { org: w.orgId, attachment: added.id } }) as { isError?: boolean; content: { type: string; text?: string }[] };
    expect(img.isError).toBeFalsy();
    expect(img.content[0]!.type).toBe('image');
    expect(JSON.parse(img.content[1]!.text!)).toMatchObject({ id: added.id, source: 'person', author: { untrusted: true, text: 'Ахмет' } });
  });
});
