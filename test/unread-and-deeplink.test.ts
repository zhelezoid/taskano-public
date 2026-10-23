process.env.TASKANO_DISABLE_RATE_LIMIT = '1';

import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserFromGetMe } from 'grammy/types';
import './helpers.js';
import { closePools, withGlobal } from '../src/db/pool.js';
import { createBot } from '../src/bot/bot.js';
import { deliverNotification } from '../src/bot/deliver.js';
import { createTask } from '../src/core/tasks.js';
import { transition } from '../src/core/lifecycle.js';
import { notify } from '../src/core/notify.js';
import { moveTaskToOrg } from '../src/core/routing.js';
import { ensurePersonalOrg } from '../src/core/people.js';
import { env } from '../src/config/env.js';
import { miniappRoutes } from '../src/web/miniapp-api.js';
import { taskFromLaunch } from '../app/src/deeplink.js';
import { t } from '../src/i18n/index.js';
import { addPerson, inOrg, makeAgent, makeOrg } from './helpers.js';

// Новое в деле видно в списке, а уведомление ведёт прямо в дело (спека unread-and-deeplink).

afterAll(closePools);

const BOT_TOKEN = 'test-bot-token-unread';
const app = express();
miniappRoutes(app, { botToken: BOT_TOKEN });
const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };

// Свой диапазон: случайный сдвиг от 880 млн пересекался с test/completed-list.test.ts.
let tgSeq = 1_200_000_000;
const nextTg = (): number => (tgSeq += 1);

/** Подпись Telegram WebApp — как в test/miniapp-actions.test.ts. */
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

async function linkTelegram(userId: string, telegramUserId: number): Promise<void> {
  await withGlobal((db) => db.query(
    `insert into telegram_links(user_id, telegram_user_id, chat_id) values ($1, $2, $3)
     on conflict (user_id) do update set telegram_user_id = excluded.telegram_user_id`,
    [userId, telegramUserId, telegramUserId],
  ));
}

const post = (tgId: number, url: string, body: object = {}) =>
  request(app).post(url).set('X-Telegram-Init-Data', initDataFor(tgId)).send(body);
const get = (tgId: number, url: string) => request(app).get(url).set('X-Telegram-Init-Data', initDataFor(tgId));

interface Scene { orgId: string; ownerId: string; ownerTg: number; person: string; personTg: number; taskId: string }

/** Владелец поставил дело исполнителю; оба вошли в бота. */
async function scene(): Promise<Scene> {
  const { orgId, ownerId } = await makeOrg();
  const person = await addPerson(orgId, 'member');
  const ownerTg = nextTg();
  const personTg = nextTg();
  await linkTelegram(ownerId, ownerTg);
  await linkTelegram(person, personTg);
  const task = await inOrg(orgId, (db) => createTask(db, {
    ...base, title: 'сверить остатки', assigneeUserId: person,
  }, { kind: 'user', userId: ownerId }), ownerId);
  return { orgId, ownerId, ownerTg, person, personTg, taskId: task.id };
}

type Card = { id: string; unread?: boolean };

/** Все дела человека из `/lists` — по всем разделам его компаний. */
async function ownLists(tgId: number): Promise<Card[]> {
  const r = await get(tgId, '/app/api/lists');
  expect(r.status).toBe(200);
  return (r.body.spaces as { lists: Record<string, Card[]> }[]).flatMap((sp) => Object.values(sp.lists).flat());
}

async function personTask(s: Scene): Promise<Card> {
  const r = await get(s.ownerTg, `/app/api/people/${s.person}/tasks`);
  expect(r.status).toBe(200);
  return (r.body.tasks as Card[]).find((x) => x.id === s.taskId)!;
}

async function chip(s: Scene): Promise<{ id: string; unread: boolean }> {
  const r = await get(s.ownerTg, '/app/api/lists');
  const space = (r.body.spaces as { org_id: string; people: { id: string; unread: boolean }[] }[]).find((sp) => sp.org_id === s.orgId)!;
  return space.people.find((p) => p.id === s.person)!;
}

