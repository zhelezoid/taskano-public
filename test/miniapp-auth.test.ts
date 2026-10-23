import { createHmac, randomInt } from 'node:crypto';
import express from 'express';
import pg from 'pg';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { setLlmForTests } from '../src/ai/llm.js';
import request from 'supertest';
import { closePools, withGlobal } from '../src/db/pool.js';
import { env } from '../src/config/env.js';
import { miniappRoutes } from '../src/web/miniapp-api.js';
import { rateLimit } from '../src/web/rate-limit.js';
import { createTask } from '../src/core/tasks.js';
import { takeTask } from '../src/core/queue.js';
import { transition } from '../src/core/lifecycle.js';
import { addMember } from '../src/core/people.js';
import { addSource } from '../src/core/sources.js';
import { addComment } from '../src/mcp/tools/tasks.js';
import { COMMENT_MAX_LENGTH } from '../src/core/comments.js';
import { addPerson, inOrg, makeAgent, makeOrg, MON_10, minutes, uniq } from './helpers.js';
import { ensurePersonalOrg } from '../src/core/people.js';
import { setTaskShare } from '../src/core/sharing.js';
import { AppError } from '../src/core/errors.js';

// Личное дело заводит агент/Claude (в Mini App добавления нет) — в тестах создаём ядром.
async function addPersonalTask(userId: string, title: string, dueDate?: string): Promise<string> {
  const orgId = await withGlobal((db) => ensurePersonalOrg(db, userId));
  const t = await inOrg(orgId, (db) => createTask(db, { title, assigneeUserId: userId, dueDate: dueDate ?? null }, { kind: 'user', userId }));
  return t.id;
}

afterAll(closePools);

const BOT_TOKEN = 'test-bot-token-9999';

const app = express();
miniappRoutes(app, { botToken: BOT_TOKEN });

// Привязка Telegram — глобальная таблица, вставляем напрямую (нет отдельного core-хелпера).
async function linkTelegram(userId: string, telegramUserId: number): Promise<void> {
  await withGlobal((db) => db.query(
    `insert into telegram_links(telegram_user_id, user_id, chat_id) values ($1, $2, $1)`,
    [telegramUserId, userId],
  ));
}

let tgSeq = 900000000;
function nextTelegramId(): number {
  tgSeq += 1;
  return tgSeq;
}

/** Повторяет алгоритм подписи Telegram WebApp (независимо от src/web/miniapp-api.ts). */
function buildInitData(botToken: string, telegramUserId: number, authDate: Date, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(authDate.getTime() / 1000)),
    user: JSON.stringify({ id: telegramUserId, first_name: 'Test' }),
    ...extra,
  });
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

async function setupPerson(): Promise<{ orgId: string; ownerId: string; person: string; agent: string; telegramUserId: number; initData: string }> {
  const { orgId, ownerId } = await makeOrg();
  const person = await addPerson(orgId);
  const agent = await makeAgent(orgId, ownerId);
  const telegramUserId = nextTelegramId();
  await linkTelegram(person, telegramUserId);
  const initData = buildInitData(BOT_TOKEN, telegramUserId, new Date());
  return { orgId, ownerId, person, agent, telegramUserId, initData };
}

const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };

