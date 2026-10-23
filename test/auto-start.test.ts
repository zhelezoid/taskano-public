process.env.TASKANO_DISABLE_RATE_LIMIT = '1';

import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import express from 'express';
import request from 'supertest';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Update, UserFromGetMe } from 'grammy/types';
import { closePools, withGlobal } from '../src/db/pool.js';
import { createTask } from '../src/core/tasks.js';
import { answerQuestion, transition } from '../src/core/lifecycle.js';
import { stopTask, takeTask } from '../src/core/queue.js';
import { addHumanComment } from '../src/core/comments.js';
import { attachImage } from '../src/core/attachments.js';
import { cleanImage, setMediaFetchForTests } from '../src/groups/media.js';
import { ensurePersonalOrg } from '../src/core/people.js';
import { isWorkingTime, loadUserSchedule, type Schedule } from '../src/core/calendar.js';
import type { Task } from '../src/core/types.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { taskDossier } from '../src/mcp/dossier.js';
import { createBot } from '../src/bot/bot.js';
import { deliverNotification } from '../src/bot/deliver.js';
import { laterChoices } from '../src/bot/take-prompt.js';
import { miniappRoutes } from '../src/web/miniapp-api.js';
import { dictKeys, LANGS, t } from '../src/i18n/index.js';
import { STRINGS } from '../app/src/i18n.js';
import { addPerson, inOrg, makeAgent, makeOrg, minutes, MON_10, uniq } from './helpers.js';

// Начало работы без кнопки «Взять» (спека auto-start): первое действие исполнителя
// начинает дело само; в боте открыл и не начал — через минуту «Берёшь сейчас?».

// Фото из лички бота: сеть Telegram подменена, файлы — во временный каталог (как в task-photos).
const MEDIA_DIR = mkdtempSync(join(tmpdir(), 'taskano-auto-start-'));
const prevEnv = { MEDIA_DIR: process.env.MEDIA_DIR, TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN };
process.env.MEDIA_DIR = MEDIA_DIR;
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
const telegramFiles = new Map<string, Buffer>();
/** file_id, чьё скачивание задерживается (первое фото альбома качается дольше соседей). */
let slowFileId: string | null = null;

beforeAll(() => {
  setMediaFetchForTests(async (url) => {
    if (slowFileId && url.includes(slowFileId)) await new Promise((r) => setTimeout(r, 400));
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

afterAll(async () => {
  setMediaFetchForTests(undefined);
  for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(MEDIA_DIR, { recursive: true, force: true });
  await closePools();
});

const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };

let colorSeq = 0;
async function screenshot(): Promise<Buffer> {
  colorSeq += 1;
  return sharp({ create: { width: 320, height: 240, channels: 3, background: { r: colorSeq % 256, g: (colorSeq * 13) % 256, b: 40 } } })
    .png().toBuffer();
}

/** Организация: агент ставит дела человеку. */
async function world() {
  const { orgId, ownerId } = await makeOrg();
  const person = await addPerson(orgId);
  const agentId = await makeAgent(orgId, ownerId);
  const agent = { kind: 'agent' as const, agentId, userId: ownerId };
  const me = { kind: 'user' as const, userId: person };
  const make = (title: string, at: Date = MON_10) =>
    inOrg(orgId, (db) => createTask(db, { ...base, title, assigneeUserId: person }, agent, at));
  const task = async (id: string) =>
    (await inOrg(orgId, (db) => db.query('select * from tasks where id = $1', [id]), person)).rows[0] as Task;
  const autoEvents = async (id: string) => (await inOrg(orgId, (db) => db.query(
    `select data, at from events where task_id = $1 and type = 'task_auto_started' order by id`, [id]))).rows;
  const openTimers = async (id: string) => (await inOrg(orgId, (db) => db.query(
    `select started_at from time_entries where task_id = $1 and user_id = $2 and ended_at is null and source = 'timer'`, [id, person]))).rows;
  const comment = (id: string, at: Date, userId = person, text = 'поставщик перенёс на четверг') =>
    inOrg(orgId, (db) => addHumanComment(db, id, userId, text, at), userId);
  const attach = async (id: string, at: Date, userId = person) => {
    const image = await screenshot();
    return inOrg(orgId, (db) => attachImage(db, { taskId: id, userId, image, now: at }), userId);
  };
  return { orgId, ownerId, person, agentId, agent, me, make, task, autoEvents, openTimers, comment, attach };
}

type World = Awaited<ReturnType<typeof world>>;

/**
 * Дело в очереди (`ready`) при пустом «Сейчас»: первое дело ушло в вопрос (blocked держит слот час —
 * поэтому второе осталось в очереди), а «Сейчас» в смысле спеки — active/in_progress — пусто.
 */
async function readyWithEmptyNow(w: World): Promise<Task> {
  const first = await w.make('первое');
  await inOrg(w.orgId, (db) => transition(db, first.id, 'question', w.me, { text: 'где таблица?', now: minutes(MON_10, 1) }), w.person);
  const second = await w.make('второе', minutes(MON_10, 2));
  expect((await w.task(second.id)).status).toBe('ready');
  return second;
}

/** Вызов инструмента коннектора от имени человека — тем же сервером, что в бою. */
async function mcpCall(userId: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: Record<string, unknown> }> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildMcpServer({ userId }).connect(serverT);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientT);
  const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text: string }[] };
  await client.close();
  return { isError: !!r.isError, data: JSON.parse(r.content[0]!.text) };
}

