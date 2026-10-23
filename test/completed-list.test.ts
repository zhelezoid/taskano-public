import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import './helpers.js';
import { closePools, withGlobal, withOrg } from '../src/db/pool.js';
import { miniappRoutes } from '../src/web/miniapp-api.js';
import { createTask } from '../src/core/tasks.js';
import { transition } from '../src/core/lifecycle.js';
import { createProject } from '../src/core/projects.js';
import { offboardPerson } from '../src/core/invitations.js';
import { addPerson, inOrg, makeOrg, uniq } from './helpers.js';

// Раздел «Завершённые» и возврат дела в работу (спека completed-list). Данные готовим ядром,
// проверяем через те же ручки, что зовёт приложение.

afterAll(closePools);

const BOT_TOKEN = 'test-bot-token-completed';
const app = express();
miniappRoutes(app, { botToken: BOT_TOKEN });
const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };

let tgSeq = 880000000;
const nextTg = (): number => (tgSeq += 1);

/** Подпись Telegram WebApp — как в test/miniapp-auth.test.ts. */
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

async function doneTask(orgId: string, taskId: string, userId: string): Promise<void> {
  // Дело, поставленное человеком, создаётся сразу в работе — выпускать нечего.
  await inOrg(orgId, async (db) => {
    const t = await transition(db, taskId, 'submit', { kind: 'user', userId });
    // В закрытом проекте «сделал» закрывает дело сразу (спека projects-stage2): принимать личное
    // некому, человек сам себе и автор, и исполнитель.
    if (t.status !== 'done') await transition(db, taskId, 'accept', { kind: 'user', userId });
  }, userId);
}

async function makeDoneTask(orgId: string, userId: string, title: string): Promise<string> {
  const task = await inOrg(orgId, (db) => createTask(db, {
    ...base, title, assigneeUserId: userId,
  }, { kind: 'user', userId }), userId);
  await doneTask(orgId, task.id, userId);
  return task.id;
}

function agent(tgId: number) {
  return { get: (url: string) => request(app).get(url).set('X-Telegram-Init-Data', initDataFor(tgId)) };
}

describe('список завершённых', () => {
  it('отдаёт закрытые дела человека, свежие сверху', async () => {
    const { orgId, ownerId } = await makeOrg();
    const tg = nextTg();
    await linkTelegram(ownerId, tg);
    await makeDoneTask(orgId, ownerId, 'Первое закрытое');
    await makeDoneTask(orgId, ownerId, 'Второе закрытое');

    const r = await agent(tg).get('/app/api/completed');
    expect(r.status).toBe(200);
    const space = r.body.spaces.find((s: { org_id: string }) => s.org_id === orgId);
    expect(space.tasks.map((t: { title: string }) => t.title)).toEqual(['Второе закрытое', 'Первое закрытое']);
  });

  it('открытых дел в разделе нет', async () => {
    const { orgId, ownerId } = await makeOrg();
    const tg = nextTg();
    await linkTelegram(ownerId, tg);
    const open = await inOrg(orgId, (db) => createTask(db, {
      ...base, title: 'Ещё в работе', assigneeUserId: ownerId,
    }, { kind: 'user', userId: ownerId }), ownerId);

    const r = await agent(tg).get('/app/api/completed');
    const space = r.body.spaces.find((s: { org_id: string }) => s.org_id === orgId);
    expect(space?.tasks.some((t: { id: string }) => t.id === open.id) ?? false).toBe(false);
  });

  it('чужое закрытое дело в раздел не попадает', async () => {
    const { orgId, ownerId } = await makeOrg();
    const other = await addPerson(orgId, 'member');
    const tg = nextTg();
    await linkTelegram(ownerId, tg);
    await makeDoneTask(orgId, other, 'Чужое закрытое');

    const r = await agent(tg).get('/app/api/completed');
    const space = r.body.spaces.find((s: { org_id: string }) => s.org_id === orgId);
    expect(space).toBeUndefined();
  });

  it('дело закрытого проекта чужому не видно даже среди завершённых', async () => {
    const { orgId, ownerId } = await makeOrg();
    const other = await addPerson(orgId, 'admin');
    const tg = nextTg();
    await linkTelegram(other, tg);

    const project = await inOrg(orgId, (db) => createProject(db, { name: `Закрытый ${uniq()}`, private: true },
      { kind: 'user', userId: ownerId }), ownerId);
    const task = await inOrg(orgId, (db) => createTask(db, {
      ...base, title: 'В закрытом проекте', project: project.id, assigneeUserId: ownerId,
    }, { kind: 'user', userId: ownerId }), ownerId);
    await doneTask(orgId, task.id, ownerId);

    // Админ организации: даже он не видит закрытого проекта владельца — ни в списке, ни в завершённых.
    const r = await agent(tg).get('/app/api/completed');
    const space = r.body.spaces.find((s: { org_id: string }) => s.org_id === orgId);
    expect(space).toBeUndefined();
  });
});