describe('Mini App: авторизация по initData', () => {
  it('подделанный initData → 401', async () => {
    await setupPerson();
    const forged = buildInitData('чужой-токен-бота', randomInt(1_000_000), new Date());
    const r = await request(app).get('/app/api/lists').set('X-Telegram-Init-Data', forged);
    expect(r.status).toBe(401);
  });

  it('просроченный auth_date (>24ч) → 401', async () => {
    const { telegramUserId } = await setupPerson();
    const stale = buildInitData(BOT_TOKEN, telegramUserId, new Date(Date.now() - 25 * 3600 * 1000));
    const r = await request(app).get('/app/api/lists').set('X-Telegram-Init-Data', stale);
    expect(r.status).toBe(401);
  });

  // Раньше срок годности считался по модулю разницы, и подпись «из будущего» жила те же сутки:
  // окно приёма было двое суток вместо одних. Часы устройства могут отстать или уйти вперёд на
  // минуты — на это оставлен небольшой допуск, но не на часы.
  it('подпись «из будущего» → 401, а суточной давности ещё принимается', async () => {
    const { telegramUserId } = await setupPerson();
    const future = buildInitData(BOT_TOKEN, telegramUserId, new Date(Date.now() + 2 * 3600 * 1000));
    expect((await request(app).get('/app/api/lists').set('X-Telegram-Init-Data', future)).status).toBe(401);

    const almostDay = buildInitData(BOT_TOKEN, telegramUserId, new Date(Date.now() - 23 * 3600 * 1000));
    expect((await request(app).get('/app/api/lists').set('X-Telegram-Init-Data', almostDay)).status).toBe(200);

    const smallSkew = buildInitData(BOT_TOKEN, telegramUserId, new Date(Date.now() + 60 * 1000));
    expect((await request(app).get('/app/api/lists').set('X-Telegram-Init-Data', smallSkew)).status).toBe(200);
  });

  // Мидлвар авторизации ходит в базу. Раньше его отказ не доходил до Express (`void … .then()`), а
  // необработанный отказ промиса гасит процесс целиком — вместе с `/mcp` и вебхуком бота.
  it('база отказала в мидлваре — ответ об ошибке, а не гибель процесса', async () => {
    const { initData } = await setupPerson();
    // Отбираем право у роли приложения: так же выглядит разрыв соединения или рестарт базы.
    const owner = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await owner.connect();
    await owner.query('revoke select on telegram_links from taskano_app');
    try {
      const r = await request(app).get('/app/api/lists').set('X-Telegram-Init-Data', initData);
      expect(r.status).toBe(500);
    } finally {
      await owner.query('grant select on telegram_links to taskano_app');
      await owner.end();
    }
    // Процесс жив: следующий запрос обслуживается как обычно.
    const ok = await request(app).get('/app/api/lists').set('X-Telegram-Init-Data', initData);
    expect(ok.status).toBe(200);
  });

  it('без заголовка → 401', async () => {
    const r = await request(app).get('/app/api/lists');
    expect(r.status).toBe(401);
  });

  it('telegram_user_id не привязан ни к кому → 401', async () => {
    const unlinked = buildInitData(BOT_TOKEN, nextTelegramId(), new Date());
    const r = await request(app).get('/app/api/lists').set('X-Telegram-Init-Data', unlinked);
    expect(r.status).toBe(401);
  });

  it('корректный initData → списки только своего пользователя', async () => {
    const me = await setupPerson();
    const stranger = await setupPerson();

    const active = await inOrg(me.orgId, (db) => createTask(
      db, { ...base, title: 'первая задача', assigneeUserId: me.person },
      { kind: 'agent', agentId: me.agent, userId: me.ownerId }, MON_10,
    ));
    const queued = await inOrg(me.orgId, (db) => createTask(
      db, { ...base, title: 'вторая задача', assigneeUserId: me.person },
      { kind: 'agent', agentId: me.agent, userId: me.ownerId }, MON_10,
    ));
    await inOrg(stranger.orgId, (db) => createTask(
      db, { ...base, title: 'чужая задача', assigneeUserId: stranger.person },
      { kind: 'agent', agentId: stranger.agent, userId: stranger.ownerId }, MON_10,
    ));

    const r = await request(app).get('/app/api/lists').set('X-Telegram-Init-Data', me.initData);
    expect(r.status).toBe(200);
    expect(r.body.lang).toBe('ru');

    const company = r.body.spaces.find((s: { kind: string }) => s.kind === 'company');
    expect(company.lists.now.map((t: { title?: string; id: string }) => t.id)).toContain(active.id);
    expect(company.lists.queue.map((t: { id: string }) => t.id)).toContain(queued.id);
    const allTitles = r.body.spaces.flatMap((s: { lists: Record<string, { title: string }[]> }) => Object.values(s.lists).flat()).map((t: { title: string }) => t.title);
    expect(allTitles).not.toContain('чужая задача');

    // Пустое личное пространство не показывается: после переезда на доски оно пустует, и вкладка
    // без единого дела только мешает (спека projects-stage2).
    const personal = r.body.spaces.find((s: { kind: string }) => s.kind === 'personal');
    expect(personal).toBeUndefined();
  });

  // Спека task-context: у задачи строка «Материалы: N» с раскрытием — список приходит с сервера.
  it('материалы дела приходят в карточке дела', async () => {
    const me = await setupPerson();
    const actor = { kind: 'agent' as const, agentId: me.agent, userId: me.ownerId };
    const task = await inOrg(me.orgId, (db) => createTask(db, { ...base, title: 'задача с материалами', assigneeUserId: me.person }, actor, MON_10));
    await inOrg(me.orgId, (db) => addSource(db, {
      taskId: task.id, kind: 'external', title: 'Linear EXT-7', url: 'https://linear.app/ext/issue/EXT-7',
      system: 'linear', externalId: `EXT-7-${task.short_id}`, snapshot: { status: 'In Progress' },
    }, actor, MON_10));

    const r = await request(app).get('/app/api/lists').set('X-Telegram-Init-Data', me.initData);
    const company = r.body.spaces.find((s: { kind: string }) => s.kind === 'company');
    const card = [...company.lists.now, ...company.lists.queue].find((t: { id: string }) => t.id === task.id);
    expect(card.sources).toHaveLength(1);
    expect(card.sources[0]).toMatchObject({ kind: 'external', title: 'Linear EXT-7', url: 'https://linear.app/ext/issue/EXT-7', status: 'In Progress' });
  });

  it('waiting_external, submitted и waiting (check_user или исполнитель) попадают в списки', async () => {
    const me = await setupPerson();
    const waitingExt = await inOrg(me.orgId, (db) => createTask(
      db, { ...base, title: 'ждём ответ', assigneeUserId: me.person },
      { kind: 'agent', agentId: me.agent, userId: me.ownerId }, MON_10,
    ));
    await inOrg(me.orgId, (db) => db.query(`update tasks set status = 'waiting_external' where id = $1`, [waitingExt.id]));

    const submitted = await inOrg(me.orgId, (db) => createTask(
      db, { ...base, title: 'на проверке', assigneeUserId: me.person },
      { kind: 'agent', agentId: me.agent, userId: me.ownerId }, MON_10,
    ));
    await inOrg(me.orgId, (db) => db.query(`update tasks set status = 'submitted' where id = $1`, [submitted.id]));

    const waitingAsAssignee = await inOrg(me.orgId, (db) => createTask(
      db, { title: 'жду сам', assigneeUserId: me.person, kind: 'waiting', why: 'зачем', waiting: { waitingFor: 'поставщик', nextCheckAt: '2026-12-01T00:00:00Z' } },
      { kind: 'agent', agentId: me.agent, userId: me.ownerId }, MON_10,
    ));
    const waitingAsChecker = await inOrg(me.orgId, (db) => createTask(
      db, { title: 'проверить за коллегу', assigneeUserId: me.ownerId, kind: 'waiting', why: 'зачем', waiting: { waitingFor: 'банк', nextCheckAt: '2026-12-02T00:00:00Z', checkUserId: me.person } },
      { kind: 'agent', agentId: me.agent, userId: me.ownerId }, MON_10,
    ));

    const r = await request(app).get('/app/api/lists').set('X-Telegram-Init-Data', me.initData);
    expect(r.status).toBe(200);
    const company = r.body.spaces.find((s: { kind: string }) => s.kind === 'company');
    expect(company.lists.waiting_external.map((t: { id: string }) => t.id)).toContain(waitingExt.id);
    expect(company.lists.submitted.map((t: { id: string }) => t.id)).toContain(submitted.id);
    const waitingIds = company.lists.waiting.map((t: { id: string }) => t.id);
    expect(waitingIds).toContain(waitingAsAssignee.id);
    expect(waitingIds).toContain(waitingAsChecker.id);
  });
});