describe('автоначало: первое действие исполнителя начинает дело', () => {
  it('комментарий к делу в ready при пустом «Сейчас» → in_progress, начало = время реплики, событие, учёт времени идёт', async () => {
    const w = await world();
    const b = await readyWithEmptyNow(w);
    const at = minutes(MON_10, 5);
    await w.comment(b.id, at);

    const after = await w.task(b.id);
    expect(after.status).toBe('in_progress');
    expect(new Date(after.started_at!).toISOString()).toBe(at.toISOString());
    expect(new Date(after.taken_at!).toISOString()).toBe(at.toISOString());
    expect(after.started_via).toBe('comment');
    const ev = await w.autoEvents(b.id);
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toEqual({ cause: 'comment', switched: true });
    expect(new Date(ev[0].at).toISOString()).toBe(at.toISOString());
    const timers = await w.openTimers(b.id);
    expect(timers).toHaveLength(1);
    expect(new Date(timers[0].started_at).toISOString()).toBe(at.toISOString());
    // Реплика записана — автоначало её не съело.
    const msgs = await inOrg(w.orgId, (db) => db.query(`select kind from task_messages where task_id = $1`, [b.id]));
    expect(msgs.rows.map((r) => r.kind)).toEqual(['comment']);
  });

  it('комментарий к делу в «Сейчас» (active, «Взять» не нажато) — тоже начинает', async () => {
    const w = await world();
    const a = await w.make('в сейчас');
    expect(a.status).toBe('active');
    const res = await w.comment(a.id, minutes(MON_10, 3));
    expect(res.task.status).toBe('in_progress');
    expect((await w.task(a.id))).toMatchObject({ status: 'in_progress', started_via: 'comment' });
  });

  it('вложение исполнителя → то же с attachment', async () => {
    const w = await world();
    const b = await readyWithEmptyNow(w);
    const at = minutes(MON_10, 6);
    const res = await w.attach(b.id, at);
    expect(res.added).toBe(true);
    const after = await w.task(b.id);
    expect(after.status).toBe('in_progress');
    expect(new Date(after.started_at!).toISOString()).toBe(at.toISOString());
    expect(after.started_via).toBe('attachment');
    expect((await w.autoEvents(b.id)).map((e) => e.data)).toEqual([{ cause: 'attachment', switched: true }]);
    expect(await w.openTimers(b.id)).toHaveLength(1);
  });

  it('сдача неначатого дела → submitted, начало поставлено, started_via = submit, учёт не запускался', async () => {
    const w = await world();
    const a = await w.make('сдать сразу');
    const at = minutes(MON_10, 20);
    await inOrg(w.orgId, (db) => transition(db, a.id, 'submit', w.me, { now: at }), w.person);
    const after = await w.task(a.id);
    expect(after.status).toBe('submitted');
    expect(new Date(after.started_at!).toISOString()).toBe(at.toISOString());
    expect(after.started_via).toBe('submit');
    expect((await w.autoEvents(a.id)).map((e) => e.data)).toEqual([{ cause: 'submit', switched: false }]);
    const entries = await inOrg(w.orgId, (db) => db.query('select 1 from time_entries where task_id = $1', [a.id]));
    expect(entries.rowCount).toBe(0);
  });

  it('дело в rework с обнулённым началом начинается первой репликой', async () => {
    const w = await world();
    const a = await w.make('первое');
    const b = await w.make('на доработку', minutes(MON_10, 1));
    await inOrg(w.orgId, (db) => transition(db, b.id, 'submit', w.me, { now: minutes(MON_10, 2) }), w.person);
    // Первое уходит в вопрос: «Сейчас» (active/in_progress) пусто, а доработка остаётся в очереди — слот держит вопрос.
    await inOrg(w.orgId, (db) => transition(db, a.id, 'question', w.me, { text: 'где таблица?', now: minutes(MON_10, 3) }), w.person);
    await inOrg(w.orgId, (db) => transition(db, b.id, 'rework', w.agent, { text: 'добавь цифры', now: minutes(MON_10, 4) }));
    await inOrg(w.orgId, (db) => db.query('update tasks set started_at = null, started_via = null where id = $1', [b.id]));
    expect((await w.task(b.id)).status).toBe('rework');
    await w.comment(b.id, minutes(MON_10, 5));
    expect(await w.task(b.id)).toMatchObject({ status: 'in_progress', started_via: 'comment' });
  });

  it('после автоначала и «Остановить» дело возвращается в «Сейчас» без второго «Сейчас: …»', async () => {
    const w = await world();
    const a = await w.make('одно дело');
    const nowNotices = async () => (await inOrg(w.orgId, (db) => db.query(
      `select count(*)::int as n from notifications where kind = 'task_now' and task_id = $1`, [a.id]))).rows[0].n;
    expect(await nowNotices()).toBe(1);
    await w.comment(a.id, minutes(MON_10, 5));
    await inOrg(w.orgId, (db) => stopTask(db, a.id, w.person, { now: minutes(MON_10, 10) }), w.person);
    expect((await w.task(a.id)).status).toBe('active');
    expect(await nowNotices()).toBe(1);
  });

  it('другое дело уже в работе → реплика к очередному ставит только начало; статусы обоих прежние, таймер прежнего идёт', async () => {
    const w = await world();
    const a = await w.make('в работе');
    await inOrg(w.orgId, (db) => takeTask(db, a.id, w.me, { now: MON_10 }), w.person);
    const b = await w.make('очередное', minutes(MON_10, 1));
    expect((await w.task(b.id)).status).toBe('ready');

    const at = minutes(MON_10, 10);
    await w.comment(b.id, at);
    const nb = await w.task(b.id);
    expect(nb.status).toBe('ready');
    expect(new Date(nb.started_at!).toISOString()).toBe(at.toISOString());
    expect(nb.started_via).toBe('comment');
    expect((await w.autoEvents(b.id)).map((e) => e.data)).toEqual([{ cause: 'comment', switched: false }]);
    expect(await w.openTimers(b.id)).toHaveLength(0);
    expect((await w.task(a.id)).status).toBe('in_progress');
    expect(await w.openTimers(a.id)).toHaveLength(1);

    // Вложение к тому же делу уже ничего не начинает: начало есть.
    await w.attach(b.id, minutes(MON_10, 12));
    expect(await w.autoEvents(b.id)).toHaveLength(1);
    expect((await w.task(b.id)).status).toBe('ready');
  });

  it('другое дело в «Сейчас» (active) — тоже держит: реплика к очередному статус не меняет', async () => {
    const w = await world();
    const a = await w.make('в сейчас');
    const b = await w.make('очередное', minutes(MON_10, 1));
    expect([a.status, (await w.task(b.id)).status]).toEqual(['active', 'ready']);
    await w.attach(b.id, minutes(MON_10, 4));
    expect(await w.task(b.id)).toMatchObject({ status: 'ready', started_via: 'attachment' });
    expect((await w.task(a.id)).status).toBe('active');
  });
});

