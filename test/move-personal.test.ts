import { afterAll, describe, expect, it } from 'vitest';
import './helpers.js';
import { closePools, withGlobal, withOrg, withSystem } from '../src/db/pool.js';
import { createTask } from '../src/core/tasks.js';
import { addHumanComment } from '../src/core/comments.js';
import { ensurePersonalOrg } from '../src/core/people.js';
import { movePerson, movePlan } from '../src/core/move-personal.js';
import { setTaskShare } from '../src/core/sharing.js';
import { addPerson, inOrg, makeOrg, MON_10 } from './helpers.js';
import sharp from 'sharp';
import { existsSync } from 'node:fs';
import { attachImage } from '../src/core/attachments.js';
import { mediaPath } from '../src/groups/media.js';

// Переезд личных дел в закрытые доски компании (спека projects-stage2).

afterAll(closePools);

/** Человек с компанией и личными делами: ровно та картина, ради которой писалась миграция. */
async function world(tasks = 2) {
  const { orgId, ownerId } = await makeOrg();
  const personalOrg = await withGlobal((db) => ensurePersonalOrg(db, ownerId));
  const ids: string[] = [];
  for (let i = 0; i < tasks; i += 1) {
    const task = await inOrg(personalOrg, (db) => createTask(db, {
      title: `Личное дело ${i}`, assigneeUserId: ownerId, category: 'do', release: true,
    }, { kind: 'user', userId: ownerId }, MON_10), ownerId);
    ids.push(task.id);
  }
  return { orgId, ownerId, personalOrg, ids };
}

/** Переезд идёт одной транзакцией: без неё `set constraints all deferred` не действует. */
const inTx = <T>(fn: (db: any) => Promise<T>): Promise<T> => withSystem(async (db) => {
  await db.query('begin');
  try {
    const r = await fn(db);
    await db.query('commit');
    return r;
  } catch (e) {
    await db.query('rollback');
    throw e;
  }
});

const planFor = async (userId: string) => (await withSystem(movePlan)).find((p) => p.user_id === userId)!;

const taskRow = async (taskId: string): Promise<Record<string, any>> => withSystem(async (db) =>
  (await db.query('select * from tasks where id = $1', [taskId])).rows[0]);

