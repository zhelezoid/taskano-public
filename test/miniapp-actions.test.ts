import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { setLlmForTests } from '../src/ai/llm.js';
import './helpers.js';
import { closePools, withGlobal } from '../src/db/pool.js';
import { miniappRoutes } from '../src/web/miniapp-api.js';
import { createTask } from '../src/core/tasks.js';
import { startTimer } from '../src/core/time.js';
import { transition } from '../src/core/lifecycle.js';
import { ensurePersonalOrg } from '../src/core/people.js';
import { loadUserSchedule, localParts } from '../src/core/calendar.js';
import { createProject } from '../src/core/projects.js';
import { addPerson, inOrg, makeOrg, uniq } from './helpers.js';

// Действия по делу в приложении (спека miniapp-task-actions): «Взял», «Перенести», «Вопрос»,
// «Непонятно», «Отказаться». Проверяем через те же ручки, что зовёт приложение, а результат —
// фактом в базе: статусом дела и записями по нему.

afterAll(closePools);

const BOT_TOKEN = 'test-bot-token-actions';
const app = express();
miniappRoutes(app, { botToken: BOT_TOKEN });
const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };

let tgSeq = 870000000;
const nextTg = (): number => (tgSeq += 1);

/** Подпись Telegram WebApp — как в test/completed-list.test.ts. */
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

const post = (tgId: number, url: string) => request(app).post(url).set('X-Telegram-Init-Data', initDataFor(tgId));
const get = (tgId: number, url: string) => request(app).get(url).set('X-Telegram-Init-Data', initDataFor(tgId));

interface Scene {
  orgId: string;
  ownerId: string;
  person: string;
  tg: number;
}

/** Дело компании у исполнителя, привязанного к Telegram: ровно то, что показывает приложение. */
async function scene(): Promise<Scene> {
  const { orgId, ownerId } = await makeOrg();
  const person = await addPerson(orgId, 'member');
  const tg = nextTg();
  await linkTelegram(person, tg);
  return { orgId, ownerId, person, tg };
}

async function makeTask(s: Scene, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const task = await inOrg(s.orgId, (db) => createTask(db, {
    ...base, ...extra, title, assigneeUserId: s.person,
  }, { kind: 'user', userId: s.ownerId }), s.ownerId);
  return task.id;
}

async function taskRow(s: Scene, taskId: string): Promise<{ status: string; due_date: string | null; activate_at: Date | null }> {
  return inOrg(s.orgId, async (db) => (await db.query(
    'select status, due_date, activate_at from tasks where id = $1', [taskId])).rows[0], s.ownerId);
}

async function statusOf(s: Scene, taskId: string): Promise<string> {
  return (await taskRow(s, taskId)).status;
}

/** Записи ядра по делу: вопрос, «непонятно» и причина отказа ложатся в `task_messages`. */
async function messages(s: Scene, taskId: string): Promise<{ kind: string; text: string }[]> {
  return inOrg(s.orgId, async (db) => (await db.query(
    'select kind, text from task_messages where task_id = $1 order by created_at, id', [taskId])).rows, s.ownerId);
}

describe('«Взял» из приложения', () => {
  it('переводит дело в работу', async () => {
    const s = await scene();
    const taskId = await makeTask(s, 'Взять в работу');

    const r = await post(s.tg, `/app/api/tasks/${taskId}/take`).send({});
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(await statusOf(s, taskId)).toBe('in_progress');
  });

  it('из статуса, где переход запрещён, отвечает отказом и дела не двигает', async () => {
    const s = await scene();
    const taskId = await makeTask(s, 'Уже сдано');
    await inOrg(s.orgId, (db) => transition(db, taskId, 'submit', { kind: 'user', userId: s.person }), s.person);

    const r = await post(s.tg, `/app/api/tasks/${taskId}/take`).send({});
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.code).toBe('invalid_transition');
    expect(await statusOf(s, taskId)).toBe('submitted');
  });
});