describe('Mini App: карточка дела (спека miniapp-task-card)', () => {
  afterEach(() => setLlmForTests(undefined));

  it('записи по делу видны на карточке: написал — и запись на месте', async () => {
    const me = await setupPerson();
    const actor = { kind: 'agent' as const, agentId: me.agent, userId: me.ownerId };
    const task = await inOrg(me.orgId, (db) => createTask(db, {
      ...base, title: 'оплатить счёт', assigneeUserId: me.person, release: true,
    }, actor, MON_10));

    const empty = await request(app).get(`/app/api/tasks/${task.id}`).set('X-Telegram-Init-Data', me.initData);
    expect(empty.status).toBe(200);
    expect(empty.body.notes).toEqual([]);

    const sent = await request(app).post(`/app/api/tasks/${task.id}/comment`)
      .set('X-Telegram-Init-Data', me.initData).send({ text: 'оплачу в среду' });
    expect(sent.status).toBe(200);
    // Ответ агента ложится в ту же ленту: карточка показывает разговор, а не только свои реплики.
    await inOrg(me.orgId, (db) => addComment(db, task.id, actor, 'понял, подвинул срок'));

    const after = await request(app).get(`/app/api/tasks/${task.id}`).set('X-Telegram-Init-Data', me.initData);
    expect(after.body.notes).toHaveLength(2);
    // Новые сверху (решение владельца 30.09).
    expect(after.body.notes[0]).toMatchObject({ text: 'понял, подвинул срок', mine: false });
    expect(after.body.notes[1]).toMatchObject({ text: 'оплачу в среду', mine: true });
    expect(String(after.body.notes[0].author)).not.toBe('');
  });

  it('вопрос и ответ видны на карточке, с пометкой «ждёт ответа» до ответа', async () => {
    const me = await setupPerson();
    const actor = { kind: 'agent' as const, agentId: me.agent, userId: me.ownerId };
    const task = await inOrg(me.orgId, (db) => createTask(db, {
      ...base, title: 'проверить прайс', assigneeUserId: me.person, release: true,
    }, actor, MON_10));
    const person = { kind: 'user' as const, userId: me.person };
    const asked = await inOrg(me.orgId, (db) => transition(db, task.id, 'question', person, { now: minutes(MON_10, 5), text: 'прайс не тот?' }));

    const open = await request(app).get(`/app/api/tasks/${task.id}`).set('X-Telegram-Init-Data', me.initData);
    expect(open.body.notes).toHaveLength(1);
    expect(open.body.notes[0]).toMatchObject({ kind: 'question', answered: false, text: 'прайс не тот?', mine: true });

    await inOrg(me.orgId, (db) => transition(db, task.id, 'answer', actor, { now: minutes(MON_10, 10), text: 'тот, смотри лист 2', expectedVersion: asked.version }));
    const after = await request(app).get(`/app/api/tasks/${task.id}`).set('X-Telegram-Init-Data', me.initData);
    expect(after.body.notes.map((n: { kind: string }) => n.kind)).toEqual(['answer', 'question']);
    expect(after.body.notes[0]).toMatchObject({ text: 'тот, смотри лист 2', mine: false });
    expect(after.body.notes[1]).toMatchObject({ answered: true });
  });

  it('карточка не шире списка: отменённое и черновик не открываются, завершённое — открывается ради возврата', async () => {
    const me = await setupPerson();
    const actor = { kind: 'agent' as const, agentId: me.agent, userId: me.ownerId };
    const task = await inOrg(me.orgId, (db) => createTask(db, {
      ...base, title: 'закрытое дело', assigneeUserId: me.person, release: true,
    }, actor, MON_10));

    const open = await request(app).get(`/app/api/tasks/${task.id}`).set('X-Telegram-Init-Data', me.initData);
    expect(open.status).toBe(200);

    for (const status of ['cancelled', 'declined', 'resolved', 'draft']) {
      await inOrg(me.orgId, (db) => db.query('update tasks set status = $2 where id = $1', [task.id, status]));
      const r = await request(app).get(`/app/api/tasks/${task.id}`).set('X-Telegram-Init-Data', me.initData);
      expect(r.status, status).toBe(404);
    }

    // Завершённое — исключение (спека completed-list): его открывают из раздела «Завершённые»,
    // чтобы вернуть в работу. Живым оно при этом не выглядит: ни «Готово», ни поля реплики.
    await inOrg(me.orgId, (db) => db.query(`update tasks set status = 'done' where id = $1`, [task.id]));
    const done = await request(app).get(`/app/api/tasks/${task.id}`).set('X-Telegram-Init-Data', me.initData);
    expect(done.status).toBe(200);
    expect(done.body.task.status).toBe('done');
  });

  it('проверяющий ожидание открывает его карточку, закрытое — уже нет', async () => {
    const me = await setupPerson();
    const other = await addPerson(me.orgId);
    const actor = { kind: 'agent' as const, agentId: me.agent, userId: me.ownerId };
    const task = await inOrg(me.orgId, (db) => createTask(db, {
      ...base, kind: 'waiting', title: 'оплата от партнёра', assigneeUserId: other, dueDate: null,
      waiting: { waitingFor: 'партнёр', nextCheckAt: new Date(MON_10.getTime() + 86400000).toISOString() },
    }, actor, MON_10));
    await inOrg(me.orgId, (db) => db.query(
      `update tasks set waiting = waiting || jsonb_build_object('check_user_id', $2::text) where id = $1`,
      [task.id, me.person]));

    // Исполнитель — другой человек, но проверять поручено мне: в списке строка есть, карточка открывается.
    const r = await request(app).get(`/app/api/tasks/${task.id}`).set('X-Telegram-Init-Data', me.initData);
    expect(r.status).toBe(200);

    await inOrg(me.orgId, (db) => db.query(`update tasks set status = 'resolved' where id = $1`, [task.id]));
    const closed = await request(app).get(`/app/api/tasks/${task.id}`).set('X-Telegram-Init-Data', me.initData);
    expect(closed.status).toBe(404);
  });

  it('адрес не в форме идентификатора — 404, а не ошибка сервера', async () => {
    const me = await setupPerson();
    for (const id of ['не-идентификатор', '12345', '00000000-0000-0000-0000-000000000000']) {
      const r = await request(app).get(`/app/api/tasks/${encodeURIComponent(id)}`).set('X-Telegram-Init-Data', me.initData);
      expect(r.status, id).toBe(404);
    }
  });

  it('строки списка приходят без критерия: лишний перевод не оплачиваем', async () => {
    const me = await setupPerson();
    const actor = { kind: 'agent' as const, agentId: me.agent, userId: me.ownerId };
    await inOrg(me.orgId, (db) => createTask(db, {
      ...base, title: 'дело в очереди', assigneeUserId: me.person, release: true,
    }, actor, MON_10));

    const lists = await request(app).get('/app/api/lists').set('X-Telegram-Init-Data', me.initData);
    expect(lists.status).toBe(200);
    const all = JSON.stringify(lists.body);
    expect(all).toContain('дело в очереди');
    const company = lists.body.spaces.find((s: any) => s.kind === 'company');
    const rows = [...company.lists.now, ...company.lists.queue];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.done_criteria).toBeNull();
  });

  it('дело исполнителя приходит целиком: зачем, критерий, материалы с цитатой, фото', async () => {
    const me = await setupPerson();
    const actor = { kind: 'agent' as const, agentId: me.agent, userId: me.ownerId };
    const task = await inOrg(me.orgId, (db) => createTask(db, {
      title: 'закупить стеллажи', description: 'как делать: заказать стеллажи у поставщика и оплатить счёт',
      why: 'склад стоит без стеллажей', doneCriteria: 'счёт оплачен и отгрузка назначена',
      dueDate: '2026-12-31', assigneeUserId: me.person,
    }, actor, MON_10));
    await inOrg(me.orgId, (db) => addSource(db, {
      taskId: task.id, kind: 'external', title: 'Linear EXT-9', url: 'https://linear.app/ext/issue/EXT-9',
      system: 'linear', externalId: `EXT-9-${task.short_id}`, quote: 'Ахмет: стеллажи нужны до конца месяца',
      snapshot: { status: 'In Progress' },
    }, actor, MON_10));
    // Фото из рабочей группы: на карточке — число и кнопка «Показать в боте».
    await inOrg(me.orgId, (db) => db.query(
      `with m as (
         insert into media(org_id, sha256, path, expires_at)
         values (current_setting('app.org_id')::uuid, $2, 'x/y.jpg', now() + interval '30 days')
         returning id)
       insert into task_attachments(org_id, task_id, media_id, summary)
       select current_setting('app.org_id')::uuid, $1, m.id, 'накладная' from m`, [task.id, uniq()]));

    const r = await request(app).get(`/app/api/tasks/${task.id}`).set('X-Telegram-Init-Data', me.initData);
    expect(r.status).toBe(200);
    expect(r.body.task).toMatchObject({
      id: task.id,
      title: 'закупить стеллажи',
      why: 'склад стоит без стеллажей',
      done_criteria: 'счёт оплачен и отгрузка назначена',
      due_date: '2026-12-31',
      photos: 1,
      waiting_for: null,
      next_check_at: null,
      requires_result: false,
      bot_link: `https://t.me/${env.telegramBotUsername}?start=t_${task.short_id}`,
    });
    expect(r.body.task.sources).toHaveLength(1);
    expect(r.body.task.sources[0]).toMatchObject({
      kind: 'external', title: 'Linear EXT-9', url: 'https://linear.app/ext/issue/EXT-9',
      status: 'In Progress', quote: 'Ахмет: стеллажи нужны до конца месяца',
    });
  });

  it('чужое дело — 404: и из чужой организации, и своей организации, но не своё', async () => {
    const me = await setupPerson();
    const stranger = await setupPerson();
    const strangerTask = await inOrg(stranger.orgId, (db) => createTask(
      db, { ...base, title: 'чужая карточка', assigneeUserId: stranger.person },
      { kind: 'agent', agentId: stranger.agent, userId: stranger.ownerId }, MON_10,
    ));
    const foreign = await request(app).get(`/app/api/tasks/${strangerTask.id}`).set('X-Telegram-Init-Data', me.initData);
    expect(foreign.status).toBe(404);
    expect(foreign.body.task).toBeUndefined();

    // Дело соседа по организации приложение тоже не показывает: его канал — бот и коннектор.
    const neighbour = await inOrg(me.orgId, (db) => createTask(
      db, { ...base, title: 'дело владельца', assigneeUserId: me.ownerId },
      { kind: 'agent', agentId: me.agent, userId: me.ownerId }, MON_10,
    ));
    const notMine = await request(app).get(`/app/api/tasks/${neighbour.id}`).set('X-Telegram-Init-Data', me.initData);
    expect(notMine.status).toBe(404);
  });

  it('поля человека переводятся на его язык, как в списке', async () => {
    const me = await setupPerson();
    await withGlobal((db) => db.query(`update users set language = 'tr' where id = $1`, [me.person]));
    const dict: Record<string, string> = {
      'Закупить стеллажи': 'Rafları satın al',
      'склад стоит без стеллажей': 'depo rafsız duruyor',
      'счёт оплачен': 'fatura ödendi',
    };
    setLlmForTests(async ({ prompt }) => {
      const text = prompt.replace('<text>', '').replace('</text>', '');
      return { text: dict[text] ?? text, inputTokens: 1, outputTokens: 1 };
    });
    const task = await inOrg(me.orgId, (db) => createTask(db, {
      title: 'Закупить стеллажи', description: 'как делать: заказать стеллажи у поставщика и оплатить счёт',
      why: 'склад стоит без стеллажей', doneCriteria: 'счёт оплачен',
      dueDate: '2026-12-31', assigneeUserId: me.person, sourceLanguage: 'ru',
    }, { kind: 'agent', agentId: me.agent, userId: me.ownerId }, MON_10));

    const r = await request(app).get(`/app/api/tasks/${task.id}`).set('X-Telegram-Init-Data', me.initData);
    expect(r.status).toBe(200);
    expect(r.body.lang).toBe('tr');
    expect(r.body.task).toMatchObject({
      title: 'Rafları satın al', why: 'depo rafsız duruyor', done_criteria: 'fatura ödendi', is_translated: true,
    });
  });
});

