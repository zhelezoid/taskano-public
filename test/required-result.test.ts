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
import { transition } from '../src/core/lifecycle.js';
import { requiresResult } from '../src/core/required-result.js';
import { attachImage } from '../src/core/attachments.js';
import { AppError } from '../src/core/errors.js';
import { setMediaFetchForTests } from '../src/groups/media.js';
import { createBot } from '../src/bot/bot.js';
import { miniappRoutes } from '../src/web/miniapp-api.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { t } from '../src/i18n/index.js';
import type { Task } from '../src/core/types.js';
import { addPerson, inOrg, makeAgent, makeOrg, MON_10, uniq } from './helpers.js';

// Спека required-result: дело с `expected_result.required` не сдаётся без результата нужного
// вида — ни в ядре, ни через коннектор, ни в боте, ни в приложении; дела без `required` сдаются как
// прежде. Сеть Telegram и скачивание файлов подменены, файлы пишутся во временный каталог.

const MEDIA_DIR = mkdtempSync(join(tmpdir(), 'taskano-required-result-'));
const prevEnv = { MEDIA_DIR: process.env.MEDIA_DIR, TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN };
process.env.MEDIA_DIR = MEDIA_DIR;
process.env.TELEGRAM_BOT_TOKEN = 'test-token';

afterAll(async () => {
  setMediaFetchForTests(undefined);
  for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(MEDIA_DIR, { recursive: true, force: true });
  await closePools();
});

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
async function screenshot(): Promise<Buffer> {
  colorSeq += 1;
  return sharp({ create: { width: 640, height: 480, channels: 3, background: { r: colorSeq % 256, g: (colorSeq * 7) % 256, b: 90 } } })
    .png().toBuffer();
}

const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };

type ResultType = 'text' | 'number' | 'photo' | 'file';
const TEXT_14 = 'Сделал, звонил'; // ровно 14 знаков
const TEXT_15 = 'Сделал, звонил.'; // ровно 15 знаков
const TEXT_OK = 'Позвонил, договорились на 25-е';

interface World { orgId: string; ownerId: string; authorId: string; workerId: string; agentId: string }

async function world(lang = 'ru'): Promise<World> {
  const { orgId, ownerId } = await makeOrg();
  const authorId = await addPerson(orgId, 'member', { name: 'Олег' });
  const workerId = await addPerson(orgId, 'member', { name: 'Ахмет', language: lang });
  const agentId = await makeAgent(orgId, ownerId);
  return { orgId, ownerId, authorId, workerId, agentId };
}

/** Дело от агента исполнителю; `required: false` — просьба без замка. */
async function makeTask(w: World, type: ResultType | null, opts: { required?: boolean; title?: string } = {}): Promise<Task> {
  return inOrg(w.orgId, (db) => createTask(db, {
    ...base, title: opts.title ?? `дело ${uniq()}`, assigneeUserId: w.workerId,
    ...(type ? { expectedResult: { type, required: opts.required ?? true } } : {}),
  }, { kind: 'agent', agentId: w.agentId, userId: w.ownerId }, MON_10)) as Promise<Task>;
}

const me = (w: World) => ({ kind: 'user' as const, userId: w.workerId });
const submit = (w: World, task: Task, extra: Parameters<typeof transition>[4] = {}) =>
  inOrg(w.orgId, (db) => transition(db, task.id, 'submit', me(w), { now: MON_10, ...extra }));

async function refusal(p: Promise<unknown>): Promise<AppError> {
  try { await p; } catch (e) { if (e instanceof AppError) return e; throw e; }
  throw new Error('ожидался отказ');
}

const statusOf = async (w: World, id: string): Promise<string> =>
  (await inOrg(w.orgId, (db) => db.query('select status from tasks where id = $1', [id]))).rows[0].status;

// numeric приходит из базы строкой: сравниваем числами.
const resultsOf = async (w: World, id: string) =>
  (await inOrg(w.orgId, (db) => db.query('select text, number::float8 as number, files from task_results where task_id = $1 order by created_at', [id]))).rows;

/** Фото к делу от имени человека — так вложение появляется из бота и приложения. */
async function attachPhoto(w: World, task: Task, userId: string): Promise<void> {
  const image = await screenshot();
  await inOrg(w.orgId, (db) => attachImage(db, { taskId: task.id, userId, image, now: MON_10 }), userId);
}

// ---------------------------------------------------------------- ядро