describe('возврат дела в работу', () => {
  const post = (tgId: number, url: string) => request(app).post(url).set('X-Telegram-Init-Data', initDataFor(tgId));

  it('исполнитель возвращает своё закрытое дело, и оно снова в работе', async () => {
    const { orgId, ownerId } = await makeOrg();
    const tg = nextTg();
    await linkTelegram(ownerId, tg);
    const taskId = await makeDoneTask(orgId, ownerId, 'Закрыл по ошибке');

    const r = await post(tg, `/app/api/tasks/${taskId}/reopen`);
    expect(r.status).toBe(200);
    // Очередь могла сразу занять слот «Сейчас» — обе развязки правильные.
    expect(['ready', 'active']).toContain(r.body.status);

    // В базе дело уже могло уехать в «Сейчас»: слот занимает очередь, и так задумано — возврат
    // отдаёт дело очереди, а не восстанавливает прежнее положение.
    const status = await inOrg(orgId, async (db) => (await db.query('select status from tasks where id = $1', [taskId])).rows[0].status, ownerId);
    expect(['ready', 'active']).toContain(status);

    // И в разделе завершённых его больше нет.
    const list = await agent(tg).get('/app/api/completed');
    const space = list.body.spaces.find((s: { org_id: string }) => s.org_id === orgId);
    expect(space).toBeUndefined();
  });

  it('возврат виден агенту событием — иначе он считает дело сделанным', async () => {
    const { orgId, ownerId } = await makeOrg();
    const tg = nextTg();
    await linkTelegram(ownerId, tg);
    const taskId = await makeDoneTask(orgId, ownerId, 'Вернули');

    await post(tg, `/app/api/tasks/${taskId}/reopen`).expect(200);

    const events = await inOrg(orgId, async (db) => (await db.query(
      `select type from events where task_id = $1 order by id`, [taskId])).rows.map((x) => x.type), ownerId);
    expect(events).toContain('task_reopened');
  });

  it('незавершённое дело вернуть нельзя', async () => {
    const { orgId, ownerId } = await makeOrg();
    const tg = nextTg();
    await linkTelegram(ownerId, tg);
    const task = await inOrg(orgId, (db) => createTask(db, {
      ...base, title: 'Ещё в работе', assigneeUserId: ownerId,
    }, { kind: 'user', userId: ownerId }), ownerId);

    const r = await post(tg, `/app/api/tasks/${task.id}/reopen`);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('validation_failed');
  });

  it('чужое дело не возвращается', async () => {
    const { orgId, ownerId } = await makeOrg();
    const other = await addPerson(orgId, 'member');
    const tg = nextTg();
    await linkTelegram(other, tg);
    const taskId = await makeDoneTask(orgId, ownerId, 'Не его дело');

    const r = await post(tg, `/app/api/tasks/${taskId}/reopen`);
    expect(r.status).toBe(403);
    const status = await inOrg(orgId, async (db) => (await db.query('select status from tasks where id = $1', [taskId])).rows[0].status, ownerId);
    expect(status).toBe('done');
  });

  it('переход reopen есть только из done', async () => {
    const { orgId, ownerId } = await makeOrg();
    const task = await inOrg(orgId, (db) => createTask(db, {
      ...base, title: 'Свежее', assigneeUserId: ownerId,
    }, { kind: 'user', userId: ownerId }), ownerId);
    await expect(withOrg(orgId, (db) => transition(db, task.id, 'reopen', { kind: 'user', userId: ownerId }), { actorUserId: ownerId }))
      .rejects.toThrow(/not allowed/i);
  });
});