describe('автоначало: что не начинает', () => {
  it('сдача личного дела начала не ставит', async () => {
    const w = await world();
    const personal = await withGlobal((db) => ensurePersonalOrg(db, w.person));
    const p = await inOrg(personal, (db) => createTask(db, { title: 'своё', assigneeUserId: w.person }, w.me, MON_10), w.person);
    await inOrg(personal, (db) => transition(db, p.id, 'submit', w.me, { now: minutes(MON_10, 1) }), w.person);
    const after = (await inOrg(personal, (db) => db.query('select status, started_at, started_via from tasks where id = $1', [p.id]), w.person)).rows[0];
    expect(after).toEqual({ status: 'done', started_at: null, started_via: null });
  });

  const notStarted = async (w: World, id: string, status: string) => {
    const after = await w.task(id);
    expect(after.status).toBe(status);
    expect(after.started_at).toBeNull();
    expect(after.started_via).toBeNull();
    expect(await w.autoEvents(id)).toHaveLength(0);
  };

  it('реплика постановщика-человека и владельца', async () => {
    const w = await world();
    const a = await w.make('дело агента');
    await w.comment(a.id, minutes(MON_10, 1), w.ownerId, 'указание владельца');
    await notStarted(w, a.id, 'active');

    const author = await addPerson(w.orgId);
    const h = await inOrg(w.orgId, (db) => createTask(db, { ...base, title: 'от человека', assigneeUserId: w.person }, { kind: 'user', userId: author }, MON_10), author);
    await w.comment(h.id, minutes(MON_10, 2), author, 'как успехи?');
    await w.attach(h.id, minutes(MON_10, 3), author);
    await notStarted(w, h.id, h.status);
  });

  it('коннектор: агент исполнителя (comment_task с agent) не начинает, сам исполнитель (без agent) — начинает', async () => {
    const w = await world();
    // Агент, которым распоряжается сам исполнитель: тот же человек за вызовом, но пишет агент.
    const ownAgent = await makeAgent(w.orgId, w.person, `помощник-${uniq()}`);
    const a = await w.make('через коннектор');
    const viaAgent = await mcpCall(w.person, 'comment_task', { org: w.orgId, agent: ownAgent, task: a.id, text: 'агент пишет' });
    expect(viaAgent.isError).toBe(false);
    await notStarted(w, a.id, 'active');
    const byPerson = await mcpCall(w.person, 'comment_task', { org: w.orgId, task: a.id, text: 'сам пишу' });
    expect(byPerson.isError).toBe(false);
    expect(byPerson.data.status).toBe('in_progress');
    expect(await w.task(a.id)).toMatchObject({ status: 'in_progress', started_via: 'comment' });
  });

  it('дело-ожидание', async () => {
    const w = await world();
    const wt = await inOrg(w.orgId, (db) => createTask(db, {
      kind: 'waiting', title: 'документы', why: 'регистрация', assigneeUserId: w.person,
      waiting: { waitingFor: 'налоговая', expectedAt: minutes(MON_10, 60 * 24 * 10).toISOString() },
    }, w.agent, MON_10));
    await w.comment(wt.id, minutes(MON_10, 1));
    await notStarted(w, wt.id, 'waiting');
  });

  it('личное место', async () => {
    const w = await world();
    const personal = await withGlobal((db) => ensurePersonalOrg(db, w.person));
    const p = await inOrg(personal, (db) => createTask(db, { title: 'своё', assigneeUserId: w.person }, w.me, MON_10), w.person);
    await inOrg(personal, (db) => addHumanComment(db, p.id, w.person, 'заметка себе', minutes(MON_10, 1)), w.person);
    const after = (await inOrg(personal, (db) => db.query('select status, started_at, started_via from tasks where id = $1', [p.id]), w.person)).rows[0];
    expect(after).toEqual({ status: p.status, started_at: null, started_via: null });
  });

  it('«Вопрос» и «Непонятно» — не начало', async () => {
    const w = await world();
    const a = await w.make('в сейчас');
    const b = await w.make('в очереди', minutes(MON_10, 1));
    await inOrg(w.orgId, (db) => transition(db, b.id, 'question', w.me, { text: 'что за таблица?', now: minutes(MON_10, 2) }), w.person);
    await inOrg(w.orgId, (db) => transition(db, a.id, 'unclear', w.me, { text: 'не понял задачу', now: minutes(MON_10, 3) }), w.person);
    await notStarted(w, b.id, 'ready');
    await notStarted(w, a.id, 'blocked');
  });

  it('у дела уже есть начало: остановленное дело реплика снова не берёт', async () => {
    const w = await world();
    const a = await w.make('взял и остановил');
    const b = await w.make('второе', minutes(MON_10, 1));
    await inOrg(w.orgId, (db) => takeTask(db, a.id, w.me, { now: minutes(MON_10, 2) }), w.person);
    await inOrg(w.orgId, (db) => stopTask(db, a.id, w.person, { now: minutes(MON_10, 30) }), w.person);
    // Остановленное дело очередь вернула в «Сейчас» (или оставила в очереди) — начало у него уже есть.
    const stopped = await w.task(a.id);
    const startedAt = new Date(stopped.started_at!).toISOString();
    await w.comment(a.id, minutes(MON_10, 40));
    const after = await w.task(a.id);
    expect(after.status).toBe(stopped.status);
    expect(new Date(after.started_at!).toISOString()).toBe(startedAt);
    expect(after.started_via).toBeNull();
    expect(await w.autoEvents(a.id)).toHaveLength(0);
    expect(await w.openTimers(a.id)).toHaveLength(0);
    expect((await w.task(b.id)).started_at).toBeNull();
  });
});