describe('ядро: замок на сдаче', () => {
  it('1. text/number/photo без результата → validation_failed result_required, статус не меняется; с результатом — submitted', async () => {
    const w = await world();
    for (const type of ['text', 'number', 'photo'] as const) {
      const task = await makeTask(w, type);
      const before = await statusOf(w, task.id);
      const e = await refusal(submit(w, task));
      expect(e.code).toBe('validation_failed');
      expect(e.details).toEqual({ reason: 'result_required', type, min_length: 15 });
      expect(await statusOf(w, task.id)).toBe(before);
      expect(await resultsOf(w, task.id)).toHaveLength(0);
    }
    const ok = await makeTask(w, 'text');
    await submit(w, ok, { result: { text: TEXT_OK } });
    expect(await statusOf(w, ok.id)).toBe('submitted');
    expect(await resultsOf(w, ok.id)).toEqual([{ text: TEXT_OK, number: null, files: [] }]);
  });

  it('2. text: 14 символов — отказ (пробелы не в счёт), 15 — сдаётся', async () => {
    const w = await world();
    expect(TEXT_14).toHaveLength(14);
    expect(TEXT_15).toHaveLength(15);
    const short = await makeTask(w, 'text');
    expect((await refusal(submit(w, short, { result: { text: TEXT_14 } }))).details).toMatchObject({ reason: 'result_required' });
    expect((await refusal(submit(w, short, { result: { text: `   ${TEXT_14}    ` } }))).details).toMatchObject({ reason: 'result_required' });
    expect(await statusOf(w, short.id)).toBe('active');
    await submit(w, short, { result: { text: TEXT_15 } });
    expect(await statusOf(w, short.id)).toBe('submitted');
  });

  it('3. number: «abc» — отказ; «42», «3,5» и number: 42 — сдаётся, число записано числом', async () => {
    const w = await world();
    const t1 = await makeTask(w, 'number');
    expect((await refusal(submit(w, t1, { result: { text: 'abc' } }))).details).toMatchObject({ reason: 'result_required', type: 'number' });
    expect((await refusal(submit(w, t1, { result: { text: 'около 42 штук' } }))).code).toBe('validation_failed');
    expect((await refusal(submit(w, t1, { result: { number: Number.NaN } }))).code).toBe('validation_failed');
    await submit(w, t1, { result: { text: ' 42 ' } });
    expect((await resultsOf(w, t1.id))[0]).toMatchObject({ number: 42 });

    const t2 = await makeTask(w, 'number');
    await submit(w, t2, { result: { number: 42 } });
    expect(await statusOf(w, t2.id)).toBe('submitted');
    expect((await resultsOf(w, t2.id))[0]).toMatchObject({ number: 42 });

    const t3 = await makeTask(w, 'number');
    await submit(w, t3, { result: { text: '3,5' } });
    expect((await resultsOf(w, t3.id))[0]).toMatchObject({ number: 3.5 });
  });

  it('4. photo/file: фото исполнителя в task_attachments — сдаётся, фото другого человека — нет; файлы в результате тоже годятся', async () => {
    const w = await world();
    for (const type of ['photo', 'file'] as const) {
      const task = await makeTask(w, type);
      // Владелец приложил пример — исполнителю это не результат.
      await attachPhoto(w, task, w.ownerId);
      expect((await refusal(submit(w, task))).details).toMatchObject({ reason: 'result_required', type });
      expect(await statusOf(w, task.id)).toBe('active');
      await attachPhoto(w, task, w.workerId);
      await submit(w, task);
      expect(await statusOf(w, task.id)).toBe('submitted');
    }
    const withFiles = await makeTask(w, 'photo');
    await submit(w, withFiles, { result: { files: [{ telegram_file_id: 'x', kind: 'photo' }] } });
    expect(await statusOf(w, withFiles.id)).toBe('submitted');
  });

  it('5. после rework повторная сдача снова требует результат: прежний в task_results не засчитывается', async () => {
    const w = await world();
    const task = await makeTask(w, 'text');
    await submit(w, task, { result: { text: TEXT_OK } });
    await inOrg(w.orgId, (db) => transition(db, task.id, 'rework', { kind: 'agent', agentId: w.agentId, userId: w.ownerId }, { now: MON_10, text: 'не хватает цифр' }));
    // Из «доработки» дело тут же возвращается в «Сейчас» через очередь: важно лишь, что оно не сдано.
    expect(await statusOf(w, task.id)).not.toBe('submitted');
    expect((await refusal(submit(w, task))).details).toMatchObject({ reason: 'result_required' });
    expect(await statusOf(w, task.id)).not.toBe('submitted');
    await submit(w, task, { result: { text: 'Добавил цифры за неделю' } });
    expect(await statusOf(w, task.id)).toBe('submitted');
  });

  it('6. дело без required сдаётся без результата; личное дело с required — замок тот же', async () => {
    const w = await world();
    for (const type of [null, 'text', 'photo'] as const) {
      const task = await makeTask(w, type, { required: false });
      await submit(w, task);
      expect(await statusOf(w, task.id)).toBe('submitted');
      expect(await resultsOf(w, task.id)).toHaveLength(0);
    }
    // Своё дело (автор = исполнитель) с явно поставленным полем: замок не снимается.
    const own = await inOrg(w.orgId, (db) => createTask(db, {
      ...base, title: 'своё дело', assigneeUserId: w.workerId, expectedResult: { type: 'text', required: true },
    }, me(w), MON_10)) as Task;
    expect((await refusal(submit(w, own))).details).toMatchObject({ reason: 'result_required' });
    await submit(w, own, { result: { text: TEXT_OK } });
    expect(await statusOf(w, own.id)).toBe('done');
  });

  it('7. устаревшая версия карточки — прежний stale_version, а не result_required', async () => {
    const w = await world();
    const task = await makeTask(w, 'text');
    const e = await refusal(submit(w, task, { expectedVersion: task.version + 5 }));
    expect(e.code).toBe('stale_version');
  });
});

// ---------------------------------------------------------------- коннектор

async function callTool(userId: string, name: string, args: Record<string, unknown>) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildMcpServer({ userId }).connect(serverT);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientT);
  const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text: string }[] };
  const description = (await client.listTools()).tools.find((x) => x.name === 'submit_task')!.description!;
  return { isError: !!r.isError, data: JSON.parse(r.content[0]!.text), description };
}

describe('MCP submit_task', () => {
  it('8. без результата → ошибка с подсказкой, что передать; с результатом — сдано; описание говорит о замке', async () => {
    const w = await world();
    const text = await makeTask(w, 'text');
    const refused = await callTool(w.workerId, 'submit_task', { task: text.id });
    expect(refused.isError).toBe(true);
    expect(refused.data.code).toBe('validation_failed');
    expect(refused.data.message).toMatch(/"result".*15 characters/);
    expect(refused.data.details).toEqual({ reason: 'result_required', type: 'text', min_length: 15 });
    expect(refused.description).toMatch(/required/);
    expect(await statusOf(w, text.id)).toBe('active');

    const num = await makeTask(w, 'number');
    const refusedNum = await callTool(w.workerId, 'submit_task', { task: num.id, result: 'много' });
    expect(refusedNum.isError).toBe(true);
    expect(refusedNum.data.message).toMatch(/"number"/);
    const photo = await makeTask(w, 'photo');
    const refusedPhoto = await callTool(w.workerId, 'submit_task', { task: photo.id });
    expect(refusedPhoto.data.message).toMatch(/attach a photo .* in the bot or the app/);

    const okText = await callTool(w.workerId, 'submit_task', { task: text.id, result: TEXT_OK });
    expect(okText.isError).toBe(false);
    expect(await statusOf(w, text.id)).toBe('submitted');
    const okNum = await callTool(w.workerId, 'submit_task', { task: num.id, number: 7 });
    expect(okNum.isError).toBe(false);
  });

  it('9. дело без required через коннектор сдаётся без результата', async () => {
    const w = await world();
    const task = await makeTask(w, 'text', { required: false });
    const r = await callTool(w.workerId, 'submit_task', { task: task.id });
    expect(r.isError).toBe(false);
    expect(await statusOf(w, task.id)).toBe('submitted');
  });
});

