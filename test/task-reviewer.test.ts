process.env.TASKANO_DISABLE_RATE_LIMIT = '1';

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Update, UserFromGetMe } from 'grammy/types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closePools, withGlobal } from '../src/db/pool.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { createTask, setReviewer } from '../src/core/tasks.js';
import { transition } from '../src/core/lifecycle.js';
import { addHumanComment } from '../src/core/comments.js';
import { offboardPerson } from '../src/core/invitations.js';
import { addProjectMember, createProject, removeProjectMember, setTaskProject, updateProject } from '../src/core/projects.js';
import { moveTaskToOrg } from '../src/core/routing.js';
import { ensurePersonalOrg } from '../src/core/people.js';
import { attachImage } from '../src/core/attachments.js';
import { getBriefing } from '../src/runtime/briefing.js';
import { addWorkingMinutes, loadUserSchedule } from '../src/core/calendar.js';
import { tickOrg } from '../src/worker/tick.js';
import { createBot } from '../src/bot/bot.js';
import { encodeOwnerTask } from '../src/bot/callbacks.js';
import { findTaskByShortId } from '../src/bot/lookup.js';
import { renderCardText } from '../src/bot/cards.js';
import { notificationText, type NotifRow } from '../src/bot/notif-text.js';
import { miniappRoutes } from '../src/web/miniapp-api.js';
import { CURRENT_SKILL_VERSION } from '../src/config/product.js';
import { t } from '../src/i18n/index.js';
import { NOTIFICATION_KINDS } from '../src/core/notification-kinds.js';
import type { Task } from '../src/core/types.js';
import sharp from 'sharp';
import { addPerson, inOrg, makeAgent, makeOrg, minutes, MON_10, uniq } from './helpers.js';

// Поиск дела ботом с крючком «после поиска»: так воспроизводится смена проверяющего между тем, как бот
// нашёл дело, и тем, как он его принял (гонка, которую ловит перепроверка права внутри транзакции).
const lookupHook = vi.hoisted(() => ({ after: null as null | (() => Promise<void>) }));
vi.mock('../src/bot/lookup.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/bot/lookup.js')>();
  return {
    ...mod,
    findTaskByShortId: async (...a: Parameters<typeof mod.findTaskByShortId>) => {
      const found = await mod.findTaskByShortId(...a);
      const hook = lookupHook.after;
      lookupHook.after = null;
      if (hook) await hook();
      return found;
    },
  };
});

// Спека task-reviewer: у обычного дела есть проверяющий — он принимает и возвращает сданное вместо
// автора, а постановщик, исполнитель и проверяющий видят дело и друг друга.

afterAll(closePools);

const base = { why: 'зачем', doneCriteria: 'отчёт лежит в папке', dueDate: '2026-12-31', description: 'как делать: собрать цифры за неделю в таблицу' };
const user = (userId: string) => ({ kind: 'user' as const, userId });

async function call(userId: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: any }> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildMcpServer({ userId }).connect(serverT);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientT);
  const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text: string }[] };
  return { isError: !!r.isError, data: JSON.parse(r.content[0]!.text) };
}

/** Олег ставит, Ахмет делает, Мария проверяет; посторонний — рядовой участник той же компании. */
async function world(opts: { reviewer?: boolean } = {}) {
  const { orgId, ownerId } = await makeOrg();
  const authorId = await addPerson(orgId, 'member', { name: 'Олег' });
  const workerId = await addPerson(orgId, 'member', { name: 'Ахмет' });
  const reviewerId = await addPerson(orgId, 'member', { name: 'Мария' });
  const outsiderId = await addPerson(orgId, 'member', { name: 'Посторонний' });
  const task = await inOrg(orgId, (db) => createTask(db, {
    ...base, title: 'собрать недельный отчёт', assigneeUserId: workerId,
    reviewerUserId: opts.reviewer === false ? null : reviewerId,
  }, user(authorId), MON_10)) as Task;
  return { orgId, ownerId, authorId, workerId, reviewerId, outsiderId, task };
}

async function submit(orgId: string, taskId: string, workerId: string): Promise<Task> {
  await inOrg(orgId, (db) => transition(db, taskId, 'take', user(workerId), { now: MON_10 }));
  return inOrg(orgId, (db) => transition(db, taskId, 'submit', user(workerId), { now: MON_10, result: { text: 'отчёт в папке «Неделя 38»' } }));
}

async function notes(orgId: string, kind: string, userId: string): Promise<NotifRow[]> {
  return (await inOrg(orgId, (db) => db.query(
    `select id, kind, level, task_id, payload, created_at from notifications where kind = $1 and user_id = $2 order by created_at`,
    [kind, userId]))).rows as NotifRow[];
}

async function reviewerOf(orgId: string, taskId: string): Promise<string | null> {
  return (await inOrg(orgId, (db) => db.query('select reviewer_user_id from tasks where id = $1', [taskId]))).rows[0].reviewer_user_id;
}

const SOURCE = { kind: 'chat', title: 'разговор 21 октября', quote: 'Ахмет делает, Мария проверяет' };