describe('границы возврата', () => {
  const post = (tgId: number, url: string) => request(app).post(url).set('X-Telegram-Init-Data', initDataFor(tgId));

  it('дело человека, выведенного из организации, не возвращается — иначе оно пропадёт у всех', async () => {
    const { orgId, ownerId } = await makeOrg();
    const leaving = await addPerson(orgId, 'member');
    const tg = nextTg();
    await linkTelegram(ownerId, tg);

    // Дело ставит владелец человеком, исполнитель — сотрудник; сотрудник его закрывает.
    const task = await inOrg(orgId, (db) => createTask(db, {
      ...base, title: 'Дело уходящего', assigneeUserId: leaving,
    }, { kind: 'user', userId: ownerId }), ownerId);
    await doneTask(orgId, task.id, leaving);
    await inOrg(orgId, (db) => offboardPerson(db, leaving, { kind: 'user', userId: ownerId }), ownerId);

    const r = await post(tg, `/app/api/tasks/${task.id}/reopen`);
    expect(r.status).toBe(409);
    const status = await inOrg(orgId, async (db) => (await db.query('select status from tasks where id = $1', [task.id])).rows[0].status, ownerId);
    expect(status).toBe('done');
  });

  it('постановщик-человек узнаёт, что его дело вернули в работу', async () => {
    const { orgId, ownerId } = await makeOrg();
    const worker = await addPerson(orgId, 'member');
    const tg = nextTg();
    await linkTelegram(worker, tg);

    const task = await inOrg(orgId, (db) => createTask(db, {
      ...base, title: 'Вернул исполнитель', assigneeUserId: worker,
    }, { kind: 'user', userId: ownerId }), ownerId);
    await doneTask(orgId, task.id, worker);

    await post(tg, `/app/api/tasks/${task.id}/reopen`).expect(200);

    const kinds = await inOrg(orgId, async (db) => (await db.query(
      `select kind from notifications where task_id = $1 and user_id = $2`, [task.id, ownerId])).rows.map((x) => x.kind), ownerId);
    expect(kinds).toContain('task_reopened');
  });

  it('к завершённому делу нельзя написать даже в обход приложения', async () => {
    const { orgId, ownerId } = await makeOrg();
    const tg = nextTg();
    await linkTelegram(ownerId, tg);
    const taskId = await makeDoneTask(orgId, ownerId, 'Закрытое');

    const r = await request(app).post(`/app/api/tasks/${taskId}/comment`)
      .set('X-Telegram-Init-Data', initDataFor(tg)).send({ text: 'ещё пара слов' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('validation_failed');

    const notes = await inOrg(orgId, async (db) => (await db.query(
      `select count(*)::int as n from task_messages where task_id = $1`, [taskId])).rows[0].n, ownerId);
    expect(notes).toBe(0);
  });
});

describe('число завершённых видно до раскрытия раздела', () => {
  it('основной список несёт счётчик по каждому пространству', async () => {
    const { orgId, ownerId } = await makeOrg();
    const tg = nextTg();
    await linkTelegram(ownerId, tg);

    const before = await agent(tg).get('/app/api/lists');
    const empty = before.body.spaces.find((s: { org_id: string }) => s.org_id === orgId);
    expect(empty.completed_count).toBe(0);

    await makeDoneTask(orgId, ownerId, 'Закрытое раз');
    await makeDoneTask(orgId, ownerId, 'Закрытое два');

    const after = await agent(tg).get('/app/api/lists');
    const space = after.body.spaces.find((s: { org_id: string }) => s.org_id === orgId);
    expect(space.completed_count).toBe(2);
  });

  it('счётчик считает только свои завершённые дела', async () => {
    const { orgId, ownerId } = await makeOrg();
    const other = await addPerson(orgId, 'member');
    const tg = nextTg();
    await linkTelegram(ownerId, tg);
    await makeDoneTask(orgId, other, 'Чужое закрытое');
    await makeDoneTask(orgId, ownerId, 'Моё закрытое');

    const r = await agent(tg).get('/app/api/lists');
    const space = r.body.spaces.find((s: { org_id: string }) => s.org_id === orgId);
    expect(space.completed_count).toBe(1);
  });
});