describe('Mini App: «Готово»', () => {
  it('done на чужой задаче → 404', async () => {
    const me = await setupPerson();
    const stranger = await setupPerson();
    const strangerTask = await inOrg(stranger.orgId, (db) => createTask(
      db, { ...base, title: 'чужая', assigneeUserId: stranger.person },
      { kind: 'agent', agentId: stranger.agent, userId: stranger.ownerId }, MON_10,
    ));
    const r = await request(app).post(`/app/api/tasks/${strangerTask.id}/done`).set('X-Telegram-Init-Data', me.initData).send({ version: strangerTask.version });
    expect(r.status).toBe(404);
  });

  it('done с затребованным результатом сдаёт сразу, без отправки в бота', async () => {
    const me = await setupPerson();
    const task = await inOrg(me.orgId, (db) => createTask(
      db, { ...base, title: 'нужен результат', assigneeUserId: me.person, expectedResult: { type: 'text', required: false } },
      { kind: 'agent', agentId: me.agent, userId: me.ownerId }, MON_10,
    ));
    const r = await request(app).post(`/app/api/tasks/${task.id}/done`).set('X-Telegram-Init-Data', me.initData).send({ version: task.version });
    expect(r.status).toBe(200);
    const row = await inOrg(me.orgId, (db) => db.query('select status from tasks where id = $1', [task.id]));
    expect(row.rows[0].status).toBe('submitted');
  });

  it('done без обязательного результата закрывает задачу', async () => {
    const me = await setupPerson();
    const task = await inOrg(me.orgId, (db) => createTask(
      db, { ...base, title: 'простая задача', assigneeUserId: me.person },
      { kind: 'agent', agentId: me.agent, userId: me.ownerId }, MON_10,
    ));
    const r = await request(app).post(`/app/api/tasks/${task.id}/done`).set('X-Telegram-Init-Data', me.initData).send({ version: task.version });
    expect(r.status).toBe(200);
    const check = await inOrg(me.orgId, (db) => db.query('select status from tasks where id = $1', [task.id]));
    expect(check.rows[0].status).toBe('submitted');
  });
});