describe('назначить проверяющего', () => {
  it('create_task(kind: action, check_person) пишет reviewer_user_id; update_task назначает, меняет и снимает', async () => {
    const w = await world({ reviewer: false });
    const created = await call(w.authorId, 'create_task', {
      org: w.orgId, title: 'сверить остатки', ...{ description: base.description, why: base.why, done_criteria: base.doneCriteria },
      due_date: base.dueDate, assignee: w.workerId, check_person: w.reviewerId, source: SOURCE, idempotency_key: uniq(),
    });
    expect(created.isError, JSON.stringify(created.data)).toBe(false);
    expect(created.data.reviewer_user_id).toBe(w.reviewerId);

    const changed = await call(w.authorId, 'update_task', { org: w.orgId, task: created.data.id, check_person: w.outsiderId });
    expect(changed.isError, JSON.stringify(changed.data)).toBe(false);
    expect(await reviewerOf(w.orgId, created.data.id)).toBe(w.outsiderId);

    const cleared = await call(w.authorId, 'update_task', { org: w.orgId, task: created.data.id, check_person: '' });
    expect(cleared.isError, JSON.stringify(cleared.data)).toBe(false);
    expect(await reviewerOf(w.orgId, created.data.id)).toBeNull();

    // Назначить на существующее дело без проверяющего — и снять null-ом.
    expect((await call(w.authorId, 'update_task', { org: w.orgId, task: w.task.id, check_person: w.reviewerId })).isError).toBe(false);
    expect(await reviewerOf(w.orgId, w.task.id)).toBe(w.reviewerId);
    expect((await call(w.authorId, 'update_task', { org: w.orgId, task: w.task.id, check_person: null })).isError).toBe(false);
    expect(await reviewerOf(w.orgId, w.task.id)).toBeNull();
  });

  it('автор-человек проверяющим не пишется — это обычная приёмка, без ошибки', async () => {
    const w = await world({ reviewer: false });
    const r = await call(w.authorId, 'create_task', {
      org: w.orgId, title: 'позвонить поставщику', description: base.description, why: base.why, done_criteria: base.doneCriteria,
      due_date: base.dueDate, assignee: w.workerId, check_person: w.authorId, source: SOURCE, idempotency_key: uniq(),
    });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(r.data.reviewer_user_id).toBeNull();
  });

  it('у ожидания check_person — как было: waiting.check_user_id, колонка проверяющего пуста', async () => {
    const w = await world({ reviewer: false });
    const r = await call(w.authorId, 'create_task', {
      org: w.orgId, kind: 'waiting', title: 'ответ бухгалтера', waiting_for: 'бухгалтер', next_check_at: '2026-12-01',
      why: base.why, assignee: w.workerId, check_person: w.reviewerId, idempotency_key: uniq(),
    });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(r.data.waiting.check_user_id).toBe(w.reviewerId);
    expect(r.data.reviewer_user_id).toBeNull();
  });

  it('проверяющий = исполнитель → validation_failed при создании и правке', async () => {
    const w = await world({ reviewer: false });
    const created = await call(w.authorId, 'create_task', {
      org: w.orgId, title: 'сверить остатки', description: base.description, why: base.why, done_criteria: base.doneCriteria,
      due_date: base.dueDate, assignee: w.workerId, check_person: w.workerId, source: SOURCE, idempotency_key: uniq(),
    });
    expect(created.isError).toBe(true);
    expect(created.data.code).toBe('validation_failed');

    const updated = await call(w.authorId, 'update_task', { org: w.orgId, task: w.task.id, check_person: w.workerId });
    expect(updated.isError).toBe(true);
    expect(updated.data.code).toBe('validation_failed');
    expect(await reviewerOf(w.orgId, w.task.id)).toBeNull();
  });

  it('закрытый проект: проверяющий вне состава — validation_failed', async () => {
    const { orgId, ownerId } = await makeOrg();
    const reviewerId = await addPerson(orgId);
    const board = await inOrg(orgId, (db) => createProject(db, { name: `Своё ${uniq()}`, private: true }, user(ownerId)), ownerId);
    await expect(inOrg(orgId, (db) => createTask(db, {
      ...base, title: 'своё дело', assigneeUserId: ownerId, project: board.id, reviewerUserId: reviewerId,
    }, user(ownerId), MON_10), ownerId)).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('посторонний правке не допущен: проверяющего меняет автор или owner/admin', async () => {
    const w = await world();
    const r = await call(w.outsiderId, 'update_task', { org: w.orgId, task: w.task.id, check_person: w.outsiderId });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe('forbidden');
    // Владелец вправе — и автор с исполнителем узнают, что дело поменяли не их рукой.
    const owner = await call(w.ownerId, 'update_task', { org: w.orgId, task: w.task.id, check_person: w.outsiderId });
    expect(owner.isError, JSON.stringify(owner.data)).toBe(false);
    expect(await notes(w.orgId, 'task_changed_by_manager', w.authorId)).toHaveLength(1);
  });
});

describe('кто принимает', () => {
  it('review_result: автор и owner — forbidden, агент — forbidden с подсказкой; проверяющий принимает и возвращает', async () => {
    const w = await world();
    await submit(w.orgId, w.task.id, w.workerId);

    for (const who of [w.authorId, w.ownerId]) {
      const r = await call(who, 'review_result', { org: w.orgId, task: w.task.id });
      expect(r.isError).toBe(true);
      expect(r.data.code).toBe('forbidden');
    }
    const agentId = await makeAgent(w.orgId, w.ownerId);
    const byAgent = await call(w.ownerId, 'review_result', { org: w.orgId, agent: agentId, task: w.task.id });
    expect(byAgent.isError).toBe(true);
    expect(byAgent.data.code).toBe('forbidden');
    expect(JSON.stringify(byAgent.data)).toContain('accepted by the reviewer');

    const back = await call(w.reviewerId, 'review_result', { org: w.orgId, task: w.task.id, verdict: 'rework', text: 'нет цифр за пятницу' });
    expect(back.isError, JSON.stringify(back.data)).toBe(false);
    // Возвращённое идёт через очередь: единственное дело исполнителя сразу встаёт в «Сейчас».
    expect(['rework', 'active']).toContain(back.data.status);

    await inOrg(w.orgId, (db) => transition(db, w.task.id, 'submit', user(w.workerId), { now: MON_10, result: { text: 'дописал пятницу' } }));
    const ok = await call(w.reviewerId, 'review_result', { org: w.orgId, task: w.task.id });
    expect(ok.isError, JSON.stringify(ok.data)).toBe(false);
    expect(ok.data.status).toBe('done');
  });

  it('без проверяющего — как сегодня: принимает автор', async () => {
    const w = await world({ reviewer: false });
    await submit(w.orgId, w.task.id, w.workerId);
    expect((await call(w.reviewerId, 'review_result', { org: w.orgId, task: w.task.id })).data.code).toBe('forbidden');
    const ok = await call(w.authorId, 'review_result', { org: w.orgId, task: w.task.id });
    expect(ok.data.status).toBe('done');
  });
});

// ---------------------------------------------------------------- бот

const BOT_INFO: UserFromGetMe = {
  id: 10, is_bot: true, first_name: 'Taskano', username: 'taskano_test_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
  allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
};

let sent: { method: string; payload: Record<string, unknown> }[];
let bot: ReturnType<typeof createBot>;
let nextUpdateId = 1;
let nextMessageId = 1;
let nextTgId = 7_700_000 + Math.floor(Math.random() * 100_000);

beforeEach(() => {
  sent = [];
  bot = createBot({ token: 'test-token', botInfo: BOT_INFO });
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, unknown> });
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

function callback(tgId: number, data: string): Update {
  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: String(nextUpdateId), from: { id: tgId, is_bot: false, first_name: 'Person', language_code: 'ru' }, chat_instance: 'x', data,
      message: { message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: tgId, type: 'private', first_name: 'Person' }, text: 'card' },
    },
  } as unknown as Update;
}