/** Дверь для теста гонок: транзакция держит замок, пока тест её не откроет. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((res) => { open = res; });
  return { wait, open };
}

describe('автоначало: два действия разом', () => {
  it('реплика и фото одновременно — оба проходят, дело берётся один раз', async () => {
    const w = await world();
    const b = await readyWithEmptyNow(w);
    const image = await cleanImage(await screenshot());
    const at = minutes(MON_10, 7);
    const results = await Promise.allSettled([
      inOrg(w.orgId, (db) => addHumanComment(db, b.id, w.person, 'начал', at), w.person),
      inOrg(w.orgId, (db) => attachImage(db, { taskId: b.id, userId: w.person, image, now: at }), w.person),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect((await w.task(b.id)).status).toBe('in_progress');
    expect(await w.autoEvents(b.id)).toHaveLength(1);
    expect(await w.openTimers(b.id)).toHaveLength(1);
    const written = await inOrg(w.orgId, (db) => db.query(
      `select (select count(*)::int from task_messages where task_id = $1) as m, (select count(*)::int from task_attachments where task_id = $1) as a`, [b.id]));
    expect(written.rows[0]).toEqual({ m: 1, a: 1 });
  });

  // Ревью: transition берёт строку дела, потом человека (fillSlot); автоначало ждало в обратном порядке — круг.
  it('отмена агентом (строка → человек) одновременно с первой репликой — проходят обе', async () => {
    const w = await world();
    const a = await w.make('дело');
    const door = gate();
    let held = false;
    const cancel = inOrg(w.orgId, async (db) => {
      await db.query('select 1 from tasks where id = $1 for update', [a.id]);
      held = true;
      await door.wait;
      return transition(db, a.id, 'cancel', w.agent, { now: minutes(MON_10, 1) });
    });
    await vi.waitFor(() => { expect(held).toBe(true); });
    const comment = w.comment(a.id, minutes(MON_10, 1), w.person, 'начал');
    // Реплика дошла до строки дела, которую держит отмена (запись реплики ждёт её коммита).
    try {
      await vi.waitFor(async () => { expect(await rowLockWaiters()).toBeGreaterThan(0); }, { timeout: 5000 });
    } finally {
      door.open();
    }
    const res = await Promise.allSettled([cancel, comment]);
    expect(res.map((r) => (r.status === 'rejected' ? String((r.reason as Error).message) : 'ok'))).toEqual(['ok', 'ok']);
    expect((await w.task(a.id)).status).toBe('cancelled');
  });

  it('строку дела держит другое действие — реплика не ждёт его ради начала: проходит, дело не начато', async () => {
    const w = await world();
    const b = await readyWithEmptyNow(w);
    const door = gate();
    // Строку держат «на просмотр» (не для правки): запись реплики не ждёт, а начать без ожидания нельзя.
    let held = false;
    const holder = inOrg(w.orgId, async (db) => {
      await db.query('select 1 from tasks where id = $1 for no key update', [b.id]);
      held = true;
      await door.wait;
    });
    await vi.waitFor(() => { expect(held).toBe(true); });
    const comment = w.comment(b.id, minutes(MON_10, 6));
    const first = await Promise.race([comment.then(() => 'done'), new Promise((r) => setTimeout(() => r('waiting'), 2000))]);
    door.open();
    await holder;
    await comment;
    expect(first).toBe('done');
    expect(await w.task(b.id)).toMatchObject({ status: 'ready', started_at: null, started_via: null });
  });

  it('замок человека занят «Взять» другого дела — реплика не ждёт его и не даёт человеку второе «Сейчас»', async () => {
    const w = await world();
    const b = await readyWithEmptyNow(w);
    const c = await w.make('третье', minutes(MON_10, 3));
    expect((await w.task(c.id)).status).toBe('ready');
    const door = gate();
    let held = false;
    const take = inOrg(w.orgId, async (db) => {
      await takeTask(db, c.id, w.me, { now: minutes(MON_10, 8) });
      held = true;
      await door.wait;
    }, w.person);
    await vi.waitFor(() => { expect(held).toBe(true); });
    const comment = w.comment(b.id, minutes(MON_10, 9));
    const first = await Promise.race([comment.then(() => 'done'), new Promise((r) => setTimeout(() => r('waiting'), 2000))]);
    door.open();
    await take;
    await comment;
    expect(first).toBe('done');
    expect((await w.task(c.id)).status).toBe('in_progress');
    expect((await w.task(b.id)).status).toBe('ready');
    const inWork = await inOrg(w.orgId, (db) => db.query(`select count(*)::int as n from tasks where assignee_user_id = $1 and status = 'in_progress'`, [w.person]));
    expect(inWork.rows[0].n).toBe(1);
  });
});

/** Сколько соединений этой базы ждут чужого замка (строки дела). */
async function rowLockWaiters(): Promise<number> {
  return (await withGlobal((db) => db.query(
    `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and wait_event in ('transactionid', 'tuple')`))).rows[0].n;
}

describe('автоначало: где видно', () => {
  it('get_task: поле started_via и событие task_auto_started в history', async () => {
    const w = await world();
    const a = await w.make('для досье');
    await w.comment(a.id, minutes(MON_10, 5));
    const d = await inOrg(w.orgId, (db) => taskDossier(db, a.id, w.agent));
    expect((d.task as { started_via: string }).started_via).toBe('comment');
    const h = (d.history as { type: string; cause?: string; switched?: boolean }[]).find((x) => x.type === 'task_auto_started');
    expect(h).toMatchObject({ type: 'task_auto_started', cause: 'comment', switched: true });
  });

  it('Mini App: карточка отдаёт auto_started — чем и когда', async () => {
    const w = await world();
    const a = await w.make('карточка приложения');
    const tg = 700_000_000 + Math.floor(Math.random() * 1_000_000);
    await withGlobal((db) => db.query(`insert into telegram_links(telegram_user_id, user_id, chat_id) values ($1, $2, $1)`, [tg, w.person]));
    const app = express();
    miniappRoutes(app, { botToken: MINIAPP_TOKEN });
    const initData = buildInitData(MINIAPP_TOKEN, tg, new Date());

    const before = await request(app).get(`/app/api/tasks/${a.id}`).set('X-Telegram-Init-Data', initData);
    expect(before.status).toBe(200);
    expect(before.body.task.auto_started).toBeNull();

    const c = await request(app).post(`/app/api/tasks/${a.id}/comment`).set('X-Telegram-Init-Data', initData).send({ text: 'взялся' });
    expect(c.status).toBe(200);
    const r = await request(app).get(`/app/api/tasks/${a.id}`).set('X-Telegram-Init-Data', initData);
    const startedAt = new Date((await w.task(a.id)).started_at!).toISOString();
    expect(r.body.task.auto_started).toEqual({ via: 'comment', at: startedAt });
    expect(r.body.task.status).toBe('in_progress');
  });

  it('тексты вопроса, кнопок, напоминания и строки «Начата автоматически» — на ru/tr/en/vi', () => {
    const botKeys = [
      'notif.take_prompt', 'notif.take_reminder', 'btn.take', 'btn.take_later', 'btn.take_tomorrow',
      'take_prompt.later_done', 'take_prompt.later_exists', 'take_prompt.already_taken', 'take_prompt.closed',
    ];
    for (const lang of LANGS) {
      for (const key of botKeys) {
        expect(dictKeys(lang), `${lang}.${key}`).toContain(key);
        expect(t(lang, key, { time: '11:00' }).trim(), `${lang}.${key}`).not.toBe('');
      }
      expect(t(lang, 'btn.take_later', { time: '11:00' }), lang).toContain('11:00');
      expect(t(lang, 'take_prompt.later_done', { time: '11:00' }), lang).toContain('11:00');
    }
    // Языки различаются — перевод, а не копия английского.
    expect(new Set(LANGS.map((l) => t(l, 'notif.take_prompt'))).size).toBe(LANGS.length);
    for (const lang of ['ru', 'tr', 'en', 'vi'] as const) {
      const s = STRINGS[lang];
      for (const key of ['auto_started', 'auto_started_comment', 'auto_started_attachment', 'auto_started_submit'] as const) {
        expect(s[key]?.trim(), `${lang}.${key}`).toBeTruthy();
      }
      expect(s.auto_started).toContain('{via}');
      expect(s.auto_started).toContain('{when}');
    }
    expect(new Set(['ru', 'tr', 'en', 'vi'].map((l) => STRINGS[l as 'ru'].auto_started)).size).toBe(4);
  });
});

// ---------------------------------------------------------------- бот: «Берёшь сейчас?»

const MINIAPP_TOKEN = 'test-bot-token-autostart';

function buildInitData(botToken: string, telegramUserId: number, authDate: Date): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(authDate.getTime() / 1000)),
    user: JSON.stringify({ id: telegramUserId, first_name: 'Test' }),
  });
  const dataCheckString = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}

const BOT_INFO: UserFromGetMe = {
  id: 10, is_bot: true, first_name: 'Taskano', username: 'taskano_test_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
  allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
};

