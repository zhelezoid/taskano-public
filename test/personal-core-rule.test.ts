import { afterAll, describe, expect, it } from 'vitest';
import './helpers.js';
import { closePools, withGlobal } from '../src/db/pool.js';
import { createTask } from '../src/core/tasks.js';
import { createProject } from '../src/core/projects.js';
import { ensurePersonalOrg } from '../src/core/people.js';
import { transition, type Action } from '../src/core/lifecycle.js';
import { takeTask } from '../src/core/queue.js';
import { AppError } from '../src/core/errors.js';
import { tickOrg } from '../src/worker/tick.js';
import type { Actor } from '../src/core/types.js';
import { MON_10, addPerson, inOrg, makeOrg, makeUser, uniq } from './helpers.js';

// «Взять», вопрос, «Непонятно» и отказ в личном пространстве запрещает ядро (спеки miniapp-task-actions
// и telegram-bot). Раньше запрет жил только в ручках приложения: бот держался на
// наборе кнопок, коннектор и прямой вызов ядра проходили мимо. Своя закрытая доска в компании под
// запрет не попадает — там «Взять» обычный ход (спека multi-company).

afterAll(closePools);

const user = (userId: string): Actor => ({ kind: 'user', userId });
const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу' };
const FORBIDDEN: Action[] = ['take', 'question', 'unclear', 'decline'];

async function refusal(p: Promise<unknown>): Promise<string | null> {
  try { await p; return null; } catch (e) { return e instanceof AppError ? e.code : String(e); }
}

async function statusIn(orgId: string, taskId: string, userId: string): Promise<string> {
  return inOrg(orgId, async (db) => (await db.query('select status from tasks where id = $1', [taskId])).rows[0].status, userId);
}

describe('личное пространство: запрет в ядре', () => {
  it('тик не ставит личное дело в «Сейчас»: у личного нет очереди', async () => {
    const person = await makeUser();
    const orgId = await withGlobal((db) => ensurePersonalOrg(db, person));
    const task = await inOrg(orgId, (db) => createTask(db, { title: 'Позвонить маме', assigneeUserId: person, release: true }, user(person), MON_10), person);
    const was = await statusIn(orgId, task.id, person);
    expect(was).not.toBe('active');
    await tickOrg(orgId, new Date(MON_10.getTime() + 60_000));
    expect(await statusIn(orgId, task.id, person)).toBe(was);
  });

  it('в личном пространстве «Взять», вопрос, «Непонятно» и отказ отклоняются, дело остаётся на месте', async () => {
    const person = await makeUser();
    const orgId = await withGlobal((db) => ensurePersonalOrg(db, person));
    const task = await inOrg(orgId, (db) => createTask(db, { title: 'Купить лампу', assigneeUserId: person, release: true }, user(person), MON_10), person);
    const was = await statusIn(orgId, task.id, person);

    for (const action of FORBIDDEN) {
      const code = await refusal(inOrg(orgId, (db) => transition(db, task.id, action, user(person), { text: 'почему', now: MON_10 }), person));
      expect({ action, code }).toEqual({ action, code: 'validation_failed' });
    }
    expect(await statusIn(orgId, task.id, person)).toBe(was);
  });

  it('своё дело на своей закрытой доске в компании по-прежнему берут в работу', async () => {
    // Запрет — только для личного пространства: у закрытой доски слот «Сейчас» общий с работой
    // (спека multi-company), и «Взять» там — обычный ход.
    const { orgId } = await makeOrg();
    const person = await addPerson(orgId, 'member');
    const board = await inOrg(orgId, (db) => createProject(db, { name: `Своё ${uniq()}`, private: true }, user(person)), person);
    const task = await inOrg(orgId, (db) => createTask(db,
      { title: 'Разобрать бумаги', assigneeUserId: person, project: board.id, release: true }, user(person), MON_10), person);

    expect((await inOrg(orgId, (db) => takeTask(db, task.id, user(person), { now: MON_10 }), person)).status).toBe('in_progress');
  });

  it('«Взять» личного дела не снимает «Сейчас» в другой компании', async () => {
    // takeTask гасит прежнего держателя слота чужой компании отдельной транзакцией — отказ ядра
    // потом её не откатит. Поэтому запрет проверяется до того, как слот трогают.
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId, 'member');
    const work = await inOrg(orgId, (db) => createTask(db,
      { ...base, title: 'Сверить склад', assigneeUserId: person }, user(ownerId), MON_10), ownerId);
    await inOrg(orgId, (db) => takeTask(db, work.id, user(person), { now: MON_10 }), person);
    expect(await statusIn(orgId, work.id, person)).toBe('in_progress');

    const personalOrg = await withGlobal((db) => ensurePersonalOrg(db, person));
    const mine = await inOrg(personalOrg, (db) => createTask(db, { title: 'Позвонить маме', assigneeUserId: person, release: true }, user(person), MON_10), person);

    const code = await refusal(inOrg(personalOrg, (db) => takeTask(db, mine.id, user(person), { now: MON_10 }), person));
    expect(code).toBe('validation_failed');
    expect(await statusIn(orgId, work.id, person)).toBe('in_progress');
  });

  it('рабочее дело, которое поставил другой, по-прежнему берут и отклоняют', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId, 'member');
    const t1 = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'Взять', assigneeUserId: person }, user(ownerId), MON_10), ownerId);
    const t2 = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'Отклонить', assigneeUserId: person }, user(ownerId), MON_10), ownerId);

    expect((await inOrg(orgId, (db) => takeTask(db, t1.id, user(person), { now: MON_10 }), person)).status).toBe('in_progress');
    expect((await inOrg(orgId, (db) => transition(db, t2.id, 'decline', user(person), { text: 'не моё', now: MON_10 }), person)).status).toBe('declined');
  });
});