describe('кнопки бота', () => {
  it('ot:accept от автора — отказ, от проверяющего — приём', async () => {
    const w = await world();
    await submit(w.orgId, w.task.id, w.workerId);
    const data = encodeOwnerTask('accept', String(w.task.short_id));

    await bot.handleUpdate(callback(await linkTelegram(w.authorId), data));
    expect(sent.some((s) => s.method === 'sendMessage' && s.payload.text === t('ru', 'error.not_your_task'))).toBe(true);
    let st = await inOrg(w.orgId, (db) => db.query('select status from tasks where id = $1', [w.task.id]));
    expect(st.rows[0].status).toBe('submitted');

    await bot.handleUpdate(callback(await linkTelegram(w.reviewerId), data));
    st = await inOrg(w.orgId, (db) => db.query('select status from tasks where id = $1', [w.task.id]));
    expect(st.rows[0].status).toBe('done');
  });
});

describe('сдача и итог', () => {
  it('сдано: task_submitted проверяющему, автору — нет', async () => {
    const w = await world();
    const done = await submit(w.orgId, w.task.id, w.workerId);
    expect(done.status).toBe('submitted');
    expect(await notes(w.orgId, 'task_submitted', w.reviewerId)).toHaveLength(1);
    expect(await notes(w.orgId, 'task_submitted', w.authorId)).toHaveLength(0);
  });

  it('своё дело с проверяющим остаётся submitted (без проверяющего — сразу done)', async () => {
    const { orgId } = await makeOrg();
    const me = await addPerson(orgId);
    const reviewerId = await addPerson(orgId);
    const own = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'своё', assigneeUserId: me, reviewerUserId: reviewerId }, user(me), MON_10));
    expect((await submit(orgId, own.id, me)).status).toBe('submitted');
    const plain = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'своё без проверки', assigneeUserId: me }, user(me), MON_10));
    expect((await submit(orgId, plain.id, me)).status).toBe('done');
  });

  it('принято → task_done автору и исполнителю; исполнителю — его словами', async () => {
    const w = await world();
    await submit(w.orgId, w.task.id, w.workerId);
    await inOrg(w.orgId, (db) => transition(db, w.task.id, 'accept', user(w.reviewerId), { now: MON_10 }));
    expect(await notes(w.orgId, 'task_done', w.authorId)).toHaveLength(1);
    const mine = await notes(w.orgId, 'task_done', w.workerId);
    expect(mine).toHaveLength(1);
    const text = await inOrg(w.orgId, (db) => notificationText(db, 'ru', mine[0]!, w.workerId));
    expect(text).toContain(t('ru', 'notif.task_done_yours'));
  });

  it('возвращено → task_rework исполнителю, task_returned автору — кто вернул и почему', async () => {
    const w = await world();
    await submit(w.orgId, w.task.id, w.workerId);
    await inOrg(w.orgId, (db) => transition(db, w.task.id, 'rework', user(w.reviewerId), { now: MON_10, text: 'нет цифр за пятницу' }));
    expect(await notes(w.orgId, 'task_rework', w.workerId)).toHaveLength(1);
    const returned = await notes(w.orgId, 'task_returned', w.authorId);
    expect(returned).toHaveLength(1);
    expect(returned[0]!.level).toBe('feed');
    const text = await inOrg(w.orgId, (db) => notificationText(db, 'ru', returned[0]!, w.authorId));
    expect(text).toContain('Мария');
    expect(text).toContain('Ахмет');
    expect(text).toContain('нет цифр за пятницу');
  });

  it('назначили проверяющего на сданное — ему task_submitted; снял владелец — автору', async () => {
    const w = await world({ reviewer: false });
    await submit(w.orgId, w.task.id, w.workerId);
    expect(await notes(w.orgId, 'task_submitted', w.authorId)).toHaveLength(1);
    await call(w.authorId, 'update_task', { org: w.orgId, task: w.task.id, check_person: w.reviewerId });
    expect(await notes(w.orgId, 'task_submitted', w.reviewerId)).toHaveLength(1);
    await call(w.ownerId, 'update_task', { org: w.orgId, task: w.task.id, check_person: null });
    expect(await notes(w.orgId, 'task_submitted', w.authorId)).toHaveLength(2);
  });

  it('проверяющего вывели из компании — поле снято, сданное у автора на приёмке', async () => {
    const w = await world();
    await submit(w.orgId, w.task.id, w.workerId);
    await inOrg(w.orgId, (db) => offboardPerson(db, w.reviewerId, user(w.ownerId)));
    expect(await reviewerOf(w.orgId, w.task.id)).toBeNull();
    expect(await notes(w.orgId, 'task_submitted', w.authorId)).toHaveLength(1);
    expect((await call(w.authorId, 'review_result', { org: w.orgId, task: w.task.id })).data.status).toBe('done');
  });

  it('дело с проверяющим само не принимается; без проверяющего — через 24 рабочих часа автора', async () => {
    const w = await world();
    const plain = await inOrg(w.orgId, (db) => createTask(db, { ...base, title: 'без проверки', assigneeUserId: w.outsiderId }, user(w.authorId), MON_10));
    await submit(w.orgId, w.task.id, w.workerId);
    await submit(w.orgId, plain.id, w.outsiderId);
    const schedule = await inOrg(w.orgId, (db) => loadUserSchedule(db, w.authorId));
    await tickOrg(w.orgId, addWorkingMinutes(schedule, MON_10, 24 * 60 + 5));
    const st = await inOrg(w.orgId, (db) => db.query('select id, status from tasks where id = any($1::uuid[])', [[w.task.id, plain.id]]));
    const status = Object.fromEntries(st.rows.map((r) => [r.id, r.status]));
    expect(status[w.task.id]).toBe('submitted');
    expect(status[plain.id]).toBe('done');
  });
});

describe('закрытие проекта', () => {
  it('чужой проверяющий держит проект открытым — как чужой проверяющий ожидания', async () => {
    const { orgId, ownerId } = await makeOrg();
    const reviewerId = await addPerson(orgId);
    const board = await inOrg(orgId, (db) => createProject(db, { name: `Доска ${uniq()}` }, user(ownerId)), ownerId);
    await inOrg(orgId, (db) => createTask(db, { ...base, title: 'своё с проверкой', assigneeUserId: ownerId, project: board.id, reviewerUserId: reviewerId }, user(ownerId), MON_10), ownerId);
    await expect(inOrg(orgId, (db) => updateProject(db, board.id, { private: true }, user(ownerId)), ownerId))
      .rejects.toMatchObject({ code: 'validation_failed' });
  });
});

// ---------------------------------------------------------------- видимость

const BOT_TOKEN = 'test-bot-token-reviewer';
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

async function card(userId: string, taskId: string) {
  return request(app).get(`/app/api/tasks/${taskId}`).set('X-Telegram-Init-Data', initData(await linkTelegram(userId)));
}