interface SentCall { method: string; payload: Record<string, unknown> }
let sent: SentCall[];
let bot: ReturnType<typeof createBot>;
let nextUpdateId = 1;
let nextMessageId = 1;
let nextTgId = 81_000;

beforeEach(() => {
  sent = [];
  bot = createBot({ token: 'test-token', botInfo: BOT_INFO });
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, unknown> });
    if (method === 'sendMessage') {
      const chatId = (payload as { chat_id?: number }).chat_id;
      return { ok: true, result: { message_id: nextMessageId++, date: 0, chat: { id: chatId, type: 'private' }, text: String((payload as { text?: string }).text ?? '') } } as any;
    }
    return { ok: true, result: true } as any;
  });
});

afterEach(() => { vi.useRealTimers(); });

type TgUser = NonNullable<Update['message']>['from'];
const tgUser = (id: number): TgUser => ({ id, is_bot: false, first_name: 'Person', language_code: 'ru' });

function startUpdate(from: TgUser, text: string): Update {
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: from!.id, type: 'private', first_name: 'P' },
      from, text, entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    },
  } as unknown as Update;
}

function callbackUpdate(from: TgUser, data: string, sentAt: Date = new Date()): Update {
  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: String(nextUpdateId), from, chat_instance: 'x', data,
      message: { message_id: nextMessageId++, date: Math.floor(sentAt.getTime() / 1000), chat: { id: from!.id, type: 'private', first_name: 'P' }, text: 'Берёшь сейчас?' },
    },
  } as unknown as Update;
}

async function linkTelegram(userId: string): Promise<TgUser> {
  const from = tgUser(nextTgId++);
  await withGlobal((db) => db.query(`insert into telegram_links(telegram_user_id, user_id, chat_id) values ($1, $2, $1)`, [from!.id, userId]));
  return from;
}

const notifs = (w: World, kind: string, taskId: string) => inOrg(w.orgId, async (db) => (await db.query(
  `select id, deliver_after, dedupe_key, delivered_at from notifications where kind = $1 and task_id = $2 order by created_at`, [kind, taskId])).rows);

const texts = (method?: string) => sent.filter((s) => !method || s.method === method).map((s) => String(s.payload.text ?? ''));

function buttons(call: SentCall | undefined): { text: string; callback_data?: string }[] {
  return ((call?.payload.reply_markup as { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined)?.inline_keyboard ?? []).flat();
}

/** Понедельник 2026-09-21 по Стамбулу (UTC+3): `h:mm` местного времени. */
const monAt = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 21, h - 3, m));

describe('бот: «Берёшь сейчас?» при показе карточки', () => {
  it('открытие карточки ставит take_prompt через 60 с; второе открытие в тот же день — нет', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(MON_10);
    const w = await world();
    const a = await w.make('открыл и не начал');
    const from = await linkTelegram(w.person);

    await bot.handleUpdate(startUpdate(from, `/start t_${a.short_id}`));
    let rows = await notifs(w, 'take_prompt', a.id);
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].deliver_after).toISOString()).toBe(new Date(MON_10.getTime() + 60_000).toISOString());
    expect(rows[0].dedupe_key).toBe(`take_prompt:${a.id}:2026-09-21`);

    // Пять раз за день — один вопрос: и ссылкой, и строкой списка, и «Сейчас».
    vi.setSystemTime(minutes(MON_10, 30));
    await bot.handleUpdate(startUpdate(from, `/start t_${a.short_id}`));
    await bot.handleUpdate(callbackUpdate(from, `sh:${a.short_id}`));
    await bot.handleUpdate({
      update_id: nextUpdateId++,
      message: { message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: from!.id, type: 'private', first_name: 'P' }, from, text: t('ru', 'menu.now') },
    } as unknown as Update);
    rows = await notifs(w, 'take_prompt', a.id);
    expect(rows).toHaveLength(1);
  });

  it('карточку смотрит не исполнитель, или дело уже в работе — вопроса нет', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(MON_10);
    const w = await world();
    const a = await w.make('чужими глазами');
    const owner = await linkTelegram(w.ownerId);
    await bot.handleUpdate(startUpdate(owner, `/start t_${a.short_id}`));
    expect(await notifs(w, 'take_prompt', a.id)).toHaveLength(0);

    await inOrg(w.orgId, (db) => takeTask(db, a.id, w.me, { now: MON_10 }), w.person);
    const from = await linkTelegram(w.person);
    await bot.handleUpdate(startUpdate(from, `/start t_${a.short_id}`));
    expect(await notifs(w, 'take_prompt', a.id)).toHaveLength(0);
  });

  it('дело взято до доставки → skipped, сообщение не уходит', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(MON_10);
    const w = await world();
    const a = await w.make('взял за минуту');
    const from = await linkTelegram(w.person);
    await bot.handleUpdate(startUpdate(from, `/start t_${a.short_id}`));
    const [n] = await notifs(w, 'take_prompt', a.id);
    await inOrg(w.orgId, (db) => takeTask(db, a.id, w.me, { now: minutes(MON_10, 0.5) }), w.person);
    sent = [];
    expect(await deliverNotification(w.orgId, n.id, minutes(MON_10, 1.1))).toBe('skipped');
    expect(texts('sendMessage')).toEqual([]);
    expect((await notifs(w, 'take_prompt', a.id))[0].delivered_at).not.toBeNull();
  });

  it.each([
    ['закрыто', async (w: World, id: string) => { await inOrg(w.orgId, (db) => transition(db, id, 'cancel', w.agent, { now: minutes(MON_10, 0.5) })); }],
    ['сменился исполнитель', async (w: World, id: string) => {
      const other = await addPerson(w.orgId);
      await inOrg(w.orgId, (db) => db.query('update tasks set assignee_user_id = $2 where id = $1', [id, other]));
    }],
    // Взял и сразу остановил: дело снова в «Сейчас», но начато уже после вопроса — звать не к чему.
    ['взято и остановлено', async (w: World, id: string) => {
      await inOrg(w.orgId, (db) => takeTask(db, id, w.me, { now: minutes(MON_10, 0.3) }), w.person);
      await inOrg(w.orgId, (db) => stopTask(db, id, w.person, { now: minutes(MON_10, 0.6) }), w.person);
      expect(['ready', 'active']).toContain((await w.task(id)).status);
    }],
    ['ушло из очереди (вопрос)', async (w: World, id: string) => {
      await inOrg(w.orgId, (db) => transition(db, id, 'question', w.me, { text: 'какой адрес?', now: minutes(MON_10, 0.5) }), w.person);
    }],
  ] as const)('%s до доставки → skipped', async (_name, change) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(MON_10);
    const w = await world();
    const a = await w.make('меняется за минуту');
    const from = await linkTelegram(w.person);
    await bot.handleUpdate(startUpdate(from, `/start t_${a.short_id}`));
    const [n] = await notifs(w, 'take_prompt', a.id);
    await change(w, a.id);
    sent = [];
    expect(await deliverNotification(w.orgId, n.id, minutes(MON_10, 1.1))).toBe('skipped');
    expect(texts('sendMessage')).toEqual([]);
  });

  it('не начато к доставке → вопрос с названием, [Взять] и «Позже — к …» с итоговым временем', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(MON_10);
    const w = await world();
    const a = await w.make('сверить накладные');
    const from = await linkTelegram(w.person);
    await bot.handleUpdate(startUpdate(from, `/start t_${a.short_id}`));
    const [n] = await notifs(w, 'take_prompt', a.id);
    sent = [];
    expect(await deliverNotification(w.orgId, n.id, minutes(MON_10, 1))).toBe('sent');
    const msg = sent.find((s) => s.method === 'sendMessage')!;
    expect(String(msg.payload.text)).toContain(t('ru', 'notif.take_prompt'));
    expect(String(msg.payload.text)).toContain('сверить накладные');
    const b = buttons(msg);
    expect(b.find((x) => x.callback_data === `tp:take:${a.short_id}`)?.text).toBe(t('ru', 'btn.take'));
    expect(b.find((x) => x.callback_data === `tp:later:h1:${a.short_id}`)?.text).toBe(t('ru', 'btn.take_later', { time: '11:01' }));
    expect(b.find((x) => x.callback_data === `tp:later:h3:${a.short_id}`)?.text).toBe(t('ru', 'btn.take_later', { time: '13:01' }));
    expect(b.find((x) => x.callback_data === `tp:later:tm:${a.short_id}`)?.text).toBe(t('ru', 'btn.take_tomorrow'));
    for (const x of b) if (x.callback_data) expect(Buffer.byteLength(x.callback_data)).toBeLessThanOrEqual(64);
  });
});