describe('Mini App: реплика к делу (спека task-comments)', () => {
  it('комментарий записывается и начинает неначатое дело; чужая задача → 404', async () => {
    const me = await setupPerson();
    const stranger = await setupPerson();
    const task = await inOrg(me.orgId, (db) => createTask(
      db, { ...base, title: 'закупка стеллажей', assigneeUserId: me.person },
      { kind: 'agent', agentId: me.agent, userId: me.ownerId }, MON_10,
    ));

    const r = await request(app).post(`/app/api/tasks/${task.id}/comment`)
      .set('X-Telegram-Init-Data', me.initData).send({ text: 'поставщик перенёс на четверг' });
    expect(r.status).toBe(200);

    const msgs = await inOrg(me.orgId, (db) => db.query(
      `select kind, text, author_user_id from task_messages where task_id = $1`, [task.id]));
    expect(msgs.rows).toHaveLength(1);
    expect(msgs.rows[0]).toMatchObject({ kind: 'comment', text: 'поставщик перенёс на четверг', author_user_id: me.person });
    // Первая реплика исполнителя к неначатому делу начинает его (спека auto-start).
    const after = await inOrg(me.orgId, (db) => db.query('select status, started_via from tasks where id = $1', [task.id]));
    expect(after.rows[0]).toEqual({ status: 'in_progress', started_via: 'comment' });

    // Пустой текст — ничего не записываем.
    const empty = await request(app).post(`/app/api/tasks/${task.id}/comment`)
      .set('X-Telegram-Init-Data', me.initData).send({ text: '   ' });
    expect(empty.status).toBe(400);

    // Чужая задача — 404, о её существовании приложение не узнаёт.
    const foreign = await request(app).post(`/app/api/tasks/${task.id}/comment`)
      .set('X-Telegram-Init-Data', stranger.initData).send({ text: 'а я мимо проходил' });
    expect(foreign.status).toBe(404);
    const still = await inOrg(me.orgId, (db) => db.query('select count(*)::int as n from task_messages where task_id = $1', [task.id]));
    expect(still.rows[0].n).toBe(1);
  });

  it('реплика длиннее предела → 400, в базу не попадает', async () => {
    const me = await setupPerson();
    const task = await inOrg(me.orgId, (db) => createTask(
      db, { ...base, title: 'простыня', assigneeUserId: me.person },
      { kind: 'agent', agentId: me.agent, userId: me.ownerId }, MON_10,
    ));
    const r = await request(app).post(`/app/api/tasks/${task.id}/comment`)
      .set('X-Telegram-Init-Data', me.initData).send({ text: 'x'.repeat(COMMENT_MAX_LENGTH + 1) });
    expect(r.status).toBe(400);
    const n = await inOrg(me.orgId, (db) => db.query('select count(*)::int as n from task_messages where task_id = $1', [task.id]));
    expect(n.rows[0].n).toBe(0);
  });

  it('приглашённый, ещё не принявший приглашение, в дело не пишет', async () => {
    const me = await setupPerson();
    const task = await inOrg(me.orgId, (db) => createTask(
      db, { ...base, title: 'дело для новичка', assigneeUserId: me.person },
      { kind: 'agent', agentId: me.agent, userId: me.ownerId }, MON_10,
    ));
    await withGlobal((db) => db.query(
      `update memberships set status = 'invited' where org_id = $1 and user_id = $2`, [me.orgId, me.person]));

    // Приглашение, которое человек не принял, — ещё не работа: дел этой компании он не видит ни в
    // списках, ни поштучно (спека multi-company). Поэтому 404, а не 403: отказ «вижу, но
    // нельзя» обещал бы, что дело для него уже существует.
    const r = await request(app).post(`/app/api/tasks/${task.id}/comment`)
      .set('X-Telegram-Init-Data', me.initData).send({ text: 'я ещё не вошёл, но пишу' });
    expect(r.status).toBe(404);
    const n = await inOrg(me.orgId, (db) => db.query('select count(*)::int as n from task_messages where task_id = $1', [task.id]));
    expect(n.rows[0].n).toBe(0);
  });

  it('21-я реплика к задаче за сутки → limit_exceeded', async () => {
    const me = await setupPerson();
    const task = await inOrg(me.orgId, (db) => createTask(
      db, { ...base, title: 'много слов', assigneeUserId: me.person },
      { kind: 'agent', agentId: me.agent, userId: me.ownerId }, MON_10,
    ));
    for (let i = 0; i < 20; i++) {
      const ok = await request(app).post(`/app/api/tasks/${task.id}/comment`)
        .set('X-Telegram-Init-Data', me.initData).send({ text: `реплика ${i}` });
      expect(ok.status).toBe(200);
    }
    const over = await request(app).post(`/app/api/tasks/${task.id}/comment`)
      .set('X-Telegram-Init-Data', me.initData).send({ text: 'двадцать первая' });
    expect(over.body.code).toBe('limit_exceeded');
    const n = await inOrg(me.orgId, (db) => db.query('select count(*)::int as n from task_messages where task_id = $1', [task.id]));
    expect(n.rows[0].n).toBe(20);
  });
});