describe('проверяющий видит дело', () => {
  it('get_task / find_task через коннектор, карточка Mini App, бот по номеру; посторонний — нет', async () => {
    const w = await world();

    const dossier = await call(w.reviewerId, 'get_task', { org: w.orgId, task: w.task.id });
    expect(dossier.isError, JSON.stringify(dossier.data)).toBe(false);
    expect(dossier.data.task.reviewer).toMatchObject({ id: w.reviewerId, name: { text: 'Мария' } });
    expect((await call(w.outsiderId, 'get_task', { org: w.orgId, task: w.task.id })).data.code).toBe('not_found');

    const found = await call(w.reviewerId, 'find_task', { org: w.orgId, query: 'недельный отчёт' });
    expect(found.data.tasks.map((x: { id: string }) => x.id)).toContain(w.task.id);
    const none = await call(w.outsiderId, 'find_task', { org: w.orgId, query: 'недельный отчёт' });
    expect(none.data.tasks.map((x: { id: string }) => x.id)).not.toContain(w.task.id);

    expect((await card(w.reviewerId, w.task.id)).status).toBe(200);
    expect((await card(w.outsiderId, w.task.id)).status).toBe(404);

    expect(await findTaskByShortId(w.reviewerId, String(w.task.short_id))).not.toBeNull();
    expect(await findTaskByShortId(w.outsiderId, String(w.task.short_id))).toBeNull();
  });

  it('сданное с проверяющим — в его списке «На проверке» в Mini App', async () => {
    const w = await world();
    await submit(w.orgId, w.task.id, w.workerId);
    const r = await request(app).get('/app/api/lists').set('X-Telegram-Init-Data', initData(await linkTelegram(w.reviewerId)));
    expect(r.status).toBe(200);
    const space = r.body.spaces.find((s: { org_id: string }) => s.org_id === w.orgId);
    expect(space.lists.submitted.map((x: { id: string }) => x.id)).toContain(w.task.id);
  });
});

describe('роли на карточке', () => {
  it('Mini App: people с тремя именами и my_role; результат сданного', async () => {
    const w = await world();
    await submit(w.orgId, w.task.id, w.workerId);
    const asReviewer = await card(w.reviewerId, w.task.id);
    expect(asReviewer.body.task.people).toEqual({ author: 'Олег', assignee: 'Ахмет', reviewer: 'Мария', my_role: 'reviewer' });
    expect(asReviewer.body.task.result).toMatchObject({ text: 'отчёт в папке «Неделя 38»', files: 0 });
    expect((await card(w.authorId, w.task.id)).body.task.people.my_role).toBe('author');
    expect((await card(w.workerId, w.task.id)).body.task.people.my_role).toBe('assignee');
    expect((await card(w.ownerId, w.task.id)).body.task.people.my_role).toBe('manager');
  });

  it('бот: строки «Поставил», «Делает», «Проверяет» и сданный результат', async () => {
    const w = await world();
    await submit(w.orgId, w.task.id, w.workerId);
    const task = (await inOrg(w.orgId, (db) => db.query('select * from tasks where id = $1', [w.task.id]))).rows[0] as Task;
    const { text } = await inOrg(w.orgId, (db) => renderCardText(db, task, 'ru', { sourceLang: 'ru' }));
    expect(text).toContain(t('ru', 'card.author', { text: 'Олег' }));
    expect(text).toContain(t('ru', 'card.assignee', { name: 'Ахмет' }));
    expect(text).toContain(t('ru', 'card.reviewer', { name: 'Мария' }));
    expect(text).toContain('отчёт в папке «Неделя 38»');
  });
});

describe('переписка', () => {
  it('реплику проверяющего видят автор и исполнитель; уведомление — исполнителю, автору нет', async () => {
    const w = await world();
    await inOrg(w.orgId, (db) => addHumanComment(db, w.task.id, w.reviewerId, 'пришли ещё сводку по складу'));

    for (const who of [w.authorId, w.workerId]) {
      const r = await card(who, w.task.id);
      expect(r.body.notes.map((n: { text: string }) => n.text)).toContain('пришли ещё сводку по складу');
    }
    expect(await notes(w.orgId, 'task_comment', w.workerId)).toHaveLength(1);
    expect(await notes(w.orgId, 'task_comment', w.authorId)).toHaveLength(0);

    // Реплика исполнителя идёт проверяющему, автору — нет.
    await inOrg(w.orgId, (db) => addHumanComment(db, w.task.id, w.workerId, 'сводку приложу к пятнице'));
    expect(await notes(w.orgId, 'task_comment', w.reviewerId)).toHaveLength(1);
    expect(await notes(w.orgId, 'task_comment', w.authorId)).toHaveLength(0);
  });
});

describe('навык taskano', () => {
  it('assigning.md описывает check_person у обычного дела; версия 0.7.12 в трёх местах', () => {
    const assigning = readFileSync('skill/skills/taskano/assigning.md', 'utf8');
    expect(assigning).toMatch(/## Who checks it[\s\S]*check_person[\s\S]*only the outcome/);
    const skill = readFileSync('skill/skills/taskano/SKILL.md', 'utf8');
    const plugin = JSON.parse(readFileSync('skill/.claude-plugin/plugin.json', 'utf8')) as { version: string };
    expect(CURRENT_SKILL_VERSION).toBe('0.7.12');
    expect(skill).toMatch(/^version: 0\.7\.12$/m);
    expect(plugin.version).toBe('0.7.12');
  });
});

// ---------------------------------------------------------------- ревью веером: права и зависшие дела

function textMessage(tgId: number, text: string): Update {
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextMessageId++, date: Math.floor(Date.now() / 1000),
      chat: { id: tgId, type: 'private', first_name: 'Person' },
      from: { id: tgId, is_bot: false, first_name: 'Person', language_code: 'ru' }, text,
    },
  } as unknown as Update;
}

async function statusOf(orgId: string, taskId: string): Promise<string> {
  return (await inOrg(orgId, (db) => db.query('select status from tasks where id = $1', [taskId]))).rows[0].status;
}