describe('бот: кнопки вопроса', () => {
  it('[Взять] берёт дело без проверки версии и отвечает карточкой; второе нажатие — «уже в работе», без ошибки', async () => {
    const w = await world();
    const a = await w.make('взять из вопроса');
    // Версия карточки сменилась, пока шёл вопрос: кнопка от этого не устарела.
    await inOrg(w.orgId, (db) => db.query('update tasks set version = version + 5 where id = $1', [a.id]));
    const from = await linkTelegram(w.person);
    await bot.handleUpdate(callbackUpdate(from, `tp:take:${a.short_id}`));
    expect((await w.task(a.id)).status).toBe('in_progress');
    expect((await w.task(a.id)).started_via).toBeNull();
    const card = sent.find((s) => s.method === 'editMessageText');
    expect(String(card?.payload.text)).toContain('взять из вопроса');
    expect(buttons(card).some((x) => x.callback_data?.startsWith(`a:stp:${a.short_id}:`))).toBe(true);

    sent = [];
    await bot.handleUpdate(callbackUpdate(from, `tp:take:${a.short_id}`));
    expect(texts().join('\n')).toContain(t('ru', 'take_prompt.already_taken'));
    expect((await w.task(a.id)).status).toBe('in_progress');
  });

  it('[Взять] по закрытому делу — «закрыто»; чужое дело — тот же отказ, что у кнопок карточки', async () => {
    const w = await world();
    const a = await w.make('закрыли за минуту');
    const owner = await linkTelegram(w.ownerId);
    await bot.handleUpdate(callbackUpdate(owner, `tp:take:${a.short_id}`));
    expect(texts().join('\n')).toContain(t('ru', 'error.not_your_task'));
    expect((await w.task(a.id)).status).toBe('active');
    sent = [];
    await bot.handleUpdate(callbackUpdate(owner, `tp:later:h1:${a.short_id}`));
    expect(texts().join('\n')).toContain(t('ru', 'error.not_your_task'));
    expect(await notifs(w, 'take_reminder', a.id)).toHaveLength(0);

    await inOrg(w.orgId, (db) => transition(db, a.id, 'cancel', w.agent));
    const from = await linkTelegram(w.person);
    sent = [];
    await bot.handleUpdate(callbackUpdate(from, `tp:take:${a.short_id}`));
    expect(texts().join('\n')).toContain(t('ru', 'take_prompt.closed'));
    expect((await w.task(a.id)).status).toBe('cancelled');
  });

  it('«Позже — к …» ставит одно take_reminder на время в рабочем окне; второе «Позже» в тот же день — «уже стоит»', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(MON_10);
    const w = await world();
    const a = await w.make('позже');
    const from = await linkTelegram(w.person);
    await bot.handleUpdate(callbackUpdate(from, `tp:later:h1:${a.short_id}`));
    let rows = await notifs(w, 'take_reminder', a.id);
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].deliver_after).toISOString()).toBe(monAt(11).toISOString());
    expect(rows[0].dedupe_key).toBe(`take_reminder:${a.id}:2026-09-21:11:00`);
    expect(texts().join('\n')).toContain(t('ru', 'take_prompt.later_done', { time: '11:00' }));
    // Вопрос не затирается: итог дописан под ним, кнопки сняты.
    const edit = sent.find((s) => s.method === 'editMessageText');
    expect(String(edit?.payload.text)).toMatch(/^Берёшь сейчас\?\n\n✓ /);

    sent = [];
    vi.setSystemTime(minutes(MON_10, 10));
    await bot.handleUpdate(callbackUpdate(from, `tp:later:h3:${a.short_id}`));
    rows = await notifs(w, 'take_reminder', a.id);
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].deliver_after).toISOString()).toBe(monAt(11).toISOString());
    expect(texts().join('\n')).toContain(t('ru', 'take_prompt.later_exists', { time: '11:00' }));
  });

  it('«Позже» после того, как напоминание уже пришло, — ставит новое', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(MON_10);
    const w = await world();
    const a = await w.make('позже дважды');
    const from = await linkTelegram(w.person);
    await bot.handleUpdate(callbackUpdate(from, `tp:later:h1:${a.short_id}`));
    const [first] = await notifs(w, 'take_reminder', a.id);
    vi.setSystemTime(monAt(11, 1));
    expect(await deliverNotification(w.orgId, first.id, monAt(11, 1))).toBe('sent');
    sent = [];
    await bot.handleUpdate(callbackUpdate(from, `tp:later:h1:${a.short_id}`));
    const rows = await notifs(w, 'take_reminder', a.id);
    expect(rows).toHaveLength(2);
    expect(new Date(rows[1].deliver_after).toISOString()).toBe(monAt(12, 1).toISOString());
    expect(texts().join('\n')).toContain(t('ru', 'take_prompt.later_done', { time: '12:01' }));
  });

  it('«Позже» считается от отправки вопроса; если то время уже прошло — от нажатия', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(MON_10);
    const w = await world();
    const a = await w.make('вопрос полчаса назад');
    const b = await w.make('вопрос утром', minutes(MON_10, 1));
    const from = await linkTelegram(w.person);
    // Вопрос ушёл в 09:30 — «через час» на кнопке было 10:30, так и ставим.
    await bot.handleUpdate(callbackUpdate(from, `tp:later:h1:${a.short_id}`, monAt(9, 30)));
    expect(new Date((await notifs(w, 'take_reminder', a.id))[0].deliver_after).toISOString()).toBe(monAt(10, 30).toISOString());
    // Вопрос ушёл в 08:00 (до работы): «через час» — 09:00, уже прошло — час от нажатия, 11:00.
    await bot.handleUpdate(callbackUpdate(from, `tp:later:h1:${b.short_id}`, monAt(8)));
    expect(new Date((await notifs(w, 'take_reminder', b.id))[0].deliver_after).toISOString()).toBe(monAt(11).toISOString());
  });

  it('«Позже» вечером — на начало следующего рабочего дня', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(monAt(17, 30));
    const w = await world();
    const a = await w.make('вечером');
    const from = await linkTelegram(w.person);
    await bot.handleUpdate(callbackUpdate(from, `tp:later:h1:${a.short_id}`));
    const [r] = await notifs(w, 'take_reminder', a.id);
    const at = new Date(r.deliver_after);
    expect(at.toISOString()).toBe(new Date(Date.UTC(2026, 8, 22, 6, 0)).toISOString());   // вт 09:00 Стамбул
    const schedule = await inOrg(w.orgId, (db) => loadUserSchedule(db, w.person));
    expect(isWorkingTime(schedule, at)).toBe(true);
    expect(texts().join('\n')).toContain(t('ru', 'take_prompt.later_done', { time: '09:00' }));
  });

  it('напоминание: не начато — «Пора браться» с [Взять]; по взятому делу не шлётся', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(MON_10);
    const w = await world();
    const a = await w.make('напомнить');
    const b = await w.make('напомнить и взять', minutes(MON_10, 1));
    const from = await linkTelegram(w.person);
    await bot.handleUpdate(callbackUpdate(from, `tp:later:h1:${a.short_id}`));
    await bot.handleUpdate(callbackUpdate(from, `tp:later:h1:${b.short_id}`));
    const [ra] = await notifs(w, 'take_reminder', a.id);
    const [rb] = await notifs(w, 'take_reminder', b.id);

    sent = [];
    expect(await deliverNotification(w.orgId, ra.id, monAt(11))).toBe('sent');
    const msg = sent.find((s) => s.method === 'sendMessage')!;
    expect(String(msg.payload.text)).toContain(t('ru', 'notif.take_reminder'));
    expect(String(msg.payload.text)).toContain('напомнить');
    expect(buttons(msg).find((x) => x.callback_data === `tp:take:${a.short_id}`)?.text).toBe(t('ru', 'btn.take'));

    await inOrg(w.orgId, (db) => takeTask(db, b.id, w.me, { now: minutes(MON_10, 30) }), w.person);
    sent = [];
    expect(await deliverNotification(w.orgId, rb.id, monAt(11))).toBe('skipped');
    expect(texts('sendMessage')).toEqual([]);
  });
});