describe('новое в деле (unread)', () => {
  it('реплика исполнителя — новое для владельца в списке человека и на чипе; открытие карточки гасит оба', async () => {
    const s = await scene();
    expect((await personTask(s)).unread).toBe(false);
    expect((await chip(s)).unread).toBe(false);

    expect((await post(s.personTg, `/app/api/tasks/${s.taskId}/comment`, { text: 'остатки не сходятся на складе 2' })).status).toBe(200);
    expect((await personTask(s)).unread).toBe(true);
    expect((await chip(s)).unread).toBe(true);

    expect((await get(s.ownerTg, `/app/api/tasks/${s.taskId}`)).status).toBe(200);
    expect((await personTask(s)).unread).toBe(false);
    expect((await chip(s)).unread).toBe(false);
  });

  it('своя реплика не делает дело новым для автора', async () => {
    const s = await scene();
    expect((await post(s.personTg, `/app/api/tasks/${s.taskId}/comment`, { text: 'начал сверку' })).status).toBe(200);
    const mine = (await ownLists(s.personTg)).find((x) => x.id === s.taskId)!;
    expect(mine.unread).toBe(false);
  });

  it('ответ владельца на вопрос — новое в списке исполнителя', async () => {
    const s = await scene();
    const version = async (): Promise<number> => (await inOrg(s.orgId, (db) => db.query(
      'select version from tasks where id = $1', [s.taskId]), s.ownerId)).rows[0].version as number;
    expect((await post(s.personTg, `/app/api/tasks/${s.taskId}/take`, { version: await version() })).status).toBe(200);
    expect((await post(s.personTg, `/app/api/tasks/${s.taskId}/question`, { text: 'какой склад?', kind: 'question', version: await version() })).status).toBe(200);
    // Свой вопрос новым не считается.
    expect((await ownLists(s.personTg)).find((x) => x.id === s.taskId)!.unread).toBe(false);

    await inOrg(s.orgId, (db) => transition(db, s.taskId, 'answer', { kind: 'user', userId: s.ownerId }, { text: 'второй' }), s.ownerId);
    expect((await ownLists(s.personTg)).find((x) => x.id === s.taskId)!.unread).toBe(true);

    // Открыл карточку — прочитано.
    expect((await get(s.personTg, `/app/api/tasks/${s.taskId}`)).status).toBe(200);
    expect((await ownLists(s.personTg)).find((x) => x.id === s.taskId)!.unread).toBe(false);
  });

  it('открытие карточки не откатывает отметку назад и пишет её в организацию дела', async () => {
    const s = await scene();
    expect((await get(s.ownerTg, `/app/api/tasks/${s.taskId}`)).status).toBe(200);
    const viewOf = async () => (await inOrg(s.orgId, (db) => db.query(
      'select org_id, viewed_at from task_views where user_id = $1 and task_id = $2', [s.ownerId, s.taskId]))).rows[0];
    expect((await viewOf()).org_id).toBe(s.orgId);
    // Отметка уже впереди «сейчас» — повторное открытие карточки её не уменьшает (greatest).
    await inOrg(s.orgId, (db) => db.query(
      `update task_views set viewed_at = now() + interval '1 day' where user_id = $1 and task_id = $2`, [s.ownerId, s.taskId]));
    const ahead = new Date((await viewOf()).viewed_at).getTime();
    expect((await get(s.ownerTg, `/app/api/tasks/${s.taskId}`)).status).toBe(200);
    expect(new Date((await viewOf()).viewed_at).getTime()).toBe(ahead);
  });

  it('результат исполнителя без реплики — новое для владельца; открытие карточки гасит', async () => {
    const s = await scene();
    await inOrg(s.orgId, (db) => transition(db, s.taskId, 'submit', { kind: 'user', userId: s.person },
      { result: { text: 'сверено, расхождений нет' } }), s.person);
    // Проверяем именно ветку результатов: реплик по делу нет.
    const messages = await inOrg(s.orgId, (db) => db.query('select 1 from task_messages where task_id = $1', [s.taskId]), s.ownerId);
    expect(messages.rowCount).toBe(0);
    expect((await personTask(s)).unread).toBe(true);
    expect((await chip(s)).unread).toBe(true);

    expect((await get(s.ownerTg, `/app/api/tasks/${s.taskId}`)).status).toBe(200);
    expect((await personTask(s)).unread).toBe(false);
    expect((await chip(s)).unread).toBe(false);
  });

  it('указание владельца по делу его агента — новое для исполнителя', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId, 'member');
    const ownerTg = nextTg();
    const personTg = nextTg();
    await linkTelegram(ownerId, ownerTg);
    await linkTelegram(person, personTg);
    const agentId = await makeAgent(orgId, ownerId);
    const task = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'пересчитать склад', assigneeUserId: person },
      { kind: 'agent', agentId, userId: ownerId }), ownerId);

    expect((await post(ownerTg, `/app/api/tasks/${task.id}/comment`, { text: 'начни со второго склада' })).status).toBe(200);
    const kinds = await inOrg(orgId, (db) => db.query('select kind from task_messages where task_id = $1', [task.id]), ownerId);
    expect(kinds.rows).toEqual([{ kind: 'owner_instruction' }]);
    expect((await ownLists(personTg)).find((x) => x.id === task.id)!.unread).toBe(true);
  });

  it('перенос дела в другое пространство уносит отметку с собой', async () => {
    const { orgId } = await makeOrg();
    const person = await addPerson(orgId);
    const tg = nextTg();
    await linkTelegram(person, tg);
    const personal = await withGlobal((db) => ensurePersonalOrg(db, person));
    const task = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'записаться к врачу', assigneeUserId: person },
      { kind: 'user', userId: person }), person);
    expect((await get(tg, `/app/api/tasks/${task.id}`)).status).toBe(200);

    await moveTaskToOrg({ kind: 'user', userId: person }, task.id, personal);
    const view = await inOrg(personal, (db) => db.query('select org_id from task_views where task_id = $1', [task.id]), person);
    expect(view.rows).toEqual([{ org_id: personal }]);
  });
});