describe('Mini App: личное пространство', () => {
  it('добавления нет; перестановка порядка и удаление работают', async () => {
    const me = await setupPerson();

    const add = await request(app).post('/app/api/personal').set('X-Telegram-Init-Data', me.initData).send({ title: 'купить хлеб' });
    expect(add.status).toBe(404); // задачи ставит только агент (решение владельца 2026-09-19)

    const t1 = await addPersonalTask(me.person, 'купить хлеб', '2027-01-01');
    const t2 = await addPersonalTask(me.person, 'позвонить маме', '2027-01-01');

    const reorder = await request(app).post('/app/api/personal/reorder').set('X-Telegram-Init-Data', me.initData).send({ ids: [t2, t1] });
    expect(reorder.status).toBe(200);

    const afterReorder = await request(app).get('/app/api/lists').set('X-Telegram-Init-Data', me.initData);
    const personal = afterReorder.body.spaces.find((s: { kind: string }) => s.kind === 'personal');
    const sameDay = personal.lists.open.filter((t: { due_date: string }) => t.due_date === '2027-01-01').map((t: { id: string }) => t.id);
    expect(sameDay).toEqual([t2, t1]);

    const del = await request(app).delete(`/app/api/personal/${t1}`).set('X-Telegram-Init-Data', me.initData);
    expect(del.status).toBe(200);
    const afterDelete = await request(app).get('/app/api/lists').set('X-Telegram-Init-Data', me.initData);
    const personalAfter = afterDelete.body.spaces.find((s: { kind: string }) => s.kind === 'personal');
    expect(personalAfter.lists.open.map((t: { id: string }) => t.id)).not.toContain(t1);
  });

  it('чужое личное дело нельзя удалить — 404', async () => {
    const me = await setupPerson();
    const other = await setupPerson();
    const otherTaskId = await addPersonalTask(other.person, 'чужое личное');
    const del = await request(app).delete(`/app/api/personal/${otherTaskId}`).set('X-Telegram-Init-Data', me.initData);
    expect(del.status).toBe(404);
  });
});

describe('Mini App: перевод', () => {
  afterEach(() => setLlmForTests(undefined));

  it('название задачи — на языке человека, с пометкой «переведено»', async () => {
    const me = await setupPerson();
    await withGlobal((db) => db.query(`update users set language = 'tr' where id = $1`, [me.person]));
    setLlmForTests(async () => ({ text: 'Hepsiburada’daki dört kopya ilan hakkında karar ver', inputTokens: 5, outputTokens: 5 }));
    await inOrg(me.orgId, (db) => createTask(db, {
      ...base, title: 'Реши по четырём дублям на Hepsiburada', assigneeUserId: me.person, sourceLanguage: 'ru',
    }, { kind: 'agent', agentId: me.agent, userId: me.ownerId }, MON_10));

    const r = await request(app).get('/app/api/lists').set('X-Telegram-Init-Data', me.initData);
    const company = r.body.spaces.find((s: { kind: string }) => s.kind === 'company');
    const card = company.lists.now[0];
    expect(card.title).toBe('Hepsiburada’daki dört kopya ilan hakkında karar ver');
    expect(card.is_translated).toBe(true);
    expect(card.bot_link).toMatch(/\?start=t_\d+$/);
  });
});