describe('права на проверяющего', () => {
  it('1. владелец не назначает проверяющим себя на чужое дело', async () => {
    const w = await world({ reviewer: false });
    const r = await call(w.ownerId, 'update_task', { org: w.orgId, task: w.task.id, check_person: w.ownerId });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe('forbidden');
    expect(await reviewerOf(w.orgId, w.task.id)).toBeNull();
  });

  it('2. агент назначает проверяющего при постановке, но снять его не может', async () => {
    const w = await world({ reviewer: false });
    const agentId = await makeAgent(w.orgId, w.ownerId);
    const own = await inOrg(w.orgId, (db) => createTask(db, {
      ...base, title: 'дело агента с проверкой', assigneeUserId: w.workerId, reviewerUserId: w.reviewerId,
    }, { kind: 'agent', agentId, userId: w.ownerId }, MON_10));
    expect(own.reviewer_user_id).toBe(w.reviewerId);
    const r = await call(w.ownerId, 'update_task', { org: w.orgId, agent: agentId, task: own.id, check_person: null });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe('forbidden');
    expect(JSON.stringify(r.data)).toContain("Changing the reviewer is a person's decision");
    expect(await reviewerOf(w.orgId, own.id)).toBe(w.reviewerId);
  });

  it('3. гость и приглашённый (ещё не вошедший) проверяющими не бывают', async () => {
    const { orgId, ownerId } = await makeOrg();
    const worker = await addPerson(orgId);
    const guest = await addPerson(orgId, 'guest');
    const invited = await addPerson(orgId);
    await withGlobal((db) => db.query(`update memberships set status = 'invited' where org_id = $1 and user_id = $2`, [orgId, invited]));
    for (const reviewerUserId of [guest, invited]) {
      await expect(inOrg(orgId, (db) => createTask(db, { ...base, title: 'с проверкой', assigneeUserId: worker, reviewerUserId }, user(ownerId), MON_10)))
        .rejects.toMatchObject({ code: 'validation_failed' });
    }
  });

  it('4. кнопка «Принять»: проверяющего сменили после поиска дела — приём не проходит', async () => {
    const w = await world();
    await submit(w.orgId, w.task.id, w.workerId);
    const tg = await linkTelegram(w.reviewerId);
    lookupHook.after = () => inOrg(w.orgId, (db) => setReviewer(db, w.task.id, w.outsiderId, user(w.authorId)).then(() => undefined));
    await bot.handleUpdate(callback(tg, encodeOwnerTask('accept', String(w.task.short_id))));
    expect(await statusOf(w.orgId, w.task.id)).toBe('submitted');
    expect(sent.some((s) => s.method === 'sendMessage' && s.payload.text === t('ru', 'error.not_your_task'))).toBe(true);
  });

  it('4. диалог «Вернуть»: пока автор писал причину, назначили проверяющего — возврат не проходит', async () => {
    const w = await world({ reviewer: false });
    await submit(w.orgId, w.task.id, w.workerId);
    const tg = await linkTelegram(w.authorId);
    await bot.handleUpdate(callback(tg, encodeOwnerTask('rework', String(w.task.short_id))));
    await inOrg(w.orgId, (db) => setReviewer(db, w.task.id, w.reviewerId, user(w.authorId)));
    await bot.handleUpdate(textMessage(tg, 'нет цифр за пятницу'));
    expect(await statusOf(w.orgId, w.task.id)).toBe('submitted');
    expect(sent.some((s) => s.method === 'sendMessage' && s.payload.text === t('ru', 'error.not_your_task'))).toBe(true);
  });
});

describe('сданное не повисает', () => {
  it('5. перенос своего дела в личное снимает проверяющего', async () => {
    const { orgId } = await makeOrg();
    const me = await addPerson(orgId);
    const reviewerId = await addPerson(orgId);
    const own = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'своё с проверкой', assigneeUserId: me, reviewerUserId: reviewerId }, user(me), MON_10));
    const personal = await withGlobal((db) => ensurePersonalOrg(db, me));
    const moved = await moveTaskToOrg(user(me), own.id, personal);
    expect(moved.reviewer_user_id).toBeNull();
  });

  it('6. проверяющего открытого дела не вывести из состава закрытого проекта; без проверяющего в составе дело туда не перенести', async () => {
    const { orgId, ownerId } = await makeOrg();
    const reviewerId = await addPerson(orgId);
    const board = await inOrg(orgId, (db) => createProject(db, { name: `Закрытая ${uniq()}`, private: true }, user(ownerId)), ownerId);
    await inOrg(orgId, (db) => addProjectMember(db, board.id, reviewerId, user(ownerId)), ownerId);
    const inside = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'внутри', assigneeUserId: ownerId, project: board.id, reviewerUserId: reviewerId }, user(ownerId), MON_10), ownerId);
    const err = await inOrg(orgId, (db) => removeProjectMember(db, board.id, reviewerId, user(ownerId)), ownerId).catch((e) => e);
    expect(err).toMatchObject({ code: 'validation_failed' });
    expect(String(err.message)).toContain(`${board.key}-${String(inside.number).padStart(3, '0')}`);

    const other = await inOrg(orgId, (db) => createProject(db, { name: `Другая ${uniq()}`, private: true }, user(ownerId)), ownerId);
    const outside = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'снаружи', assigneeUserId: ownerId, reviewerUserId: reviewerId }, user(ownerId), MON_10), ownerId);
    await expect(inOrg(orgId, (db) => setTaskProject(db, outside.id, other.id, user(ownerId)), ownerId))
      .rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('7. дело, ставшее ожиданием, теряет проверяющего', async () => {
    const w = await world();
    const next = await inOrg(w.orgId, (db) => createTask(db, { ...base, title: 'в очереди', assigneeUserId: w.workerId, reviewerUserId: w.reviewerId }, user(w.authorId), MON_10));
    expect(next.status).toBe('ready');
    const r = await call(w.authorId, 'update_task', { org: w.orgId, task: next.id, waiting_for: 'ответ поставщика' });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(await reviewerOf(w.orgId, next.id)).toBeNull();
  });

  it('8а. автор снял проверяющего сам — себе «сдано» не пишет', async () => {
    const w = await world();
    await submit(w.orgId, w.task.id, w.workerId);
    await call(w.authorId, 'update_task', { org: w.orgId, task: w.task.id, check_person: null });
    expect(await notes(w.orgId, 'task_submitted', w.authorId)).toHaveLength(0);
  });

  it('8б. приёмка вернулась автору — автоприёмка считает с этой минуты, а не со сдачи', async () => {
    const w = await world();
    await submit(w.orgId, w.task.id, w.workerId);
    await call(w.ownerId, 'update_task', { org: w.orgId, task: w.task.id, check_person: null });
    const schedule = await inOrg(w.orgId, (db) => loadUserSchedule(db, w.authorId));
    await tickOrg(w.orgId, addWorkingMinutes(schedule, MON_10, 24 * 60 + 5));
    expect(await statusOf(w.orgId, w.task.id)).toBe('submitted');
  });

  it('8в. своё дело: проверяющего сняли со сданного — оно закрывается как своё', async () => {
    const { orgId } = await makeOrg();
    const me = await addPerson(orgId);
    const reviewerId = await addPerson(orgId);
    const own = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'своё', assigneeUserId: me, reviewerUserId: reviewerId }, user(me), MON_10));
    await submit(orgId, own.id, me);
    await call(me, 'update_task', { org: orgId, task: own.id, check_person: null });
    expect(await statusOf(orgId, own.id)).toBe('done');
  });

  it('9. смена проверяющего гасит у прежнего недоставленное «сдано»', async () => {
    const w = await world();
    await submit(w.orgId, w.task.id, w.workerId);
    expect((await notes(w.orgId, 'task_submitted', w.reviewerId))[0]).toBeDefined();
    await call(w.authorId, 'update_task', { org: w.orgId, task: w.task.id, check_person: w.outsiderId });
    const old = await inOrg(w.orgId, (db) => db.query(
      `select delivered_at from notifications where kind = 'task_submitted' and user_id = $1 and task_id = $2`, [w.reviewerId, w.task.id]));
    expect(old.rows[0].delivered_at).not.toBeNull();
    const fresh = await inOrg(w.orgId, (db) => db.query(
      `select delivered_at from notifications where kind = 'task_submitted' and user_id = $1 and task_id = $2`, [w.outsiderId, w.task.id]));
    expect(fresh.rows[0].delivered_at).toBeNull();
  });

  it('проверяющего вывели из компании — у несданного дела автор узнаёт, что дело поменяли', async () => {
    const w = await world();
    await inOrg(w.orgId, (db) => offboardPerson(db, w.reviewerId, user(w.ownerId)));
    expect(await reviewerOf(w.orgId, w.task.id)).toBeNull();
    expect(await notes(w.orgId, 'task_changed_by_manager', w.authorId)).toHaveLength(1);
  });
});