describe('переезд личного в закрытые доски (спека projects-stage2)', () => {
  it('дела уезжают на закрытую доску человека, личное пространство остаётся пустым', async () => {
    const w = await world(3);
    const person = await planFor(w.ownerId);
    expect(person.tasks).toBe(3);

    const result = await inTx((db) => movePerson(db, person));
    expect(result.moved).toBe(3);
    expect(result.left).toBe(0);
    expect(result.key).toBeTruthy();

    // Личная организация на месте: ошибка переезда обратима.
    const stillThere = await withSystem(async (db) =>
      (await db.query('select count(*)::int as n from orgs where id = $1', [w.personalOrg])).rows[0].n);
    expect(stillThere).toBe(1);

    for (const id of w.ids) {
      const row = await taskRow(id);
      expect(row.org_id).toBe(w.orgId);
      expect(row.private_owner_user_id).toBe(w.ownerId);
      expect(row.number).toBeGreaterThan(0);
    }
  });

  it('личное дело с фото переезжает вместе с фото: копия файла и запись media в компании (спека task-photos)', async () => {
    const w = await world(1);
    const id = w.ids[0]!;
    const image = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 10, b: 10 } } }).png().toBuffer();
    await inOrg(w.personalOrg, (db) => attachImage(db, { taskId: id, userId: w.ownerId, image, now: MON_10 }), w.ownerId);

    const person = await planFor(w.ownerId);
    await inTx((db) => movePerson(db, person));
    const att = await withSystem(async (db) => (await db.query(
      `select a.org_id, m.org_id as media_org, m.path from task_attachments a join media m on m.id = a.media_id where a.task_id = $1`,
      [id])).rows);
    expect(att).toHaveLength(1);
    expect(att[0].org_id).toBe(w.orgId);
    expect(att[0].media_org).toBe(w.orgId);
    expect(att[0].path.startsWith(`${w.orgId}/`)).toBe(true);
    expect(existsSync(mediaPath(att[0].path))).toBe(true);
  });

  it('дело видно хозяину и не видно агенту: это закрытая доска, а не общая', async () => {
    const w = await world(1);
    const person = await planFor(w.ownerId);
    await inTx((db) => movePerson(db, person));
    const id = w.ids[0]!;

    const mine = await inOrg(w.orgId, (db) => db.query('select id from tasks where id = $1', [id]), w.ownerId);
    expect(mine.rowCount).toBe(1);
    // Без действующего лица (так смотрит агент) закрытое дело не видно — правило RLS одно на всех.
    const agentView = await withOrg(w.orgId, (db) => db.query('select id from tasks where id = $1', [id]));
    expect(agentView.rowCount).toBe(0);
  });

  it('история дела едет вместе с ним, иначе на новом месте голая карточка', async () => {
    const w = await world(1);
    const id = w.ids[0]!;
    await inOrg(w.personalOrg, (db) => addHumanComment(db, id, w.ownerId, 'заметка себе'), w.ownerId);

    const person = await planFor(w.ownerId);
    await inTx((db) => movePerson(db, person));

    const orphans = await withSystem(async (db) => (await db.query(
      `select count(*)::int as n from task_messages m join tasks t on t.id = m.task_id
        where m.task_id = $1 and m.org_id <> t.org_id`, [id])).rows[0].n);
    expect(orphans).toBe(0);
  });

  it('отметка «открывал карточку» едет вместе с делом (спека unread-and-deeplink)', async () => {
    const w = await world(1);
    const id = w.ids[0]!;
    await inOrg(w.personalOrg, (db) => db.query(
      `insert into task_views(user_id, task_id, org_id) values ($1, $2, $3)`, [w.ownerId, id, w.personalOrg]), w.ownerId);

    const person = await planFor(w.ownerId);
    await inTx((db) => movePerson(db, person));

    const views = await withSystem(async (db) => (await db.query(
      'select org_id from task_views where task_id = $1', [id])).rows);
    expect(views).toEqual([{ org_id: w.orgId }]);
  });

  it('дело с пометкой «рабочее» уезжает в ту компанию, с которой им поделились', async () => {
    const w = await world(1);
    const id = w.ids[0]!;
    await inOrg(w.personalOrg, (db) => setTaskShare(db, id, w.ownerId, w.orgId), w.ownerId);

    const person = await planFor(w.ownerId);
    const result = await inTx((db) => movePerson(db, person));
    expect(result.shared).toBe(1);

    const row = await taskRow(id);
    expect(row.org_id).toBe(w.orgId);
    // В компании дело и так видно: пометка «рабочее» снимается, закрытым оно не становится.
    expect(row.private_owner_user_id).toBeNull();
    expect(row.shared_org_id).toBeNull();
  });

  it('человеку без компании везти некуда — его дела остаются на месте', async () => {
    const { orgId, ownerId } = await makeOrg();
    const loner = await addPerson(orgId, 'member');
    const personalOrg = await withGlobal((db) => ensurePersonalOrg(db, loner));
    const task = await inOrg(personalOrg, (db) => createTask(db, {
      title: 'Дело одиночки', assigneeUserId: loner, release: true,
    }, { kind: 'user', userId: loner }, MON_10), loner);
    // Человека выводим из компании: членство больше не активно, везти дела некуда.
    await withGlobal((db) => db.query(
      `update memberships set status = 'removed' where org_id = $1 and user_id = $2`, [orgId, loner]));

    const person = await planFor(loner);
    expect(person.company_id).toBeNull();
    const result = await inTx((db) => movePerson(db, person));
    expect(result.skipped).toBe('no_company');

    const row = await taskRow(task.id);
    expect(row.org_id).toBe(personalOrg);
  });

  it('после переезда «Сейчас» не пустует: очередь пересчитана', async () => {
    const w = await world(2);
    const person = await planFor(w.ownerId);
    await inTx((db) => movePerson(db, person));

    // Слот занимает одно из переехавших дел: иначе человек видит «дел нет» при полном списке.
    const active = await withSystem(async (db) => (await db.query(
      `select count(*)::int as n from tasks
        where assignee_user_id = $1 and org_id = $2 and status in ('active','in_progress')`,
      [w.ownerId, w.orgId])).rows[0].n);
    expect(active).toBe(1);
  });

  it('повторный запуск ничего не ломает: доска одна, дела уже на месте', async () => {
    const w = await world(2);
    const person = await planFor(w.ownerId);
    await inTx((db) => movePerson(db, person));
    // После переезда человек из плана уходит: личных дел у него больше нет.
    expect((await withSystem(movePlan)).find((p) => p.user_id === w.ownerId)).toBeUndefined();

    const boards = await withSystem(async (db) => (await db.query(
      `select count(*)::int as n from projects where org_id = $1 and owner_user_id = $2 and private`,
      [w.orgId, w.ownerId])).rows[0].n);
    expect(boards).toBe(1);
  });
});