// ---------------------------------------------------------------- приложение

const MINIAPP_TOKEN = 'test-bot-token-required-result';
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

let nextTgId = 91_000;

async function linkTelegram(userId: string, telegramUserId: number): Promise<void> {
  await withGlobal((db) => db.query(`insert into telegram_links(telegram_user_id, user_id, chat_id) values ($1, $2, $1)`, [telegramUserId, userId]));
}

describe('Mini App: POST /tasks/:id/done', () => {
  it('10. без результата → 4xx result_required, дело не сдано; с result.text ≥15 — сдано и результат сохранён', async () => {
    const w = await world();
    const task = await makeTask(w, 'text');
    const tg = nextTgId++;
    await linkTelegram(w.workerId, tg);
    const as = { 'X-Telegram-Init-Data': initDataFor(tg) };

    const refused = await request(app).post(`/app/api/tasks/${task.id}/done`).set(as).send({ version: task.version });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('validation_failed');
    expect(refused.body.details).toEqual({ reason: 'result_required', type: 'text', min_length: 15 });
    expect(await statusOf(w, task.id)).toBe('active');

    const short = await request(app).post(`/app/api/tasks/${task.id}/done`).set(as).send({ version: task.version, result: { text: TEXT_14 } });
    expect(short.status).toBe(400);
    expect(short.body.details.reason).toBe('result_required');

    const ok = await request(app).post(`/app/api/tasks/${task.id}/done`).set(as).send({ version: task.version, result: { text: TEXT_OK } });
    expect(ok.status).toBe(200);
    expect(await statusOf(w, task.id)).toBe('submitted');
    expect(await resultsOf(w, task.id)).toEqual([{ text: TEXT_OK, number: null, files: [] }]);
  });

  it('11. карточка отдаёт expected_result; число и фото закрываются полем и вложением', async () => {
    const w = await world();
    const text = await makeTask(w, 'text');
    const number = await makeTask(w, 'number');
    const photo = await makeTask(w, 'photo');
    const file = await makeTask(w, 'file');
    const plain = await makeTask(w, null);
    const soft = await makeTask(w, 'text', { required: false });
    const tg = nextTgId++;
    await linkTelegram(w.workerId, tg);
    const as = { 'X-Telegram-Init-Data': initDataFor(tg) };
    const card = async (id: string) => (await request(app).get(`/app/api/tasks/${id}`).set(as)).body.task;

    expect((await card(text.id)).expected_result).toEqual({ type: 'text', required: true, min_length: 15 });
    // Порог нужен только там, где результат — текст: у числа и фото он 0, у файла (текст-ссылка или фото) — как у текста.
    expect((await card(number.id)).expected_result).toEqual({ type: 'number', required: true, min_length: 0 });
    expect((await card(photo.id)).expected_result).toEqual({ type: 'photo', required: true, min_length: 0 });
    expect((await card(file.id)).expected_result).toEqual({ type: 'file', required: true, min_length: 15 });
    expect((await card(plain.id)).expected_result).toBeNull();
    expect((await card(soft.id)).expected_result).toMatchObject({ required: false });

    expect((await request(app).post(`/app/api/tasks/${number.id}/done`).set(as).send({ version: number.version, result: { text: 'abc' } })).status).toBe(400);
    expect((await request(app).post(`/app/api/tasks/${number.id}/done`).set(as).send({ version: number.version, result: { number: 12 } })).status).toBe(200);

    expect((await request(app).post(`/app/api/tasks/${photo.id}/done`).set(as).send({ version: photo.version })).status).toBe(400);
    const up = await request(app).post(`/app/api/tasks/${photo.id}/attachments`).set(as).set('Content-Type', 'image/png').send(await screenshot());
    expect(up.status).toBe(200);
    expect((await request(app).post(`/app/api/tasks/${photo.id}/done`).set(as).send({ version: photo.version })).status).toBe(200);
    expect(await statusOf(w, photo.id)).toBe('submitted');
  });

  it('12. тело result проверяется по типам; дело без required сдаётся без результата', async () => {
    const w = await world();
    const task = await makeTask(w, 'text');
    const soft = await makeTask(w, 'text', { required: false });
    const tg = nextTgId++;
    await linkTelegram(w.workerId, tg);
    const as = { 'X-Telegram-Init-Data': initDataFor(tg) };
    const post = (id: string, version: number, result: unknown) =>
      request(app).post(`/app/api/tasks/${id}/done`).set(as).send({ version, result });

    for (const bad of [{ text: 42 }, { number: '42' }, 'text', [TEXT_OK], { text: 'x'.repeat(2001) }]) {
      const r = await post(task.id, task.version, bad);
      expect(r.status).toBe(400);
      expect(r.body.details?.reason).not.toBe('result_required');
    }
    expect(await statusOf(w, task.id)).toBe('active');

    const r = await request(app).post(`/app/api/tasks/${soft.id}/done`).set(as).send({ version: soft.version });
    expect(r.status).toBe(200);
    expect(await statusOf(w, soft.id)).toBe('submitted');
    expect(await resultsOf(w, soft.id)).toHaveLength(0);
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
const tgUser = (id: number, lang = 'ru'): TgUser => ({ id, is_bot: false, first_name: 'Person', language_code: lang });

function textMessage(from: TgUser, text: string): Update {
  return {
    update_id: nextUpdateId++,
    message: { message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: from!.id, type: 'private', first_name: 'P' }, from, text },
  } as unknown as Update;
}

async function photoMessage(from: TgUser): Promise<Update> {
  const fileId = `f-${uniq()}`;
  telegramFiles.set(fileId, await screenshot());
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: from!.id, type: 'private', first_name: 'P' }, from,
      photo: [{ file_id: `${fileId}-s`, file_unique_id: `u-${fileId}-s`, width: 90, height: 60 }, { file_id: fileId, file_unique_id: `u-${fileId}`, width: 640, height: 480 }],
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

const texts = (method = 'sendMessage'): string[] => sent.filter((s) => s.method === method).map((s) => String(s.payload.text ?? ''));

async function botWorker(w: World, lang = 'ru'): Promise<TgUser> {
  const from = tgUser(nextTgId++, lang);
  await linkTelegram(w.workerId, from!.id);
  return from;
}

const waitState = async (from: TgUser): Promise<{ state: string; data: Record<string, unknown> } | null> =>
  (await withGlobal((db) => db.query('select state, data from bot_dialogs where user_key = $1', [`tg:${from!.id}`]))).rows[0] ?? null;

describe('бот: «Завершить»', () => {
  it('13. без результата — вопрос на языке человека, дело не сдано; короткий текст — снова вопрос; ≥15 символов сдаёт дело с этим результатом', async () => {
    const w = await world();
    const task = await makeTask(w, 'text');
    const from = await botWorker(w);

    await bot.handleUpdate(callbackUpdate(from, `a:done:${task.short_id}:${task.version}`));
    const ask = t('ru', 'result.ask_text', { min: 15 });
    expect(texts()).toContain(ask);
    expect(ask).toContain('15');
    expect(await statusOf(w, task.id)).toBe('active');
    expect((await waitState(from))?.state).toBe('await_result');
    // Просьба — с кнопкой «Отмена».
    const askMsg = sent.filter((s) => s.method === 'sendMessage').at(-1)!;
    expect(JSON.stringify(askMsg.payload.reply_markup)).toContain('x:cancel');

    sent = [];
    await bot.handleUpdate(textMessage(from, TEXT_14));
    expect(texts()).toContain(ask);
    expect(await statusOf(w, task.id)).toBe('active');
    expect((await waitState(from))?.state).toBe('await_result');

    sent = [];
    await bot.handleUpdate(textMessage(from, TEXT_OK));
    expect(await statusOf(w, task.id)).toBe('submitted');
    expect(await resultsOf(w, task.id)).toEqual([{ text: TEXT_OK, number: null, files: [] }]);
    expect(texts('editMessageText').some((x) => x.includes(t('ru', 'done.submitted')))).toBe(true);
    expect(texts()).not.toContain(ask);
  });

  it('14. число: слова — снова вопрос, «42» — сдаёт; на английском вопрос английский', async () => {
    const w = await world('en');
    const task = await makeTask(w, 'number');
    const from = await botWorker(w, 'en');
    await bot.handleUpdate(callbackUpdate(from, `a:done:${task.short_id}:${task.version}`));
    expect(texts()).toContain(t('en', 'result.ask_number'));
    expect(t('en', 'result.ask_number')).not.toBe(t('ru', 'result.ask_number'));

    sent = [];
    await bot.handleUpdate(textMessage(from, 'примерно сорок'));
    expect(texts()).toContain(t('en', 'result.ask_number'));
    expect(await statusOf(w, task.id)).toBe('active');
    await bot.handleUpdate(textMessage(from, '42'));
    expect(await statusOf(w, task.id)).toBe('submitted');
    expect((await resultsOf(w, task.id))[0]).toMatchObject({ number: 42 });
  });

  it('15. фото: «Завершить» просит фото; текст — снова просьба; фото прикрепляется и сдаёт дело', async () => {
    const w = await world();
    const task = await makeTask(w, 'photo');
    const from = await botWorker(w);
    await bot.handleUpdate(callbackUpdate(from, `a:done:${task.short_id}:${task.version}`));
    expect(texts()).toContain(t('ru', 'result.ask_photo'));
    expect(await statusOf(w, task.id)).toBe('active');

    sent = [];
    await bot.handleUpdate(textMessage(from, 'вот, всё готово, честно-честно'));
    expect(texts()).toContain(t('ru', 'result.ask_photo'));
    expect(await statusOf(w, task.id)).toBe('active');

    await bot.handleUpdate(await photoMessage(from));
    expect(await statusOf(w, task.id)).toBe('submitted');
    const att = await inOrg(w.orgId, (db) => db.query('select source, author_user_id from task_attachments where task_id = $1', [task.id]));
    expect(att.rows).toEqual([{ source: 'person', author_user_id: w.workerId }]);
  });

  it('16. «Отмена» под вопросом снимает ожидание: следующий текст дело не сдаёт', async () => {
    const w = await world();
    const task = await makeTask(w, 'text');
    const from = await botWorker(w);
    await bot.handleUpdate(callbackUpdate(from, `a:done:${task.short_id}:${task.version}`));
    const askId = (await waitState(from))!.data.askId as number;
    expect(askId).toBeTypeOf('number');
    await bot.handleUpdate(callbackUpdate(from, 'x:cancel', askId));
    await bot.handleUpdate(textMessage(from, TEXT_OK));
    expect(await statusOf(w, task.id)).toBe('active');
  });

  it('17. дело без required сдаётся сразу, без вопроса', async () => {
    const w = await world();
    const task = await makeTask(w, 'text', { required: false });
    const from = await botWorker(w);
    await bot.handleUpdate(callbackUpdate(from, `a:done:${task.short_id}:${task.version}`));
    expect(await statusOf(w, task.id)).toBe('submitted');
    expect(texts()).not.toContain(t('ru', 'result.ask_text', { min: 15 }));
    expect((await waitState(from))?.state ?? 'idle').not.toBe('await_result');
  });

  it('18. «Да, готово» по разбору группы без нужного результата просит его, как «Завершить»', async () => {
    const w = await world();
    const task = await makeTask(w, 'text');
    const from = await botWorker(w);
    // Пересказа в уведомлении нет, фото нет — автоматике сдавать нечем.
    await bot.handleUpdate(callbackUpdate(from, `a:myes:${task.short_id}:${task.version}`));
    expect(texts()).toContain(t('ru', 'result.ask_text', { min: 15 }));
    expect(await statusOf(w, task.id)).toBe('active');
    expect((await waitState(from))?.state).toBe('await_result');
    await bot.handleUpdate(textMessage(from, TEXT_OK));
    expect(await statusOf(w, task.id)).toBe('submitted');
  });
});

// ================================================================= ревью: дыры замка

/** Детали отказа ядра или `null`, если сдача прошла. */
async function refusedDetails(p: Promise<unknown>): Promise<Record<string, unknown> | null> {
  try { await p; } catch (e) { if (e instanceof AppError) return e.details as Record<string, unknown>; throw e; }
  return null;
}

describe('ядро: число, невидимые знаки, файл', () => {
  it('19. число с разделителем тысяч неоднозначно: «1.500», «1,000», «1.234,5» — отказ с подсказкой; «1.5», «1,25», «3.14159» (4+ цифр — дробь) — сдаются', async () => {
    const w = await world();
    for (const text of ['1.500', '1,000', '1.234,5', '1,000,000', '1 500', '-2.000']) {
      const task = await makeTask(w, 'number');
      expect(await refusedDetails(submit(w, task, { result: { text } })), text).toEqual({ reason: 'result_required', type: 'number', min_length: 15, hint: 'number_format' });
      expect(await statusOf(w, task.id)).not.toBe('submitted');
    }
    const e = await refusal(submit(w, await makeTask(w, 'number'), { result: { text: '1.500' } }));
    expect(e.message).toMatch(/without thousands separators/);
    for (const [text, value] of [['1.5', 1.5], ['1,25', 1.25], ['-3,5', -3.5], ['1500', 1500], ['3.14159', 3.14159], ['2,5', 2.5], ['0.1234', 0.1234]] as const) {
      const task = await makeTask(w, 'number');
      await submit(w, task, { result: { text } });
      expect((await resultsOf(w, task.id))[0], text).toMatchObject({ number: value });
    }
  });

  it('20. слова вместо числа — отказ без подсказки про разделители; 400 девяток (бесконечность) — отказ', async () => {
    const w = await world();
    const words = await refusedDetails(submit(w, await makeTask(w, 'number'), { result: { text: 'примерно сорок' } }));
    expect(words).toEqual({ reason: 'result_required', type: 'number', min_length: 15 });
    const huge = await makeTask(w, 'number');
    expect(await refusedDetails(submit(w, huge, { result: { text: '9'.repeat(400) } }))).toMatchObject({ reason: 'result_required' });
    expect(await statusOf(w, huge.id)).not.toBe('submitted');
    expect(await resultsOf(w, huge.id)).toHaveLength(0);
  });

  it('21. невидимые знаки и пустая пунктуация не набирают порог: нули ширины, BOM, «...............» — отказ', async () => {
    const w = await world();
    const ZW = '​‌‍﻿';
    const fakes = [
      '​'.repeat(20),
      `Сделал${ZW}${ZW}${ZW}`, // 6 видимых знаков + 12 невидимых
      '.'.repeat(15),
      '!?-- ... ,,, ;;; :::',
      ' '.repeat(5) + '﻿'.repeat(15),
    ];
    for (const text of fakes) {
      const task = await makeTask(w, 'text');
      expect(await refusedDetails(submit(w, task, { result: { text } })), JSON.stringify(text)).toMatchObject({ reason: 'result_required' });
      expect(await statusOf(w, task.id)).not.toBe('submitted');
    }
    // Настоящий текст с невидимым знаком внутри засчитывается, если без него длины достаточно.
    const ok = await makeTask(w, 'text');
    await submit(w, ok, { result: { text: `Позвонил,${ZW} договорились на 25-е` } });
    expect(await statusOf(w, ok.id)).toBe('submitted');
    // Число с невидимым знаком читается как число.
    const num = await makeTask(w, 'number');
    await submit(w, num, { result: { text: '42​' } });
    expect((await resultsOf(w, num.id))[0]).toMatchObject({ number: 42 });
  });

  it('22. file: закрывается фото исполнителя или текстом ≥15 знаков; короткий текст и пустота — отказ; photo — только фото', async () => {
    const w = await world();
    const bare = await makeTask(w, 'file');
    expect((await refusal(submit(w, bare))).details).toMatchObject({ reason: 'result_required', type: 'file' });
    expect((await refusal(submit(w, bare, { result: { text: TEXT_14 } }))).details).toMatchObject({ reason: 'result_required', type: 'file' });
    expect((await refusal(submit(w, bare, { result: { text: '.'.repeat(20) } }))).details).toMatchObject({ reason: 'result_required' });
    await submit(w, bare, { result: { text: 'https://drive.example/отчёт.xlsx' } });
    expect(await statusOf(w, bare.id)).toBe('submitted');
    expect((await resultsOf(w, bare.id))[0]).toMatchObject({ text: 'https://drive.example/отчёт.xlsx' });

    const withPhoto = await makeTask(w, 'file');
    await attachPhoto(w, withPhoto, w.workerId);
    await submit(w, withPhoto);
    expect(await statusOf(w, withPhoto.id)).toBe('submitted');

    // Фото-дело текстом не закрывается: нужна именно картинка.
    const photo = await makeTask(w, 'photo');
    expect((await refusal(submit(w, photo, { result: { text: TEXT_OK } }))).details).toMatchObject({ reason: 'result_required', type: 'photo' });
    expect(await statusOf(w, photo.id)).not.toBe('submitted');
  });

  it('23. ожидание (kind waiting) замка не имеет: requiresResult ложь, карточка expected_result не отдаёт', async () => {
    expect(requiresResult({ kind: 'waiting', expected_result: { type: 'text', required: true } })).toBe(false);
    expect(requiresResult({ kind: 'action', expected_result: { type: 'text', required: true } })).toBe(true);
    expect(requiresResult({ kind: 'action', expected_result: { type: 'text', required: false } })).toBe(false);
    expect(requiresResult({ kind: 'action', expected_result: null })).toBe(false);

    const w = await world();
    const waiting = await inOrg(w.orgId, (db) => createTask(db, {
      ...base, title: `ожидание ${uniq()}`, assigneeUserId: w.workerId, kind: 'waiting',
      waiting: { waitingFor: 'ответа поставщика', expectedAt: '2026-12-30' },
      expectedResult: { type: 'text', required: true },
    }, { kind: 'agent', agentId: w.agentId, userId: w.ownerId }, MON_10)) as Task;
    const tg = nextTgId++;
    await linkTelegram(w.workerId, tg);
    const as = { 'X-Telegram-Init-Data': initDataFor(tg) };
    const card = (await request(app).get(`/app/api/tasks/${waiting.id}`).set(as)).body.task;
    expect(card.expected_result).toBeNull();
  });

  it('24. приложение сохраняет результат обрезанным по краям', async () => {
    const w = await world();
    const task = await makeTask(w, 'text');
    const tg = nextTgId++;
    await linkTelegram(w.workerId, tg);
    const as = { 'X-Telegram-Init-Data': initDataFor(tg) };
    const ok = await request(app).post(`/app/api/tasks/${task.id}/done`).set(as).send({ version: task.version, result: { text: `   ${TEXT_OK}\n  ` } });
    expect(ok.status).toBe(200);
    expect(await resultsOf(w, task.id)).toEqual([{ text: TEXT_OK, number: null, files: [] }]);
  });

  it('25. MCP: число с тысячными разделителями — ошибка с подсказкой по-английски; file принимает текст', async () => {
    const w = await world();
    const task = await makeTask(w, 'number');
    const r = await callTool(w.workerId, 'submit_task', { task: task.id, result: '1.500' });
    expect(r.isError).toBe(true);
    expect(r.data.message).toMatch(/write the number without thousands separators/);
    expect(r.data.details).toMatchObject({ hint: 'number_format' });
    const file = await makeTask(w, 'file');
    const rf = await callTool(w.workerId, 'submit_task', { task: file.id });
    expect(rf.data.message).toMatch(/where the file is.*or attach a photo/);
    const okFile = await callTool(w.workerId, 'submit_task', { task: file.id, result: 'файл лежит на общем диске, папка «Отчёты»' });
    expect(okFile.isError).toBe(false);
  });
});

// ---------------------------------------------------------------- бот: ревью

/** Сообщение без текста и фото: голос, стикер, документ. */
function mediaMessage(from: TgUser, extra: Record<string, unknown>): Update {
  return {
    update_id: nextUpdateId++,
    message: { message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: from!.id, type: 'private', first_name: 'P' }, from, ...extra },
  } as unknown as Update;
}

/** Сдвинуть время ожиданий человека в прошлое — как будто вопрос задан давно. */
async function ageWaits(from: TgUser, minutesAgo: number): Promise<void> {
  await withGlobal(async (db) => {
    const r = await db.query(`select data from bot_dialogs where user_key = $1`, [`tg:${from!.id}`]);
    const data = r.rows[0].data as { _waits: { at: string }[] };
    const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    for (const x of data._waits) x.at = at;
    await db.query(`update bot_dialogs set data = $2 where user_key = $1`, [`tg:${from!.id}`, JSON.stringify(data)]);
  });
}

const pressDone = (from: TgUser, task: Task) => bot.handleUpdate(callbackUpdate(from, `a:done:${task.short_id}:${task.version}`));

describe('бот: ревью — ответ на «пришлите результат»', () => {
  it('26. голос, стикер, видео, не-картинка: просьба повторяется, дело не сдано, ожидание живо', async () => {
    const w = await world();
    const task = await makeTask(w, 'text');
    const from = await botWorker(w);
    await pressDone(from, task);
    const ask = t('ru', 'result.ask_text', { min: 15 });
    const variants: Record<string, unknown>[] = [
      { voice: { file_id: 'v1', file_unique_id: 'uv1', duration: 3 } },
      { sticker: { file_id: 's1', file_unique_id: 'us1', width: 1, height: 1, type: 'regular', is_animated: false, is_video: false } },
      { video: { file_id: 'vd1', file_unique_id: 'uvd1', width: 1, height: 1, duration: 1 } },
      { document: { file_id: 'd1', file_unique_id: 'ud1', mime_type: 'application/pdf', file_name: 'a.pdf', file_size: 100 } },
    ];
    for (const v of variants) {
      sent = [];
      await bot.handleUpdate(mediaMessage(from, v));
      expect(texts(), Object.keys(v)[0]).toContain(ask);
      expect(await statusOf(w, task.id)).not.toBe('submitted');
      expect((await waitState(from))?.state).toBe('await_result');
    }
  });

  it('27. file: «Завершить» просит фото или текст; не-картинка и голос — та же просьба; текст ≥15 знаков сдаёт', async () => {
    const w = await world();
    const task = await makeTask(w, 'file');
    const from = await botWorker(w);
    await pressDone(from, task);
    const ask = t('ru', 'result.ask_file', { min: 15 });
    expect(texts()).toContain(ask);
    expect(ask).toMatch(/фото/);
    expect(ask).toMatch(/15/);
    sent = [];
    await bot.handleUpdate(mediaMessage(from, { document: { file_id: 'd2', file_unique_id: 'ud2', mime_type: 'application/pdf', file_name: 'a.pdf', file_size: 100 } }));
    expect(texts()).toContain(ask);
    await bot.handleUpdate(mediaMessage(from, { voice: { file_id: 'v2', file_unique_id: 'uv2', duration: 3 } }));
    expect(await statusOf(w, task.id)).not.toBe('submitted');
    await bot.handleUpdate(textMessage(from, 'файл на общем диске, папка Отчёты'));
    expect(await statusOf(w, task.id)).toBe('submitted');
    expect((await resultsOf(w, task.id))[0]).toMatchObject({ text: 'файл на общем диске, папка Отчёты' });
  });

  it('28. file: фото сдаёт дело', async () => {
    const w = await world();
    const task = await makeTask(w, 'file');
    const from = await botWorker(w);
    await pressDone(from, task);
    await bot.handleUpdate(await photoMessage(from));
    expect(await statusOf(w, task.id)).toBe('submitted');
  });

  it('29. текст с вопросительным знаком в конце — не результат: просьба повторяется, дело не сдано', async () => {
    const w = await world();
    const task = await makeTask(w, 'text');
    const from = await botWorker(w);
    await pressDone(from, task);
    const ask = t('ru', 'result.ask_text', { min: 15 });
    sent = [];
    await bot.handleUpdate(textMessage(from, 'А что именно нужно написать в отчёте?'));
    expect(texts()).toContain(ask);
    expect(await statusOf(w, task.id)).not.toBe('submitted');
    expect(await resultsOf(w, task.id)).toHaveLength(0);
    expect((await waitState(from))?.state).toBe('await_result');
    await bot.handleUpdate(textMessage(from, TEXT_OK));
    expect(await statusOf(w, task.id)).toBe('submitted');
  });

  it('30. ожидание старше 10 минут: текст не сдаёт дело молча, бот спрашивает «К какому делу?»; выбор дела сдаёт', async () => {
    const w = await world();
    const task = await makeTask(w, 'text');
    const from = await botWorker(w);
    await pressDone(from, task);
    await ageWaits(from, 11);
    sent = [];
    await bot.handleUpdate(textMessage(from, TEXT_OK));
    expect(texts()).toContain(t('ru', 'dialog.which_task'));
    expect(await statusOf(w, task.id)).not.toBe('submitted');
    await bot.handleUpdate(callbackUpdate(from, `wq:${task.short_id}`, 9911));
    expect(await statusOf(w, task.id)).toBe('submitted');
    expect((await resultsOf(w, task.id))[0]).toMatchObject({ text: TEXT_OK });
  });

  it('31. ожидание свежее (5 минут) сдаёт без переспроса', async () => {
    const w = await world();
    const task = await makeTask(w, 'text');
    const from = await botWorker(w);
    await pressDone(from, task);
    await ageWaits(from, 5);
    sent = [];
    await bot.handleUpdate(textMessage(from, TEXT_OK));
    expect(texts()).not.toContain(t('ru', 'dialog.which_task'));
    expect(await statusOf(w, task.id)).toBe('submitted');
  });

  it('32. повторная просьба продлевает ожидание: ответ на неё не переспрашивается, хотя первая была давно', async () => {
    const w = await world();
    const task = await makeTask(w, 'text');
    const from = await botWorker(w);
    await pressDone(from, task);
    await ageWaits(from, 9);
    await bot.handleUpdate(textMessage(from, TEXT_14)); // слишком коротко: просьба ещё раз, отсчёт заново
    const waits = (await withGlobal((db) => db.query('select data from bot_dialogs where user_key = $1', [`tg:${from!.id}`]))).rows[0].data._waits as { at: string }[];
    expect(Date.now() - Date.parse(waits[0]!.at)).toBeLessThan(60_000);
    sent = [];
    await bot.handleUpdate(textMessage(from, TEXT_OK));
    expect(texts()).not.toContain(t('ru', 'dialog.which_task'));
    expect(await statusOf(w, task.id)).toBe('submitted');
  });

  it('33. подтверждение повторяет принятый результат; длинный обрезается; диалог закрыт', async () => {
    const w = await world();
    const task = await makeTask(w, 'text');
    const from = await botWorker(w);
    await pressDone(from, task);
    await bot.handleUpdate(textMessage(from, TEXT_OK));
    const confirm = texts('editMessageText').find((x) => x.includes(t('ru', 'done.submitted')))!;
    expect(confirm).toContain(t('ru', 'result.accepted', { result: TEXT_OK }));
    expect(confirm).toContain('«Позвонил, договорились на 25-е»');
    // Диалог закрыт: ожидания результата больше нет.
    expect((await waitState(from))?.state ?? 'idle').not.toBe('await_result');

    const long = await makeTask(w, 'text');
    await pressDone(from, long);
    sent = [];
    await bot.handleUpdate(textMessage(from, 'ы'.repeat(300)));
    const echo = texts('editMessageText').find((x) => x.includes('ы'))!;
    expect(echo).toContain(`«${'ы'.repeat(200)}…»`);
    expect(echo).not.toContain('ы'.repeat(201));
    expect((await resultsOf(w, long.id))[0]!.text).toHaveLength(300);
  });

  it('34. версия карточки между вопросом и ответом ушла вперёд — «карточка устарела», дело не сдано', async () => {
    const w = await world();
    const task = await makeTask(w, 'text');
    const from = await botWorker(w);
    await pressDone(from, task);
    await inOrg(w.orgId, (db) => db.query('update tasks set version = version + 1 where id = $1', [task.id]));
    sent = [];
    await bot.handleUpdate(textMessage(from, TEXT_OK));
    expect(texts()).toContain(t('ru', 'card.stale'));
    expect(await statusOf(w, task.id)).not.toBe('submitted');
    expect(await resultsOf(w, task.id)).toHaveLength(0);
    expect((await waitState(from))?.state ?? 'idle').not.toBe('await_result');
  });

  it('35. число «1.500» в боте — просьба писать без разделителей тысяч, дело не сдано', async () => {
    const w = await world();
    const task = await makeTask(w, 'number');
    const from = await botWorker(w);
    await pressDone(from, task);
    sent = [];
    await bot.handleUpdate(textMessage(from, '1.500'));
    expect(texts()).toContain(t('ru', 'result.ask_number_plain'));
    expect(t('ru', 'result.ask_number_plain')).toMatch(/без разделителей тысяч/);
    expect(await statusOf(w, task.id)).not.toBe('submitted');
    await bot.handleUpdate(textMessage(from, '1500'));
    expect(await statusOf(w, task.id)).toBe('submitted');
  });
});

describe('бот: ревью — повторная просьба', () => {
  it('39. повторная просьба несёт «Отмена», как первая; прежняя просьба убрана; отмена снимает ожидание', async () => {
    const w = await world();
    const task = await makeTask(w, 'text');
    const from = await botWorker(w);
    await pressDone(from, task);
    const firstAsk = (await waitState(from))!.data.askId as number;
    sent = [];
    await bot.handleUpdate(textMessage(from, TEXT_14));
    const again = sent.filter((s) => s.method === 'sendMessage').at(-1)!;
    expect(again.payload.text).toBe(t('ru', 'result.ask_text', { min: 15 }));
    expect(JSON.stringify(again.payload.reply_markup)).toContain('x:cancel');
    // Кнопок «Отмена» не стало две: прежняя просьба удалена, ожидание помнит новую.
    expect(sent.some((s) => s.method === 'deleteMessage' && s.payload.message_id === firstAsk)).toBe(true);
    const newAsk = (await waitState(from))!.data.askId as number;
    expect(newAsk).not.toBe(firstAsk);
    await bot.handleUpdate(callbackUpdate(from, 'x:cancel', newAsk));
    await bot.handleUpdate(textMessage(from, TEXT_OK));
    expect(await statusOf(w, task.id)).toBe('active');
  });
});

// ---------------------------------------------------------------- «Да, готово» по разбору группы

/** Фото в группе от `authorId`, привязанное к делу: так вложение появляется после разбора группы (автор — в сообщении группы). */
async function groupPhoto(w: World, task: Task, authorId: string): Promise<void> {
  await inOrg(w.orgId, async (db) => {
    const chat = await db.query(
      `insert into group_chats(org_id, telegram_chat_id) values ($1, $2) returning id`, [w.orgId, -Math.floor(Math.random() * 1e12)]);
    const media = await db.query(
      `insert into media(org_id, sha256, path, expires_at) values ($1, $2, $3, now() + interval '30 days') returning id`,
      [w.orgId, `sha-${uniq()}${uniq()}`, `${w.orgId}/${uniq()}.jpg`]);
    const msg = await db.query(
      `insert into group_messages(org_id, group_id, telegram_message_id, author_user_id, sent_at, expires_at, media_id)
       values ($1, $2, $3, $4, now(), now() + interval '30 days', $5) returning id`,
      [w.orgId, chat.rows[0].id, Math.floor(Math.random() * 1e9), authorId, media.rows[0].id]);
    await db.query(
      `insert into task_attachments(org_id, task_id, media_id, message_id, source) values ($1, $2, $3, $4, 'group')`,
      [w.orgId, task.id, media.rows[0].id, msg.rows[0].id]);
  });
}

async function maybeDone(w: World, task: Task, summary: string): Promise<void> {
  await inOrg(w.orgId, (db) => db.query(
    `insert into notifications(org_id, user_id, kind, level, task_id, payload) values ($1, $2, 'maybe_done', 'work', $3, $4)`,
    [w.orgId, w.workerId, task.id, JSON.stringify({ summary })]));
}

describe('бот: ревью — «Да, готово» по разбору группы', () => {
  const myes = (from: TgUser, task: Task) => bot.handleUpdate(callbackUpdate(from, `a:myes:${task.short_id}:${task.version}`));

  it('36. text/number/file: пересказ группы результатом не служит — бот спрашивает человека, результата в базе нет', async () => {
    const w = await world();
    const from = await botWorker(w);
    for (const [type, key] of [['text', 'result.ask_text'], ['number', 'result.ask_number'], ['file', 'result.ask_file']] as const) {
      const task = await makeTask(w, type);
      await maybeDone(w, task, 'Исполнитель сообщил, что отчёт выложен на диск');
      sent = [];
      await myes(from, task);
      expect(texts(), type).toContain(t('ru', key, { min: 15 }));
      expect(await statusOf(w, task.id)).not.toBe('submitted');
      expect(await resultsOf(w, task.id)).toHaveLength(0);
    }
  });

  it('37. photo: чужое фото из группы дело не сдаёт, фото самого исполнителя (автор — в сообщении группы) — сдаёт; пересказ годится довеском', async () => {
    const w = await world();
    const from = await botWorker(w);
    const stranger = await addPerson(w.orgId, 'member', { name: 'Сосед' });

    const foreign = await makeTask(w, 'photo');
    await maybeDone(w, foreign, 'на фото полка');
    await groupPhoto(w, foreign, stranger);
    sent = [];
    await myes(from, foreign);
    expect(texts()).toContain(t('ru', 'result.ask_photo'));
    expect(await statusOf(w, foreign.id)).not.toBe('submitted');
    expect(await resultsOf(w, foreign.id)).toHaveLength(0);

    const own = await makeTask(w, 'photo');
    await maybeDone(w, own, 'на фото полка');
    await groupPhoto(w, own, w.workerId);
    const authorOf = await inOrg(w.orgId, (db) => db.query('select author_user_id from task_attachments where task_id = $1', [own.id]));
    expect(authorOf.rows[0].author_user_id).toBeNull(); // автор вложения — только в сообщении группы
    await myes(from, own);
    expect(await statusOf(w, own.id)).toBe('submitted');
    expect((await resultsOf(w, own.id))[0]).toMatchObject({ text: 'на фото полка' });
    expect((await resultsOf(w, own.id))[0].files).toHaveLength(1);
  });

  it('38. file: фото исполнителя из группы сдаёт дело без пересказа, чужое — нет', async () => {
    const w = await world();
    const from = await botWorker(w);
    const stranger = await addPerson(w.orgId, 'member', { name: 'Сосед' });
    const foreign = await makeTask(w, 'file');
    await maybeDone(w, foreign, 'выложен файл на диск');
    await groupPhoto(w, foreign, stranger);
    await myes(from, foreign);
    expect(await statusOf(w, foreign.id)).not.toBe('submitted');

    const own = await makeTask(w, 'file');
    await maybeDone(w, own, 'выложен файл на диск');
    await groupPhoto(w, own, w.workerId);
    await myes(from, own);
    expect(await statusOf(w, own.id)).toBe('submitted');
    expect((await resultsOf(w, own.id))[0]!.text).toBeNull();
  });
});