describe('Mini App: виды личных дел и «важно»', () => {
  it('личное без даты остаётся без даты; вид и звёздочка приходят в список; ожидание закрывается «Готово»', async () => {
    const me = await setupPerson();
    const orgId = await withGlobal((db) => ensurePersonalOrg(db, me.person));
    const actor = { kind: 'user' as const, userId: me.person };
    const decide = await inOrg(orgId, (db) => createTask(db, { title: 'Вьетнам или Бразилия', assigneeUserId: me.person, category: 'decide' }, actor));
    expect(decide.due_date).toBeNull();
    const wait = await inOrg(orgId, (db) => createTask(db, {
      kind: 'waiting', title: 'Кредитный лимит', assigneeUserId: me.person, waiting: { waitingFor: 'два действия Ахмет' },
    }, actor));

    const star = await request(app).post(`/app/api/personal/${decide.id}/important`).set('X-Telegram-Init-Data', me.initData).send({ important: true });
    expect(star.status).toBe(200);

    const r = await request(app).get('/app/api/lists').set('X-Telegram-Init-Data', me.initData);
    const open = r.body.spaces.find((s: { kind: string }) => s.kind === 'personal').lists.open as Array<Record<string, unknown>>;
    const d = open.find((x) => x.id === decide.id)!;
    expect(d).toMatchObject({ category: 'decide', important: true, due_date: null });
    const w = open.find((x) => x.id === wait.id)!;
    expect(w.waiting_for).toBe('два действия Ахмет');
    expect(w.next_check_at).toBeTruthy();

    const done = await request(app).post(`/app/api/tasks/${wait.id}/done`).set('X-Telegram-Init-Data', me.initData).send({ version: w.version });
    expect(done.status).toBe(200);
    const after = await inOrg(orgId, (db) => db.query('select status from tasks where id = $1', [wait.id]));
    expect(after.rows[0].status).toBe('resolved');

    // Чужую звёздочку не поставить.
    const other = await setupPerson();
    const foreign = await request(app).post(`/app/api/personal/${decide.id}/important`).set('X-Telegram-Init-Data', other.initData).send({ important: false });
    expect(foreign.status).toBe(404);
  });

  // Спека owner-feedback: у помеченного «рабочее» дела видно название компании, пометку тут же снимают.
  it('пометка «рабочее»: название компании в карточке, снятие — из приложения', async () => {
    const me = await setupPerson();
    const personalOrg = await withGlobal((db) => ensurePersonalOrg(db, me.person));
    const actor = { kind: 'user' as const, userId: me.person };
    const t = await inOrg(personalOrg, (db) => createTask(db, { title: 'Заказать стеллажи', assigneeUserId: me.person }, actor));
    await inOrg(personalOrg, (db) => setTaskShare(db, t.id, me.person, me.orgId));
    const orgName = (await inOrg(me.orgId, (db) => db.query('select name from orgs where id = $1', [me.orgId]))).rows[0].name;

    const r = await request(app).get('/app/api/lists').set('X-Telegram-Init-Data', me.initData);
    const open = r.body.spaces.find((s: { kind: string }) => s.kind === 'personal').lists.open as Array<Record<string, unknown>>;
    expect(open.find((x) => x.id === t.id)!.shared_with).toEqual({ org_id: me.orgId, name: orgName });

    const off = await request(app).post(`/app/api/personal/${t.id}/share`).set('X-Telegram-Init-Data', me.initData).send({ org_id: null });
    expect(off.status).toBe(200);
    const after = await inOrg(personalOrg, (db) => db.query('select shared_org_id from tasks where id = $1', [t.id]));
    expect(after.rows[0].shared_org_id).toBeNull();

    // Чужое личное дело пометкой не тронуть.
    const other = await setupPerson();
    const foreign = await request(app).post(`/app/api/personal/${t.id}/share`).set('X-Telegram-Init-Data', other.initData).send({ org_id: other.orgId });
    expect(foreign.status).toBe(404);
  });

  it('category в задаче организации — ошибка', async () => {
    const me = await setupPerson();
    await expect(inOrg(me.orgId, (db) => createTask(db, { ...base, title: 'x', assigneeUserId: me.person, category: 'decide' },
      { kind: 'user', userId: me.ownerId }, MON_10))).rejects.toBeInstanceOf(AppError);
  });
});

// Владелец смотрит «Компания» → человек → его дела и нажимает на дело. Карточка отвечала 404, а
// приложение на 404 закрывает карточку и возвращает в собственный список — со стороны это выглядело
// так, будто нажатие промахнулось мимо дела.
describe('Mini App: карточка чужого дела (только чтение)', () => {
  it('владелец открывает дело своего человека и видит карточку без кнопок', async () => {
    const me = await setupPerson();
    const ownerTg = nextTelegramId();
    await linkTelegram(me.ownerId, ownerTg);
    const ownerInit = buildInitData(BOT_TOKEN, ownerTg, new Date());
    const task = await inOrg(me.orgId, (db) => createTask(
      db, { ...base, title: 'свериться с поставщиком', assigneeUserId: me.person },
      { kind: 'agent', agentId: me.agent, userId: me.ownerId }, MON_10));

    const r = await request(app).get(`/app/api/tasks/${task.id}`).set('X-Telegram-Init-Data', ownerInit);

    expect(r.status).toBe(200);
    expect(r.body.task.title).toBe('свериться с поставщиком');
    // Смотреть — не распоряжаться: чужое дело за человека не закрывают.
    expect(r.body.actions).toEqual([]);
  });

  it('посторонний из другой компании в чужое дело не попадает', async () => {
    const me = await setupPerson();
    const stranger = await setupPerson();
    const task = await inOrg(me.orgId, (db) => createTask(
      db, { ...base, title: 'чужое дело', assigneeUserId: me.person },
      { kind: 'agent', agentId: me.agent, userId: me.ownerId }, MON_10));

    const r = await request(app).get(`/app/api/tasks/${task.id}`).set('X-Telegram-Init-Data', stranger.initData);

    expect(r.status).toBe(404);
  });

  it('рядовой участник чужое дело не открывает — роль у него не та', async () => {
    const me = await setupPerson();
    const colleague = await addPerson(me.orgId);
    const colleagueTg = nextTelegramId();
    await linkTelegram(colleague, colleagueTg);
    const colleagueInit = buildInitData(BOT_TOKEN, colleagueTg, new Date());
    const task = await inOrg(me.orgId, (db) => createTask(
      db, { ...base, title: 'дело соседа', assigneeUserId: me.person },
      { kind: 'agent', agentId: me.agent, userId: me.ownerId }, MON_10));

    const r = await request(app).get(`/app/api/tasks/${task.id}`).set('X-Telegram-Init-Data', colleagueInit);

    expect(r.status).toBe(404);
  });
});