const BOT_INFO = {
  id: 1, is_bot: true, first_name: 'Taskano', username: 'Taskano_bot', can_join_groups: true,
  can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: true,
} as UserFromGetMe;

type Markup = { inline_keyboard: { text: string; web_app?: { url: string }; callback_data?: string }[][] } | undefined;
let sent: { chat_id: number; text: string; reply_markup: Markup }[];

beforeEach(() => {
  sent = [];
  const bot = createBot({ token: 'test-token', botInfo: BOT_INFO });
  bot.api.config.use(async (_prev, method, payload) => {
    const p = payload as { chat_id: number; text: string; reply_markup?: Markup };
    if (method === 'sendMessage') {
      sent.push({ chat_id: p.chat_id, text: p.text, reply_markup: p.reply_markup });
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: p.chat_id, type: 'private' }, text: p.text } } as any;
    }
    return { ok: true, result: true } as any;
  });
});

async function deliverLatest(orgId: string, userId: string, kind: string): Promise<Markup> {
  const n = (await inOrg(orgId, (db) => db.query(
    'select id from notifications where user_id = $1 and kind = $2 order by created_at desc limit 1', [userId, kind]))).rows[0];
  expect(n, kind).toBeTruthy();
  expect(await deliverNotification(orgId, n.id)).toBe('sent');
  return sent.at(-1)!.reply_markup;
}

describe('уведомление → дело', () => {
  it('уведомление о деле несёт последней строкой web_app «Открыть задачу» на /app/?task=<id>', async () => {
    const s = await scene();
    await post(s.personTg, `/app/api/tasks/${s.taskId}/comment`, { text: 'остатки не сходятся' });
    const markup = await deliverLatest(s.orgId, s.ownerId, 'task_comment');
    const last = markup!.inline_keyboard.at(-1)!;
    expect(last).toHaveLength(1);
    expect(last[0]!.text).toBe(t('ru', 'btn.open_task'));
    expect(last[0]!.web_app?.url).toBe(`${env.publicUrl}/app/?task=${s.taskId}`);
  });

  it('свои кнопки уведомления остаются выше', async () => {
    const s = await scene();
    const version = (await inOrg(s.orgId, (db) => db.query('select version from tasks where id = $1', [s.taskId]))).rows[0].version;
    await post(s.personTg, `/app/api/tasks/${s.taskId}/take`, { version });
    const v2 = (await inOrg(s.orgId, (db) => db.query('select version from tasks where id = $1', [s.taskId]))).rows[0].version;
    await post(s.personTg, `/app/api/tasks/${s.taskId}/question`, { text: 'какой склад?', kind: 'question', version: v2 });
    const markup = await deliverLatest(s.orgId, s.ownerId, 'task_question');
    const rows = markup!.inline_keyboard;
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.slice(0, -1).flat().every((b) => !b.web_app)).toBe(true);
    expect(rows.at(-1)![0]!.web_app?.url).toBe(`${env.publicUrl}/app/?task=${s.taskId}`);
  });

  it('уведомление без дела кнопки «Открыть задачу» не несёт', async () => {
    const s = await scene();
    await inOrg(s.orgId, (db) => notify(db, { userId: s.person, kind: 'open_app', level: 'work', payload: { by: 'Олег' } }));
    const markup = await deliverLatest(s.orgId, s.person, 'open_app');
    expect(JSON.stringify(markup)).not.toContain(t('ru', 'btn.open_task'));
    expect(JSON.stringify(markup)).not.toContain('?task=');
  });
});

describe('разбор параметра запуска Mini App', () => {
  const id = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';
  it('берёт task из адреса', () => {
    expect(taskFromLaunch(`?task=${id}`)).toBe(id);
    expect(taskFromLaunch(`?task=${id.toUpperCase()}`)).toBe(id);
  });
  it('берёт start_param вида task_<id>', () => {
    expect(taskFromLaunch('', `task_${id}`)).toBe(id);
  });
  it('адрес важнее параметра запуска', () => {
    const other = '00000000-0000-4000-8000-000000000000';
    expect(taskFromLaunch(`?task=${id}`, `task_${other}`)).toBe(id);
  });
  it('невалидный id игнорируется', () => {
    expect(taskFromLaunch('?task=abc')).toBeNull();
    expect(taskFromLaunch(`?task=${id}x`)).toBeNull();
    expect(taskFromLaunch('', 'task_1; drop')).toBeNull();
    expect(taskFromLaunch('', id)).toBeNull();
    expect(taskFromLaunch('')).toBeNull();
    expect(taskFromLaunch('', null)).toBeNull();
  });
});