describe('сводки', () => {
  it('10. сданное ждёт проверяющего: awaiting_you — у него, не у автора; не у агента; в attention — кто принимает', async () => {
    const w = await world();
    await submit(w.orgId, w.task.id, w.workerId);
    const agentId = await makeAgent(w.orgId, w.ownerId);
    const byAgent = await inOrg(w.orgId, (db) => createTask(db, {
      ...base, title: 'от агента с проверкой', assigneeUserId: w.outsiderId, reviewerUserId: w.reviewerId,
    }, { kind: 'agent', agentId, userId: w.ownerId }, MON_10));
    await submit(w.orgId, byAgent.id, w.outsiderId);
    const later = minutes(MON_10, 3 * 24 * 60);

    const forReviewer = await inOrg(w.orgId, (db) => getBriefing(db, later, { viewer: { userId: w.reviewerId, withPrivate: true } }));
    expect(forReviewer.awaiting_you.submitted.map((x) => x.id)).toEqual(expect.arrayContaining([w.task.id, byAgent.id]));
    const forAuthor = await inOrg(w.orgId, (db) => getBriefing(db, later, { viewer: { userId: w.authorId, withPrivate: true } }));
    expect(forAuthor.awaiting_you.submitted.map((x) => x.id)).not.toContain(w.task.id);

    const full = await inOrg(w.orgId, (db) => getBriefing(db, later, { attention: true }));
    const agent = full.agents.find((a) => a.id === agentId)!;
    expect(agent.submitted.map((x) => x.id)).not.toContain(byAgent.id);
    const row = full.attention!.waiting_review.find((x) => x.task === w.task.id)!;
    expect(row.reviewer).toMatchObject({ text: 'Мария' });
  });
});

describe('уведомления', () => {
  it('11. проверяющий закрыл несданное с доказательством — автору итог task_done', async () => {
    const w = await world();
    const r = await call(w.reviewerId, 'review_result', { org: w.orgId, task: w.task.id, evidence: 'отчёт лежит в папке «Неделя 38»' });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(r.data.status).toBe('done');
    expect(await notes(w.orgId, 'task_done', w.authorId)).toHaveLength(1);
  });

  it('12. фото исполнителя уходит проверяющему, а не автору', async () => {
    const w = await world();
    const image = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 10, g: 200, b: 90 } } }).png().toBuffer();
    await inOrg(w.orgId, (db) => attachImage(db, { taskId: w.task.id, userId: w.workerId, image, now: MON_10 }), w.workerId);
    expect(await notes(w.orgId, 'task_photo', w.reviewerId)).toHaveLength(1);
    expect(await notes(w.orgId, 'task_photo', w.authorId)).toHaveLength(0);
  });

  it('13. назначенному проверяющим несданного дела — строка в ленту', async () => {
    const w = await world();
    const assigned = await notes(w.orgId, 'task_reviewer_assigned', w.reviewerId);
    expect(assigned).toHaveLength(1);
    expect(assigned[0]!.level).toBe('feed');
    expect(await inOrg(w.orgId, (db) => notificationText(db, 'ru', assigned[0]!, w.reviewerId))).toContain(t('ru', 'notif.task_reviewer_assigned'));
    await call(w.authorId, 'update_task', { org: w.orgId, task: w.task.id, check_person: w.outsiderId });
    expect(await notes(w.orgId, 'task_reviewer_assigned', w.outsiderId)).toHaveLength(1);
  });
});

describe('прочее', () => {
  it('14. длинный результат в карточке бота обрезан', async () => {
    const w = await world();
    await inOrg(w.orgId, (db) => transition(db, w.task.id, 'submit', user(w.workerId), { now: MON_10, result: { text: 'я'.repeat(3000) } }));
    const task = (await inOrg(w.orgId, (db) => db.query('select * from tasks where id = $1', [w.task.id]))).rows[0] as Task;
    const { text } = await inOrg(w.orgId, (db) => renderCardText(db, task, 'ru', { sourceLang: 'ru' }));
    expect(text).toContain('…');
    expect(text).not.toContain('я'.repeat(501));
  });

  it('15. смена проверяющего и перенос в закрытый проект одним вызовом — по составу нового проекта', async () => {
    const w = await world({ reviewer: false });
    const second = await addPerson(w.orgId, 'member', { name: 'Второй' });
    const from = await inOrg(w.orgId, (db) => createProject(db, { name: `Откуда ${uniq()}`, private: true }, user(w.authorId)), w.authorId);
    const into = await inOrg(w.orgId, (db) => createProject(db, { name: `Куда ${uniq()}`, private: true }, user(w.authorId)), w.authorId);
    for (const [board, who] of [[from, w.workerId], [from, w.reviewerId], [into, w.workerId], [into, second]] as const) {
      await inOrg(w.orgId, (db) => addProjectMember(db, board.id, who, user(w.authorId)), w.authorId);
    }
    const task = await inOrg(w.orgId, (db) => createTask(db, {
      ...base, title: 'переезд с заменой', assigneeUserId: w.workerId, project: from.id, reviewerUserId: w.reviewerId,
    }, user(w.authorId), MON_10), w.authorId);
    const r = await call(w.authorId, 'update_task', { org: w.orgId, task: task.id, check_person: second, project: into.id });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    const row = (await inOrg(w.orgId, (db) => db.query('select reviewer_user_id, project_id from tasks where id = $1', [task.id]), w.authorId)).rows[0];
    expect(row).toEqual({ reviewer_user_id: second, project_id: into.id });
  });

  it('16. проверяющий возвращает принятое дело в работу из приложения', async () => {
    const w = await world();
    await submit(w.orgId, w.task.id, w.workerId);
    await inOrg(w.orgId, (db) => transition(db, w.task.id, 'accept', user(w.reviewerId), { now: MON_10 }));
    const r = await request(app).post(`/app/api/tasks/${w.task.id}/reopen`)
      .set('X-Telegram-Init-Data', initData(await linkTelegram(w.reviewerId))).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await statusOf(w.orgId, w.task.id)).not.toBe('done');
  });

  it('17. submit_task говорит, что принимает проверяющий, если он назван', async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await buildMcpServer({ userId: (await makeOrg()).ownerId }).connect(serverT);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(clientT);
    const tool = (await client.listTools()).tools.find((x) => x.name === 'submit_task')!;
    expect(tool.description).toContain('the reviewer');
  });
});