describe('варианты «Позже» в рабочем графике', () => {
  const s: Schedule = { tz: 'Europe/Istanbul', days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', holidays: new Set() };
  const show = (from: Date) => laterChoices(s, from).map((c) => [c.code, c.at.toISOString()]);

  it('днём — через час, через три и утро следующего рабочего дня', () => {
    expect(show(monAt(10))).toEqual([
      ['h1', monAt(11).toISOString()], ['h3', monAt(13).toISOString()], ['tm', new Date(Date.UTC(2026, 8, 22, 6)).toISOString()],
    ]);
  });

  it('ближе к концу дня «через три часа» переносится на утро и схлопывается с «Завтра утром»', () => {
    expect(show(monAt(16, 30))).toEqual([['h1', monAt(17, 30).toISOString()], ['tm', new Date(Date.UTC(2026, 8, 22, 6)).toISOString()]]);
  });

  it('вечером пятницы — одна кнопка: утро понедельника', () => {
    expect(show(new Date(Date.UTC(2026, 8, 25, 15)))).toEqual([['tm', new Date(Date.UTC(2026, 8, 28, 6)).toISOString()]]);
  });
});

// ---------------------------------------------------------------- бот: правила вопроса и фото к действиям

function photoMessage(from: TgUser, buf: Buffer, opts: { caption?: string; mediaGroupId?: string } = {}): Update {
  const fileId = `f-${uniq()}`;
  telegramFiles.set(fileId, buf);
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: from!.id, type: 'private', first_name: 'P' }, from,
      photo: [{ file_id: `${fileId}-s`, file_unique_id: `u-${fileId}-s`, width: 90, height: 60 }, { file_id: fileId, file_unique_id: `u-${fileId}`, width: 320, height: 240 }],
      ...(opts.caption ? { caption: opts.caption } : {}),
      ...(opts.mediaGroupId ? { media_group_id: opts.mediaGroupId } : {}),
    },
  } as unknown as Update;
}

function nowMenu(from: TgUser): Update {
  return {
    update_id: nextUpdateId++,
    message: { message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: from!.id, type: 'private', first_name: 'P' }, from, text: t('ru', 'menu.now') },
  } as unknown as Update;
}

describe('бот: когда «Берёшь сейчас?» не нужен', () => {
  it('личное дело — вопроса нет', async () => {
    const w = await world();
    const personal = await withGlobal((db) => ensurePersonalOrg(db, w.person));
    const p = await inOrg(personal, (db) => createTask(db, { title: 'своё', assigneeUserId: w.person }, w.me, MON_10), w.person);
    const from = await linkTelegram(w.person);
    await bot.handleUpdate(startUpdate(from, `/start t_${p.short_id}`));
    expect(texts('sendMessage').join('\n')).toContain('своё');
    const rows = await inOrg(personal, (db) => db.query(`select 1 from notifications where kind = 'take_prompt' and task_id = $1`, [p.id]), w.person);
    expect(rows.rowCount).toBe(0);
  });

  it('«Сейчас» первой и единственной командой — ровно один вопрос', async () => {
    const w = await world();
    const a = await w.make('в сейчас');
    const from = await linkTelegram(w.person);
    await bot.handleUpdate(nowMenu(from));
    expect(texts('sendMessage').join('\n')).toContain('в сейчас');
    expect(await notifs(w, 'take_prompt', a.id)).toHaveLength(1);
  });

  it('человек работает над другим делом — вопрос не ставится; взял другое до доставки — не шлётся', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(MON_10);
    const w = await world();
    const a = await w.make('в сейчас');
    const b = await w.make('очередное', minutes(MON_10, 1));
    const from = await linkTelegram(w.person);

    // Пока «Сейчас» только предложено (active) — спросить про очередное можно.
    await bot.handleUpdate(startUpdate(from, `/start t_${b.short_id}`));
    const [n] = await notifs(w, 'take_prompt', b.id);
    expect(n).toBeDefined();
    // Взял первое до доставки — про очередное не дёргаем.
    await inOrg(w.orgId, (db) => takeTask(db, a.id, w.me, { now: minutes(MON_10, 0.5) }), w.person);
    sent = [];
    expect(await deliverNotification(w.orgId, n.id, minutes(MON_10, 1.1))).toBe('skipped');
    expect(texts('sendMessage')).toEqual([]);

    // Назавтра открыл очередное, а первое всё ещё в работе, — вопроса нет вовсе.
    vi.setSystemTime(minutes(MON_10, 24 * 60));
    await bot.handleUpdate(startUpdate(from, `/start t_${b.short_id}`));
    expect(await notifs(w, 'take_prompt', b.id)).toHaveLength(1);
  });
});