describe('перенос дела', () => {
  it('сдвигает срок и отдаёт новую дату', async () => {
    const s = await scene();
    const taskId = await makeTask(s, 'Перенести на завтра');

    const r = await post(s.tg, `/app/api/tasks/${taskId}/postpone`).send({ to: 'tomorrow' });
    expect(r.status).toBe(200);
    const row = await taskRow(s, taskId);
    expect(row.due_date).toBe(r.body.due_date);
    expect(row.due_date).not.toBe(base.dueDate);
  });

  it('«через неделю» строго дальше, чем «завтра»', async () => {
    const s = await scene();
    const soon = await makeTask(s, 'Завтра');
    const later = await makeTask(s, 'Через неделю');

    const a = await post(s.tg, `/app/api/tasks/${soon}/postpone`).send({ to: 'tomorrow' });
    const b = await post(s.tg, `/app/api/tasks/${later}/postpone`).send({ to: 'week' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.due_date > a.body.due_date).toBe(true);

    // И «послезавтра» лежит ровно между ними.
    const mid = await makeTask(s, 'Послезавтра');
    const c = await post(s.tg, `/app/api/tasks/${mid}/postpone`).send({ to: 'day_after' });
    expect(c.body.due_date > a.body.due_date).toBe(true);
    expect(c.body.due_date < b.body.due_date).toBe(true);
  });

  it('дело просыпается в рабочее время человека, а не в выходной', async () => {
    const s = await scene();
    const taskId = await makeTask(s, 'Перенос через выходные');

    await post(s.tg, `/app/api/tasks/${taskId}/postpone`).send({ to: 'week' }).expect(200);

    const row = await taskRow(s, taskId);
    expect(row.activate_at).not.toBeNull();
    const schedule = await withGlobal((db) => loadUserSchedule(db, s.person));
    const at = localParts(new Date(row.activate_at!), schedule.tz);
    // Тестовый график — пн–пт 09:00–18:00, Стамбул: перенос попадает на рабочий день, к началу дня.
    expect(schedule.days).toContain(at.weekday);
    expect(`${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}`).toBe(schedule.start);
  });

  // Перенесённое дело пропадало из списка до утра своего дня (Мария, 12.10).
  it('перенесённое дело видно в «Отложено», а не исчезает из списка', async () => {
    const s = await scene();
    const taskId = await makeTask(s, 'Перенести и не потерять');

    await post(s.tg, `/app/api/tasks/${taskId}/postpone`).send({ to: 'tomorrow' }).expect(200);

    const lists = await get(s.tg, '/app/api/lists');
    const company = lists.body.spaces.find((sp: { kind: string; org_id: string }) => sp.kind === 'company' && sp.org_id === s.orgId);
    const ids = (k: string): string[] => company.lists[k].map((t: { id: string }) => t.id);
    expect(ids('scheduled')).toContain(taskId);
    expect(ids('queue')).not.toContain(taskId);
  });

  it('неизвестная дата переноса не проходит', async () => {
    const s = await scene();
    const taskId = await makeTask(s, 'Куда переносим');

    const r = await post(s.tg, `/app/api/tasks/${taskId}/postpone`).send({ to: 'someday' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('validation_failed');
    expect((await taskRow(s, taskId)).due_date).toBe(base.dueDate);
  });
});

describe('вопрос, «непонятно» и отказ', () => {
  it('вопрос блокирует дело и сохраняет текст', async () => {
    const s = await scene();
    const taskId = await makeTask(s, 'Есть вопрос');
    await post(s.tg, `/app/api/tasks/${taskId}/take`).send({}).expect(200);

    const r = await post(s.tg, `/app/api/tasks/${taskId}/question`).send({ text: 'С кем согласовать?', kind: 'question' });
    expect(r.status).toBe(200);
    expect(await statusOf(s, taskId)).toBe('blocked');
    expect(await messages(s, taskId)).toContainEqual({ kind: 'question', text: 'С кем согласовать?' });
  });

  it('«непонятно» блокирует дело своей записью', async () => {
    const s = await scene();
    const taskId = await makeTask(s, 'Непонятная формулировка');
    await post(s.tg, `/app/api/tasks/${taskId}/take`).send({}).expect(200);

    const r = await post(s.tg, `/app/api/tasks/${taskId}/question`).send({ text: 'Не понял, что именно сделать', kind: 'unclear' });
    expect(r.status).toBe(200);
    expect(await statusOf(s, taskId)).toBe('blocked');
    expect(await messages(s, taskId)).toContainEqual({ kind: 'unclear', text: 'Не понял, что именно сделать' });
  });

  it('пустой текст не уходит ни вопросом, ни «непонятно», ни отказом', async () => {
    const s = await scene();
    const taskId = await makeTask(s, 'Без текста');
    await post(s.tg, `/app/api/tasks/${taskId}/take`).send({}).expect(200);

    for (const body of [{ text: '   ', kind: 'question' }, { text: '', kind: 'unclear' }]) {
      const r = await post(s.tg, `/app/api/tasks/${taskId}/question`).send(body);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('validation_failed');
    }
    const decline = await post(s.tg, `/app/api/tasks/${taskId}/decline`).send({ text: '  ' });
    expect(decline.status).toBe(400);
    expect(decline.body.code).toBe('validation_failed');

    expect(await statusOf(s, taskId)).toBe('in_progress');
    expect(await messages(s, taskId)).toEqual([]);
  });

  it('вид записи обязателен: ни вопрос, ни «непонятно» — не проходит', async () => {
    const s = await scene();
    const taskId = await makeTask(s, 'Без вида');

    const r = await post(s.tg, `/app/api/tasks/${taskId}/question`).send({ text: 'что-то' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('validation_failed');
  });

  it('отказ с причиной закрывает дело', async () => {
    const s = await scene();
    const taskId = await makeTask(s, 'Не моё дело');

    const r = await post(s.tg, `/app/api/tasks/${taskId}/decline`).send({ text: 'Это к другому отделу' });
    expect(r.status).toBe(200);
    expect(await statusOf(s, taskId)).toBe('declined');
    expect(await messages(s, taskId)).toContainEqual({ kind: 'decline_reason', text: 'Это к другому отделу' });
  });
});

describe('чужое дело', () => {
  it('не двигается ни одной из ручек', async () => {
    const s = await scene();
    const stranger = await addPerson(s.orgId, 'member');
    const strangerTg = nextTg();
    await linkTelegram(stranger, strangerTg);
    const taskId = await makeTask(s, 'Дело коллеги');

    const calls: [string, Record<string, unknown>][] = [
      ['take', {}],
      ['postpone', { to: 'tomorrow' }],
      ['question', { text: 'а что тут?', kind: 'question' }],
      ['decline', { text: 'не берусь' }],
    ];
    for (const [action, body] of calls) {
      const r = await post(strangerTg, `/app/api/tasks/${taskId}/${action}`).send(body);
      expect(r.status, action).toBe(404);
    }
    const row = await taskRow(s, taskId);
    expect(['ready', 'active']).toContain(row.status);
    expect(row.due_date).toBe(base.dueDate);
  });
});

describe('набор действий в карточке', () => {
  it('у дела в очереди есть все шесть кнопок', async () => {
    const s = await scene();
    const taskId = await makeTask(s, 'Всё можно');

    const r = await get(s.tg, `/app/api/tasks/${taskId}`);
    expect(r.status).toBe(200);
    // Дело могло сразу уехать в «Сейчас» (очередь заняла слот) — набор действий у `ready` и `active` один.
    expect(['ready', 'active']).toContain(r.body.task.status);
    // «Остановить» у невзятого дела не предлагается: останавливать нечего.
    expect(r.body.actions).toEqual(['take', 'done', 'postpone', 'question', 'unclear', 'decline']);
  });

  // Пара к «Взял»: человек сел не за то или его отвлекли. Дело возвращается в очередь, таймер
  // встаёт — иначе слот занят, а работы нет (спека mini-app).
  it('«Остановить» возвращает взятое дело в очередь и останавливает таймер учёта', async () => {
    const s = await scene();
    const taskId = await makeTask(s, 'Взял и остановился');
    await post(s.tg, `/app/api/tasks/${taskId}/take`).send({}).expect(200);
    await inOrg(s.orgId, (db) => startTimer(db, s.person, taskId), s.person);
    expect(await statusOf(s, taskId)).toBe('in_progress');

    const stop = await post(s.tg, `/app/api/tasks/${taskId}/stop`).send({});

    expect(stop.status).toBe(200);
    // Очередь может тут же предложить его снова — но уже не взятым.
    expect(['ready', 'active']).toContain(await statusOf(s, taskId));
    const open = await inOrg(s.orgId, (db) => db.query(
      `select count(*)::int as n from time_entries where task_id = $1 and ended_at is null`, [taskId]), s.person);
    expect(open.rows[0].n).toBe(0);
  });

  it('«Остановить» предлагается только у взятого дела', async () => {
    const s = await scene();
    const taskId = await makeTask(s, 'Ещё не взято');
    expect((await get(s.tg, `/app/api/tasks/${taskId}`)).body.actions).not.toContain('stop');

    await post(s.tg, `/app/api/tasks/${taskId}/take`).send({}).expect(200);

    const r = await get(s.tg, `/app/api/tasks/${taskId}`);
    expect(r.body.actions).toContain('stop');
    expect(r.body.actions).not.toContain('take');
  });

  // Человек возвращается к делу не раз: остановился, отвлёкся, взялся снова. Счётчик обязан
  // показывать всё потраченное на дело время, иначе первые подходы просто пропадают с экрана.
  it('время подходов складывается: остановился и взялся снова — счёт продолжается', async () => {
    const s = await scene();
    const taskId = await makeTask(s, 'Возвращаюсь к делу');
    await post(s.tg, `/app/api/tasks/${taskId}/take`).send({}).expect(200);
    await new Promise((r) => setTimeout(r, 1100));
    await post(s.tg, `/app/api/tasks/${taskId}/stop`).send({}).expect(200);

    const afterFirst = (await inOrg(s.orgId, (db) => db.query(
      'select worked_seconds from tasks where id = $1', [taskId]), s.person)).rows[0].worked_seconds as number;
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    await post(s.tg, `/app/api/tasks/${taskId}/take`).send({}).expect(200);
    const running = (await get(s.tg, '/app/api/lists')).body.in_progress;

    // Идущий отрезок пошёл заново, а наработанное прежде пришло отдельным числом — экран сложит их.
    expect(running.task_id).toBe(taskId);
    expect(running.worked_seconds).toBe(afterFirst);
  });

  it('сдал дело — время последнего подхода тоже засчитано', async () => {
    const s = await scene();
    const taskId = await makeTask(s, 'Взял и сдал');
    await post(s.tg, `/app/api/tasks/${taskId}/take`).send({}).expect(200);
    await new Promise((r) => setTimeout(r, 1100));
    const version = (await get(s.tg, `/app/api/tasks/${taskId}`)).body.task.version as number;
    await post(s.tg, `/app/api/tasks/${taskId}/done`).send({ version }).expect(200);

    const worked = (await inOrg(s.orgId, (db) => db.query(
      'select worked_seconds from tasks where id = $1', [taskId]), s.person)).rows[0].worked_seconds as number;
    expect(worked).toBeGreaterThanOrEqual(1);
  });

  it('повторное «Взял» начинает счёт заново: таймер идёт с последнего взятия', async () => {
    const s = await scene();
    const taskId = await makeTask(s, 'Взял, остановил, снова взял');
    await post(s.tg, `/app/api/tasks/${taskId}/take`).send({}).expect(200);
    const first = (await inOrg(s.orgId, (db) => db.query(
      'select started_at, taken_at from tasks where id = $1', [taskId]), s.person)).rows[0];
    await post(s.tg, `/app/api/tasks/${taskId}/stop`).send({}).expect(200);
    await new Promise((r) => setTimeout(r, 1100));
    await post(s.tg, `/app/api/tasks/${taskId}/take`).send({}).expect(200);

    const again = (await inOrg(s.orgId, (db) => db.query(
      'select started_at, taken_at from tasks where id = $1', [taskId]), s.person)).rows[0];
    // Первое взятие помнит расчёт цикла, последнее — таймер на экране: это два разных времени.
    expect(new Date(again.started_at).getTime()).toBe(new Date(first.started_at).getTime());
    expect(new Date(again.taken_at).getTime()).toBeGreaterThan(new Date(first.taken_at).getTime());
  });

  it('у дела с затребованным результатом «Завершить» показывается и сдаёт', async () => {
    const s = await scene();
    const taskId = await makeTask(s, 'Нужен файл', { expectedResult: { type: 'file', required: false } });

    const r = await get(s.tg, `/app/api/tasks/${taskId}`);
    expect(r.body.task.requires_result).toBe(false);
    expect(r.body.actions).toContain('done');
    expect(r.body.actions).toContain('take');
    await post(s.tg, `/app/api/tasks/${taskId}/done`).send({ version: r.body.task.version }).expect(200);
    const row = (await inOrg(s.orgId, (db) => db.query('select status from tasks where id = $1', [taskId]), s.person)).rows[0];
    expect(row.status).toBe('submitted');
  });

  it('у личного дела нет разговора с агентом', async () => {
    const s = await scene();
    const personalOrg = await withGlobal((db) => ensurePersonalOrg(db, s.person));
    const task = await inOrg(personalOrg, (db) => createTask(db, {
      title: 'Личное дело', assigneeUserId: s.person,
    }, { kind: 'user', userId: s.person }), s.person);

    const r = await get(s.tg, `/app/api/tasks/${task.id}`);
    expect(r.status).toBe(200);
    expect(r.body.personal).toBe(true);
    // Отказ уводит дело в `declined`, которого нет ни в одном списке приложения: своё дело удаляют
    // или откладывают, а не отклоняют (ревью диффа).
    expect(r.body.actions).toEqual(['done', 'postpone']);
  });

  // Каждый работает на своём языке (спека translation-and-email). Уведомления бота реплики
// переводили, а карточка приложения отдавала их как есть: вьетнамская запись исполнителя приходила
// владельцу в бота по-русски, а в приложении оставалась вьетнамской.
describe('записи на языке читающего', () => {
  afterEach(() => setLlmForTests(undefined));

  it('вьетнамская запись исполнителя показывается владельцу по-русски', async () => {
    const s = await scene();
    const taskId = await makeTask(s, 'Склад закрыт');
    await inOrg(s.orgId, (db) => db.query(
      `insert into task_messages(org_id, task_id, kind, text, source_language, author_user_id)
       values (current_setting('app.org_id')::uuid, $1, 'comment', $2, 'vi', $3)`,
      [taskId, 'Hôm nay kho đóng cửa', s.person]), s.person);

    setLlmForTests(async () => ({ text: 'Сегодня склад закрыт', inputTokens: 1, outputTokens: 1 }));
    const r = await get(s.tg, `/app/api/tasks/${taskId}`);

    expect(r.status).toBe(200);
    expect(r.body.notes.map((n: { text: string }) => n.text)).toEqual(['Сегодня склад закрыт']);
  });

  it('запись на языке читающего не переводится — модель не дёргается', async () => {
    const s = await scene();
    const taskId = await makeTask(s, 'Уже по-русски');
    await inOrg(s.orgId, (db) => db.query(
      `insert into task_messages(org_id, task_id, kind, text, source_language, author_user_id)
       values (current_setting('app.org_id')::uuid, $1, 'comment', $2, 'ru', $3)`,
      [taskId, 'Забрал ключи у охраны', s.person]), s.person);

    let calls = 0;
    setLlmForTests(async () => { calls++; return { text: 'не должно понадобиться', inputTokens: 1, outputTokens: 1 }; });
    const r = await get(s.tg, `/app/api/tasks/${taskId}`);

    expect(r.body.notes[0].text).toBe('Забрал ключи у охраны');
    expect(calls).toBe(0);
  });
});

// Кнопки «Отказаться» у личного дела нет, но ручка — отдельная дверь: старый клиент, повтор
  // запроса или любопытство стирали дело насовсем. `declined` не входит ни в один список
  // приложения, а `reopen` разрешён только из `done` — вернуть дело было нечем.
  it('отказ от личного дела ручка не принимает — своё дело не теряется', async () => {
    const s = await scene();
    const personalOrg = await withGlobal((db) => ensurePersonalOrg(db, s.person));
    const task = await inOrg(personalOrg, (db) => createTask(db, {
      title: 'Личное дело, которое нельзя потерять', assigneeUserId: s.person,
    }, { kind: 'user', userId: s.person }), s.person);

    const r = await post(s.tg, `/app/api/tasks/${task.id}/decline`).send({ text: 'не хочу' });
    expect(r.status).toBe(400);

    const after = await inOrg(personalOrg, (db) => db.query('select status from tasks where id = $1', [task.id]), s.person);
    expect(after.rows[0].status).not.toBe('declined');
    expect((await get(s.tg, `/app/api/tasks/${task.id}`)).status).toBe(200);
  });

  it('«Отложить» уводит личное дело в «Когда-нибудь» и возвращает обратно', async () => {
    const s = await scene();
    const personalOrg = await withGlobal((db) => ensurePersonalOrg(db, s.person));
    const task = await inOrg(personalOrg, (db) => createTask(db, {
      title: 'Разобрать гараж', assigneeUserId: s.person, category: 'do', release: true,
    }, { kind: 'user', userId: s.person }), s.person);
    const categoryOf = async (): Promise<{ category: string | null; status: string }> => {
      const r = await inOrg(personalOrg, (db) => db.query('select category, status from tasks where id = $1', [task.id]), s.person);
      return r.rows[0] as { category: string | null; status: string };
    };
    const before = await categoryOf();

    const off = await post(s.tg, `/app/api/personal/${task.id}/someday`).send({ someday: true });
    expect(off.status).toBe(200);
    expect(await categoryOf()).toEqual({ category: 'someday', status: before.status });

    const back = await post(s.tg, `/app/api/personal/${task.id}/someday`).send({ someday: false });
    expect(back.status).toBe(200);
    expect(await categoryOf()).toEqual({ category: 'do', status: before.status });
  });

  it('отложить чужое личное дело нельзя', async () => {
    const s = await scene();
    const strangerOrg = await withGlobal((db) => ensurePersonalOrg(db, s.ownerId));
    const task = await inOrg(strangerOrg, (db) => createTask(db, {
      title: 'Чужое личное', assigneeUserId: s.ownerId, category: 'do', release: true,
    }, { kind: 'user', userId: s.ownerId }), s.ownerId);

    const r = await post(s.tg, `/app/api/personal/${task.id}/someday`).send({ someday: true });
    expect(r.status).toBe(404);
    const row = await inOrg(strangerOrg, (db) => db.query('select category from tasks where id = $1', [task.id]), s.ownerId);
    expect(row.rows[0].category).toBe('do');
  });

  it('личное дело нельзя увести в «в работе» или «вопрос» мимо кнопок', async () => {
    // Набор кнопок урезан, но ручки раньше принимали всё: старый клиент уводил личное дело
    // в статус, которого нет ни в одном списке (ревью диффа).
    const s = await scene();
    const personalOrg = await withGlobal((db) => ensurePersonalOrg(db, s.person));
    const task = await inOrg(personalOrg, (db) => createTask(db, {
      title: 'Своё дело', assigneeUserId: s.person, release: true,
    }, { kind: 'user', userId: s.person }), s.person);
    const statusNow = async (): Promise<string> => {
      const r = await inOrg(personalOrg, (db) => db.query('select status from tasks where id = $1', [task.id]), s.person);
      return r.rows[0].status as string;
    };
    const was = await statusNow();

    expect((await post(s.tg, `/app/api/tasks/${task.id}/take`).send({})).status).toBe(400);
    expect((await post(s.tg, `/app/api/tasks/${task.id}/question`).send({ text: 'что это', kind: 'question' })).status).toBe(400);
    expect(await statusNow()).toBe(was);
  });

  it('вопросы по одному делу ограничены сутками, как и реплики', async () => {
    const s = await scene();
    // Слот «Сейчас» занимает первое дело, второе остаётся в очереди: вопрос из очереди статуса
    // не меняет, поэтому кнопка нажимается снова и снова — без предела сводка агента заполняется
    // одним человеком (ревью диффа).
    await makeTask(s, 'Дело в работе', { release: true });
    const queued = await makeTask(s, 'Дело в очереди', { release: true });
    expect(await statusOf(s, queued)).toBe('ready');

    let refused = 0;
    let accepted = 0;
    for (let i = 0; i < 25; i += 1) {
      const r = await post(s.tg, `/app/api/tasks/${queued}/question`).send({ text: `вопрос ${i}`, kind: 'question' });
      if (r.body?.code === 'limit_exceeded') refused += 1;
      else if (r.status === 200) accepted += 1;
    }
    expect(accepted).toBe(20);
    expect(refused).toBe(5);
    expect(await statusOf(s, queued)).toBe('ready');
  });

  it('версия карточки принимается только числом', async () => {
    const s = await scene();
    const taskId = await makeTask(s, 'Дело с версией');
    // Строка молча отключала проверку, null превращался в версию 0 и ломал корректный запрос.
    expect((await post(s.tg, `/app/api/tasks/${taskId}/take`).send({ version: 'abc' })).status).toBe(400);
    expect((await post(s.tg, `/app/api/tasks/${taskId}/take`).send({ version: null })).status).toBe(200);
  });

  it('текст из невидимых символов — не текст', async () => {
    const s = await scene();
    const taskId = await makeTask(s, 'Дело с пустым отказом');
    expect((await post(s.tg, `/app/api/tasks/${taskId}/decline`).send({ text: '\u200b\u200b' })).status).toBe(400);
    // Нулевой байт валил запрос в 500 — теперь это обычный отказ.
    expect((await post(s.tg, `/app/api/tasks/${taskId}/decline`).send({ text: '\u0000' })).status).toBe(400);
    expect(await statusOf(s, taskId)).not.toBe('declined');
  });

  it('приглашённый: действие по делу принимает живое приглашение, отозванное — 404', async () => {
    const s = await scene();
    const taskId = await makeTask(s, 'Дело приглашённому');
    await withGlobal((db) => db.query(
      `update memberships set status = 'invited' where org_id = $1 and user_id = $2`, [s.orgId, s.person]));
    const invitation = await inOrg(s.orgId, async (db) => (await db.query(
      `insert into invitations(org_id, email, user_id, role, token_hash, invited_by_user_id, status)
       values ($1, $2, $3, 'member', $4, $5, 'revoked') returning id`,
      [s.orgId, `inv-${uniq()}@test.local`, s.person, `hash-${uniq()}`, s.ownerId])).rows[0].id as string);
    // Отозванное приглашение дел не открывает: не «нельзя», а «нет такого дела».
    expect((await post(s.tg, `/app/api/tasks/${taskId}/take`).send({})).status).toBe(404);
    expect((await post(s.tg, `/app/api/tasks/${taskId}/decline`).send({ text: 'не буду' })).status).toBe(404);
    expect(await statusOf(s, taskId)).not.toBe('declined');

    // Живое — первое действие и есть принятие: членство active, дело взято.
    await inOrg(s.orgId, (db) => db.query(`update invitations set status = 'pending' where id = $1`, [invitation]));
    expect((await post(s.tg, `/app/api/tasks/${taskId}/take`).send({})).status).toBe(200);
    const m = await withGlobal((db) => db.query(
      `select status from memberships where org_id = $1 and user_id = $2`, [s.orgId, s.person]));
    expect(m.rows[0].status).toBe('active');
    expect(await statusOf(s, taskId)).toBe('in_progress');
  });

  it('приглашённый без живого приглашения дела не двигает', async () => {
    const s = await scene();
    const taskId = await makeTask(s, 'Дело приглашённому');
    await withGlobal((db) => db.query(
      `update memberships set status = 'invited' where org_id = $1 and user_id = $2`, [s.orgId, s.person]));
    expect((await post(s.tg, `/app/api/tasks/${taskId}/take`).send({})).status).toBe(404);
    expect((await post(s.tg, `/app/api/tasks/${taskId}/decline`).send({ text: 'не буду' })).status).toBe(404);
    await withGlobal((db) => db.query(
      `update memberships set status = 'active' where org_id = $1 and user_id = $2`, [s.orgId, s.person]));
    expect(await statusOf(s, taskId)).not.toBe('declined');
  });

  it('владелец видит дела человека, но не его закрытую доску (спека projects-stage2)', async () => {
    const s = await scene();
    const open = await makeTask(s, 'Рабочее дело исполнителя', { release: true });
    // Закрытая доска исполнителя: её дела не видит никто, кроме него самого.
    const board = await inOrg(s.orgId, (db) => createProject(db, { name: `Тайная ${uniq()}`, private: true },
      { kind: 'user', userId: s.person }), s.person);
    const hidden = await inOrg(s.orgId, (db) => createTask(db, {
      ...base, title: 'Закрытое дело исполнителя', assigneeUserId: s.person, project: board.id, release: true,
    }, { kind: 'user', userId: s.person }), s.person);

    const ownerTg = nextTg();
    await linkTelegram(s.ownerId, ownerTg);
    const r = await get(ownerTg, `/app/api/people/${s.person}/tasks`);
    expect(r.status).toBe(200);
    const ids = r.body.tasks.map((t: { id: string }) => t.id);
    expect(ids).toContain(open);
    expect(ids).not.toContain(hidden.id);

    // Завершённое — в том же списке, ниже открытых, даже с самым ранним сроком (владелец 30.09).
    const closed = await makeTask(s, 'Сделанное дело', { release: true });
    await inOrg(s.orgId, (db) => db.query(`update tasks set status = 'done', status_changed_at = now(), due_date = '2000-01-01' where id = $1`, [closed]));
    // Открытое не «Сейчас»: старый порядок ставил его по сроку — ниже завершённого.
    await inOrg(s.orgId, (db) => db.query(`update tasks set status = 'ready' where id = $1`, [open]));
    const r2 = await get(ownerTg, `/app/api/people/${s.person}/tasks`);
    const statuses = r2.body.tasks.map((t: { status: string }) => t.status);
    expect(statuses.at(-1)).toBe('done');
    expect(statuses.indexOf('done')).toBe(statuses.length - 1);
  });

  it('приглашённый, ещё не вошедший в бота, виден владельцу в списке людей', async () => {
    const s = await scene();
    await withGlobal((db) => db.query(
      `update memberships set status = 'invited' where org_id = $1 and user_id = $2`, [s.orgId, s.person]));
    const ownerTg = nextTg();
    await linkTelegram(s.ownerId, ownerTg);

    const lists = await get(ownerTg, '/app/api/lists');
    const company = lists.body.spaces.find((sp: { kind: string }) => sp.kind === 'company');
    const row = company.people.find((p: { id: string }) => p.id === s.person);
    expect(row).toBeTruthy();
    expect(row.invited).toBe(true);
    // Себя в списке людей нет: свой список открывается отдельным чипом.
    expect(company.people.map((p: { id: string }) => p.id)).not.toContain(s.ownerId);

    await withGlobal((db) => db.query(
      `update memberships set status = 'active' where org_id = $1 and user_id = $2`, [s.orgId, s.person]));
  });

  it('дела проекта: владелец видит список с исполнителями; закрытая чужая доска и рядовой — 404', async () => {
    const s = await scene();
    const proj = await inOrg(s.orgId, (db) => createProject(db, { name: `Опт ${uniq()}` }, { kind: 'user', userId: s.ownerId }), s.ownerId);
    const inProj = await inOrg(s.orgId, (db) => createTask(db, {
      ...base, title: 'Дело проекта', assigneeUserId: s.person, project: proj.id, release: true,
    }, { kind: 'user', userId: s.ownerId }), s.ownerId);
    const board = await inOrg(s.orgId, (db) => createProject(db, { name: `Тайная ${uniq()}`, private: true },
      { kind: 'user', userId: s.person }), s.person);

    const ownerTg = nextTg();
    await linkTelegram(s.ownerId, ownerTg);
    const r = await get(ownerTg, `/app/api/projects/${proj.id}/tasks`);
    expect(r.status).toBe(200);
    const row = r.body.tasks.find((t: { id: string }) => t.id === inProj.id);
    expect(row).toBeTruthy();
    expect(typeof row.assignee_name).toBe('string');
    expect((await get(ownerTg, `/app/api/projects/${board.id}/tasks`)).status).toBe(404);
    expect((await get(s.tg, `/app/api/projects/${proj.id}/tasks`)).status).toBe(404);
  });

  it('рядовой сотрудник чужих дел не смотрит', async () => {
    const s = await scene();
    const other = await addPerson(s.orgId, 'member');
    const r = await get(s.tg, `/app/api/people/${other}/tasks`);
    expect(r.status).toBe(404);
  });

  it('сданное дело действий уже не предлагает', async () => {
    const s = await scene();
    const taskId = await makeTask(s, 'Сдано и ждёт приёмки');
    await inOrg(s.orgId, (db) => transition(db, taskId, 'submit', { kind: 'user', userId: s.person }), s.person);

    const r = await get(s.tg, `/app/api/tasks/${taskId}`);
    expect(r.body.actions).toEqual(['decline']);
  });
});