// Молчание проверяющего (решение владельца 21.10): дело с проверяющим само не принимается, поэтому
// молчание не должно повисать — 24 его рабочих часа напоминание ему, 48 — сообщение постановщику.
describe('молчание проверяющего', () => {
  const DAY = 24 * 60;

  /** Тик в момент, когда с `from` прошло `mins` рабочих минут по расписанию `whose`. */
  async function tickAfter(w: { orgId: string }, whose: string, mins: number, from: Date = MON_10): Promise<Date> {
    const schedule = await inOrg(w.orgId, (db) => loadUserSchedule(db, whose));
    const at = addWorkingMinutes(schedule, from, mins);
    await tickOrg(w.orgId, at);
    return at;
  }

  it('24 рабочих часа проверяющего: на 1439 минуте тихо, на 1440 — напоминание; не раньше и не дважды', async () => {
    const w = await world();
    await submit(w.orgId, w.task.id, w.workerId);
    await tickAfter(w, w.reviewerId, DAY - 1);
    expect(await notes(w.orgId, 'review_reminder', w.reviewerId)).toHaveLength(0);
    await tickAfter(w, w.reviewerId, DAY);
    const got = await notes(w.orgId, 'review_reminder', w.reviewerId);
    expect(got).toHaveLength(1);
    expect(got[0]!.level).toBe('work');
    expect(got[0]!.level).toBe(NOTIFICATION_KINDS.review_reminder);
    expect(got[0]!.task_id).toBe(w.task.id);
    await tickAfter(w, w.reviewerId, DAY + 30);
    expect(await notes(w.orgId, 'review_reminder', w.reviewerId)).toHaveLength(1);
    // Автору и исполнителю напоминание не уходит.
    expect(await notes(w.orgId, 'review_reminder', w.authorId)).toHaveLength(0);
    expect(await notes(w.orgId, 'review_reminder', w.workerId)).toHaveLength(0);
    // Дело по-прежнему ждёт проверяющего: само не принято.
    expect(await statusOf(w.orgId, w.task.id)).toBe('submitted');
  });

  it('48 рабочих часов: на 2879 минуте постановщику тихо, на 2880 — review_overdue с проверяющим и часами; один раз', async () => {
    const w = await world();
    await submit(w.orgId, w.task.id, w.workerId);
    await tickAfter(w, w.reviewerId, 2 * DAY - 1);
    expect(await notes(w.orgId, 'review_overdue', w.authorId)).toHaveLength(0);
    await tickAfter(w, w.reviewerId, 2 * DAY);
    const got = await notes(w.orgId, 'review_overdue', w.authorId);
    expect(got).toHaveLength(1);
    expect(got[0]!.level).toBe('decision');
    expect(got[0]!.level).toBe(NOTIFICATION_KINDS.review_overdue);
    expect(got[0]!.payload).toMatchObject({ reviewer_id: w.reviewerId, hours: 48 });
    await tickAfter(w, w.reviewerId, 2 * DAY + 60);
    expect(await notes(w.orgId, 'review_overdue', w.authorId)).toHaveLength(1);
    expect(await notes(w.orgId, 'review_overdue', w.reviewerId)).toHaveLength(0);
    // Текст: кто проверяет, какое дело, сколько ждёт.
    const text = await inOrg(w.orgId, (db) => notificationText(db, 'ru', got[0]!, w.authorId));
    expect(text).toContain('Мария');
    expect(text).toContain('собрать недельный отчёт');
    expect(text).toContain('48');
  });

  it('поздний тик: часы в сообщении — сколько ждали на самом деле, а не порог', async () => {
    const w = await world();
    await submit(w.orgId, w.task.id, w.workerId);
    await tickAfter(w, w.reviewerId, 60 * 60);
    const got = await notes(w.orgId, 'review_overdue', w.authorId);
    expect(got).toHaveLength(1);
    expect(got[0]!.payload).toMatchObject({ hours: 60 });
    expect(await inOrg(w.orgId, (db) => notificationText(db, 'ru', got[0]!, w.authorId))).toContain('60');
    // Оба сообщения ушли одним тиком, второй тик ничего не добавляет.
    expect(await notes(w.orgId, 'review_reminder', w.reviewerId)).toHaveLength(1);
    await tickAfter(w, w.reviewerId, 70 * 60);
    expect(await notes(w.orgId, 'review_overdue', w.authorId)).toHaveLength(1);
  });

  it('передача проверки другому: отсчёт заново для нового, submitted_at не тронут', async () => {
    const w = await world();
    await submit(w.orgId, w.task.id, w.workerId);
    await tickAfter(w, w.reviewerId, DAY);
    expect(await notes(w.orgId, 'review_reminder', w.reviewerId)).toHaveLength(1);

    const schedule = await inOrg(w.orgId, (db) => loadUserSchedule(db, w.outsiderId));
    const handoverAt = addWorkingMinutes(schedule, MON_10, DAY + 6 * 60);
    const before = (await inOrg(w.orgId, (db) => db.query('select submitted_at from tasks where id = $1', [w.task.id]))).rows[0].submitted_at as Date;
    await inOrg(w.orgId, (db) => setReviewer(db, w.task.id, w.outsiderId, user(w.authorId), handoverAt), w.authorId);
    const after = (await inOrg(w.orgId, (db) => db.query('select submitted_at from tasks where id = $1', [w.task.id]))).rows[0].submitted_at as Date;
    expect(new Date(after).getTime()).toBe(new Date(before).getTime());

    await tickAfter(w, w.outsiderId, DAY - 1, handoverAt);
    expect(await notes(w.orgId, 'review_reminder', w.outsiderId)).toHaveLength(0);
    await tickAfter(w, w.outsiderId, DAY, handoverAt);
    expect(await notes(w.orgId, 'review_reminder', w.outsiderId)).toHaveLength(1);
    // Прежнему — ничего нового; постановщику рано: новому не прошло и 48 часов.
    expect(await notes(w.orgId, 'review_reminder', w.reviewerId)).toHaveLength(1);
    await tickAfter(w, w.outsiderId, 2 * DAY - 1, handoverAt);
    expect(await notes(w.orgId, 'review_overdue', w.authorId)).toHaveLength(0);
    await tickAfter(w, w.outsiderId, 2 * DAY, handoverAt);
    const got = await notes(w.orgId, 'review_overdue', w.authorId);
    expect(got).toHaveLength(1);
    expect(got[0]!.payload).toMatchObject({ reviewer_id: w.outsiderId, hours: 48 });
    expect(await inOrg(w.orgId, (db) => notificationText(db, 'ru', got[0]!, w.authorId))).toContain('Посторонний');
  });

  it('постановщик ушёл из компании — о молчании узнаёт владелец организации', async () => {
    const w = await world();
    await submit(w.orgId, w.task.id, w.workerId);
    await withGlobal((db) => db.query(`update memberships set status = 'removed' where org_id = $1 and user_id = $2`, [w.orgId, w.authorId]));
    await tickAfter(w, w.reviewerId, 2 * DAY);
    expect(await notes(w.orgId, 'review_overdue', w.authorId)).toHaveLength(0);
    expect(await notes(w.orgId, 'review_overdue', w.ownerId)).toHaveLength(1);
  });

  it('принято или возвращено до срока — ни напоминания, ни сообщения', async () => {
    const w = await world();
    const second = await inOrg(w.orgId, (db) => createTask(db, { ...base, title: 'второе дело', assigneeUserId: w.workerId, reviewerUserId: w.reviewerId }, user(w.authorId), MON_10));
    await submit(w.orgId, w.task.id, w.workerId);
    await submit(w.orgId, second.id, w.workerId);
    await inOrg(w.orgId, (db) => transition(db, w.task.id, 'accept', user(w.reviewerId), { now: MON_10 }));
    await inOrg(w.orgId, (db) => transition(db, second.id, 'rework', user(w.reviewerId), { now: MON_10, text: 'нет цифр' }));
    await tickAfter(w, w.reviewerId, 2 * DAY + 60);
    expect(await notes(w.orgId, 'review_reminder', w.reviewerId)).toHaveLength(0);
    expect(await notes(w.orgId, 'review_overdue', w.authorId)).toHaveLength(0);
  });

  it('новая сдача после «на доработку» — новый отсчёт и новые сообщения', async () => {
    const w = await world();
    await submit(w.orgId, w.task.id, w.workerId);
    await tickAfter(w, w.reviewerId, 2 * DAY);
    expect(await notes(w.orgId, 'review_reminder', w.reviewerId)).toHaveLength(1);
    expect(await notes(w.orgId, 'review_overdue', w.authorId)).toHaveLength(1);

    const reworkAt = await tickAfter(w, w.reviewerId, 2 * DAY + 10);
    await inOrg(w.orgId, (db) => transition(db, w.task.id, 'rework', user(w.reviewerId), { now: reworkAt, text: 'нет цифр за пятницу' }));
    const resubmitAt = minutes(reworkAt, 60);
    await inOrg(w.orgId, (db) => transition(db, w.task.id, 'take', user(w.workerId), { now: resubmitAt }));
    await inOrg(w.orgId, (db) => transition(db, w.task.id, 'submit', user(w.workerId), { now: resubmitAt, result: { text: 'добавил пятницу' } }));

    // Сразу после повторной сдачи старые сообщения новых не плодят.
    await tickAfter(w, w.reviewerId, DAY - 1, resubmitAt);
    expect(await notes(w.orgId, 'review_reminder', w.reviewerId)).toHaveLength(1);
    await tickAfter(w, w.reviewerId, DAY, resubmitAt);
    expect(await notes(w.orgId, 'review_reminder', w.reviewerId)).toHaveLength(2);
    expect(await notes(w.orgId, 'review_overdue', w.authorId)).toHaveLength(1);
    await tickAfter(w, w.reviewerId, 2 * DAY, resubmitAt);
    expect(await notes(w.orgId, 'review_overdue', w.authorId)).toHaveLength(2);
  });

  it('часы идут по расписанию проверяющего, а не автора', async () => {
    const w = await world();
    // У Марии короткий день (4 часа вместо 9): её 24 рабочих часа наступают заметно позже, чем у автора.
    await withGlobal((db) => db.query(`update users set work_start = '10:00', work_end = '14:00' where id = $1`, [w.reviewerId]));
    await submit(w.orgId, w.task.id, w.workerId);
    await tickAfter(w, w.authorId, 2 * DAY);
    expect(await notes(w.orgId, 'review_reminder', w.reviewerId)).toHaveLength(0);
    expect(await notes(w.orgId, 'review_overdue', w.authorId)).toHaveLength(0);
    await tickAfter(w, w.reviewerId, DAY);
    expect(await notes(w.orgId, 'review_reminder', w.reviewerId)).toHaveLength(1);
    expect(await notes(w.orgId, 'review_overdue', w.authorId)).toHaveLength(0);
    await tickAfter(w, w.reviewerId, 2 * DAY);
    expect(await notes(w.orgId, 'review_overdue', w.authorId)).toHaveLength(1);
  });

  it('в боте напоминание проверяющему несёт кнопки «Принять» и «Вернуть», как сданное', async () => {
    const w = await world();
    const tgId = await linkTelegram(w.reviewerId);
    await submit(w.orgId, w.task.id, w.workerId);
    const shortId = (await inOrg(w.orgId, (db) => db.query('select short_id::text as id from tasks where id = $1', [w.task.id]))).rows[0].id as string;
    const at = await tickAfter(w, w.reviewerId, DAY);
    // notify() пишет deliver_after по часам базы, а тик идёт по симулированным: возвращаем срок доставки в прошлое
    // и тикаем ещё раз — дубля напоминание не даст (ключ), а доставка заберёт его.
    await inOrg(w.orgId, (db) => db.query(`update notifications set deliver_after = $1 where kind = 'review_reminder'`, [at]));
    await tickOrg(w.orgId, at);
    const msg = [...sent].reverse().find((s) => s.method === 'sendMessage' && s.payload.chat_id === tgId && s.payload.reply_markup);
    expect(msg).toBeDefined();
    const buttons = (msg!.payload.reply_markup as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard.flat().map((b) => b.callback_data).filter(Boolean);
    expect(buttons).toEqual([encodeOwnerTask('accept', shortId), encodeOwnerTask('rework', shortId)]);
  });
});