// «Взял» ничем не отзывалось: человек нажимал кнопку и дальше не видел ни что он взял, ни сколько с
// этим сидит, — а слот тем временем занят, и очередь других компаний стоит (спека mini-app).
describe('Mini App: что сейчас в работе', () => {
  it('взятое дело приходит в /lists с минутой начала', async () => {
    const me = await setupPerson();
    const task = await inOrg(me.orgId, (db) => createTask(
      db, { ...base, title: 'сверить остатки', assigneeUserId: me.person },
      { kind: 'agent', agentId: me.agent, userId: me.ownerId }, MON_10));

    const before = await request(app).get('/app/api/lists').set('X-Telegram-Init-Data', me.initData);
    expect(before.body.in_progress).toBeNull();

    await inOrg(me.orgId, (db) => takeTask(db, task.id, { kind: 'user', userId: me.person }, { now: MON_10 }));
    const after = await request(app).get('/app/api/lists').set('X-Telegram-Init-Data', me.initData);

    expect(after.body.in_progress).toMatchObject({ task_id: task.id, title: 'сверить остатки' });
    expect(new Date(after.body.in_progress.started_at).getTime()).toBe(MON_10.getTime());
    // Компания одна — называть её незачем (спека multi-company).
    expect(after.body.in_progress.company).toBeNull();
  });

  it('дело взято в другой компании — шапка всё равно его показывает, с названием компании', async () => {
    const me = await setupPerson();
    const other = await makeOrg();
    await withGlobal((db) => addMember(db, other.orgId, me.person, 'member'));
    await withGlobal((db) => db.query('update orgs set name = $2 where id = $1', [other.orgId, 'Апельсин']));
    const otherAgent = await makeAgent(other.orgId, other.ownerId);
    const task = await inOrg(other.orgId, (db) => createTask(
      db, { ...base, title: 'дело второй компании', assigneeUserId: me.person },
      { kind: 'agent', agentId: otherAgent, userId: other.ownerId }, MON_10));
    await inOrg(other.orgId, (db) => takeTask(db, task.id, { kind: 'user', userId: me.person }, { now: MON_10 }));

    const r = await request(app).get('/app/api/lists').set('X-Telegram-Init-Data', me.initData);

    // Иначе шапка пуста, а очередь этой компании стоит — и человек не понимает почему.
    expect(r.body.in_progress).toMatchObject({ task_id: task.id, company: 'Апельсин' });
  });

  it('дело сдано — шапка гаснет', async () => {
    const me = await setupPerson();
    const task = await inOrg(me.orgId, (db) => createTask(
      db, { ...base, title: 'сверить остатки', assigneeUserId: me.person },
      { kind: 'agent', agentId: me.agent, userId: me.ownerId }, MON_10));
    await inOrg(me.orgId, (db) => takeTask(db, task.id, { kind: 'user', userId: me.person }, { now: MON_10 }));
    await inOrg(me.orgId, (db) => transition(db, task.id, 'submit', { kind: 'user', userId: me.person }, { now: MON_10 }));

    const r = await request(app).get('/app/api/lists').set('X-Telegram-Init-Data', me.initData);

    expect(r.body.in_progress).toBeNull();
  });
});

// Ограничитель частоты (спека mini-app). Такт «взял — остановил» поднимает версию дела, а значит
// пробивает дедуп уведомлений: без потолка пятнадцать тактов давали шестнадцать сообщений в
// Telegram и полсотни событий в ленте, которую вычитывает агент. Ключ — человек, а не адрес: за
// клиентами Telegram один выход в сеть, и по адресу мы резали бы всех сразу.
describe('ограничитель частоты', () => {
  const call = (handler: ReturnType<typeof rateLimit>, userId: string): number => {
    const req = { miniappUser: { userId }, ip: '10.0.0.1' } as never;
    let status = 200;
    const res = { status(c: number) { status = c; return this; }, set() { return this; }, send() { return this; } } as never;
    handler(req, res, () => {});
    return status;
  };

  // Проверка подписи считает HMAC и ходит в базу за привязкой. Пока потолок стоял только после
  // неё, поток неподписанных запросов проходил мимо ограничителя целиком — ровно та нагрузка на
  // базу, из-за которой раньше падал процесс.
  it('поток без подписи упирается в потолок, а не считается бесконечно', async () => {
    const fresh = express();
    miniappRoutes(fresh, { botToken: BOT_TOKEN });
    let seen401 = 0;
    let seen429 = 0;
    for (let i = 0; i < 700; i++) {
      const r = await request(fresh).get('/app/api/lists');
      if (r.status === 401) seen401++;
      if (r.status === 429) { seen429++; break; }
    }
    expect(seen401).toBeGreaterThan(0);
    expect(seen429).toBe(1);
  }, 60_000);

  it('свой счёт у каждого человека, чужая торопливость не мешает', () => {
    const limit = rateLimit({ windowMs: 60_000, max: 2, key: (req) => req.miniappUser?.userId ?? 'ip' });
    expect(call(limit, 'человек-1')).toBe(200);
    expect(call(limit, 'человек-1')).toBe(200);
    expect(call(limit, 'человек-1')).toBe(429);
    // Второму человеку счёт не испорчен, хотя адрес у них один.
    expect(call(limit, 'человек-2')).toBe(200);
  });
});