describe('бот: фото к вопросу и к сдаче дело не начинают сами', () => {
  it('фото с подписью к вопросу по делу из очереди — вопрос записан, дело не начато', async () => {
    const w = await world();
    await w.make('в сейчас');
    const b = await w.make('в очереди', minutes(MON_10, 1));
    const fresh = await w.task(b.id);
    expect(fresh.status).toBe('ready');
    const from = await linkTelegram(w.person);
    await bot.handleUpdate(callbackUpdate(from, `a:q:${b.short_id}:${fresh.version}`));
    await bot.handleUpdate(photoMessage(from, await screenshot(), { caption: 'какая из двух накладных?' }));
    const q = await inOrg(w.orgId, (db) => db.query(`select text from task_messages where task_id = $1 and kind = 'question'`, [b.id]));
    expect(q.rows.map((r) => r.text)).toEqual(['какая из двух накладных?']);
    const att = await inOrg(w.orgId, (db) => db.query('select count(*)::int as n from task_attachments where task_id = $1', [b.id]));
    expect(att.rows[0].n).toBe(1);
    expect(await w.task(b.id)).toMatchObject({ status: 'ready', started_at: null, started_via: null });
  });

  it('сдача фото-результатом в боте → submitted, started_via = submit', async () => {
    const w = await world();
    const task = await inOrg(w.orgId, (db) => createTask(db, {
      ...base, title: 'сфотографировать склад', assigneeUserId: w.person, expectedResult: { type: 'photo', required: true },
    }, w.agent, MON_10));
    const from = await linkTelegram(w.person);
    await bot.handleUpdate(callbackUpdate(from, `a:done:${task.short_id}:${task.version}`));
    await bot.handleUpdate(photoMessage(from, await screenshot()));
    expect(await w.task(task.id)).toMatchObject({ status: 'submitted', started_via: 'submit' });
  });

  // Ревью: соседи по альбому приходят мимо ожидания результата; если они начинали дело, сдача
  // первого фото падала на устаревшей версии.
  it('альбом из трёх фото в ответ на «пришлите фото», первое качается дольше — дело сдано, все три фото на месте', async () => {
    const w = await world();
    const task = await inOrg(w.orgId, (db) => createTask(db, {
      ...base, title: 'фото полок', assigneeUserId: w.person, expectedResult: { type: 'photo', required: true },
    }, w.agent, MON_10));
    const from = await linkTelegram(w.person);
    await bot.handleUpdate(callbackUpdate(from, `a:done:${task.short_id}:${task.version}`));
    const album = `alb-${uniq()}`;
    const [b1, b2, b3] = await Promise.all([screenshot(), screenshot(), screenshot()]);
    const u1 = photoMessage(from, b1, { mediaGroupId: album });
    slowFileId = (u1.message as unknown as { photo: { file_id: string }[] }).photo[1]!.file_id;
    try {
      const p1 = bot.handleUpdate(u1);
      await new Promise((r) => setTimeout(r, 100));
      const rest = Promise.all([bot.handleUpdate(photoMessage(from, b2, { mediaGroupId: album })), bot.handleUpdate(photoMessage(from, b3, { mediaGroupId: album }))]);
      await Promise.all([p1, rest]);
    } finally {
      slowFileId = null;
    }
    expect(await w.task(task.id)).toMatchObject({ status: 'submitted', started_via: 'submit' });
    const att = await inOrg(w.orgId, (db) => db.query('select count(*)::int as n from task_attachments where task_id = $1', [task.id]));
    expect(att.rows[0].n).toBe(3);
  });
});

describe('автоначало уступает чужому действию и в ожидании таймера (ревью 23.10)', () => {
  /** Ставит запрос на паузу перед SQL, содержащим `needle`: так воспроизводится промежуток между двумя замками. */
  function pauseBefore(db: object, needle: string, wait: Promise<void>, reached: () => void): object {
    return new Proxy(db, { get(target, prop) {
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (prop === 'query') {
        return async (...args: unknown[]) => {
          const sql = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | undefined)?.text;
          if (sql?.includes(needle)) { reached(); await wait; }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    } });
  }
  const advisoryWaiters = async () => (await withGlobal((db) => db.query(
    `select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`))).rows[0].n as number;

  // Ответ на вопрос по делу A ставит его таймер и ждёт замок человека; первая реплика к делу B держит
  // этот замок и ждёт уникальный индекс открытого таймера. Без короткого предела ожидания база обрывала
  // ответ — чужое обязательное действие (38 из 80 одновременных столкновений).
  it('ответ на вопрос по другому делу проходит; реплика проходит, дело не начато', async () => {
    const w = await world();
    const b = await readyWithEmptyNow(w);
    const a = (await inOrg(w.orgId, (db) => db.query(
      `select id from tasks where assignee_user_id = $1 and id <> $2`, [w.person, b.id]))).rows[0].id as string;
    let open!: () => void;
    const wait = new Promise<void>((r) => { open = r; });
    let reached = false;
    const comment = inOrg(w.orgId, (db) => addHumanComment(
      pauseBefore(db, 'insert into time_entries', wait, () => { reached = true; }) as typeof db, b.id, w.person, 'начал', minutes(MON_10, 5)), w.person);
    await vi.waitFor(() => { expect(reached).toBe(true); });
    const answer = inOrg(w.orgId, (db) => answerQuestion(db, a, w.agent, 'вот таблица', minutes(MON_10, 5)));
    await vi.waitFor(async () => { expect(await advisoryWaiters()).toBeGreaterThan(0); }, { timeout: 5000 });
    open();
    const res = await Promise.allSettled([answer, comment]);
    expect(res.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect((await w.task(a)).status).toBe('in_progress');
    expect((await w.task(b.id)).started_via).toBeNull();
  });
});
