import { afterAll, describe, expect, it } from 'vitest';
import './helpers.js';
import { closePools, withGlobal } from '../src/db/pool.js';
import { createTask } from '../src/core/tasks.js';
import { transition } from '../src/core/lifecycle.js';
import { orgStats, periodRange } from '../src/core/stats.js';
import { createProject } from '../src/core/projects.js';
import { addManual, startTimer, stopTimer, timeReport } from '../src/core/time.js';
import { durationLabel } from '../app/src/i18n.js';
import { addPerson, inOrg, makeOrg, minutes, MON_10 } from './helpers.js';

// Итоги работы (спека stats-page): считаются по ленте событий, границы суток — по поясу организации.

afterAll(closePools);

const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };
const TZ = 'Europe/Istanbul';

async function scene() {
  const { orgId, ownerId } = await makeOrg();
  const worker = await addPerson(orgId, 'member');
  const other = await addPerson(orgId, 'member');
  return { orgId, ownerId, worker, other };
}

/** Дело исполнителя, доведённое до приёмки в заданный момент. */
async function acceptedAt(s: Awaited<ReturnType<typeof scene>>, when: Date, who?: string): Promise<string> {
  const assignee = who ?? s.worker;
  const task = await inOrg(s.orgId, (db) => createTask(db, {
    ...base, title: `Дело ${when.toISOString()}`, assigneeUserId: assignee, release: true,
  }, { kind: 'user', userId: s.ownerId }, when), s.ownerId);
  await inOrg(s.orgId, (db) => transition(db, task.id, 'take', { kind: 'user', userId: assignee }, { now: when }), assignee);
  await inOrg(s.orgId, (db) => transition(db, task.id, 'submit', { kind: 'user', userId: assignee }, { now: when }), assignee);
  await inOrg(s.orgId, (db) => transition(db, task.id, 'accept', { kind: 'user', userId: s.ownerId }, { now: when }), s.ownerId);
  // Лента пишет `at` временем базы: в жизни это и есть момент действия, а в тесте прошлое
  // приходится расставлять руками — иначе «вчера» не проверить вовсе.
  await inOrg(s.orgId, (db) => db.query('update events set at = $2 where task_id = $1', [task.id, when]), s.ownerId);
  return task.id;
}

/** Смотрим на итоги чуть позже события: граница периода — «до сих пор», а не «включая эту секунду». */
const LATER = 60_000;

const stats = (s: Awaited<ReturnType<typeof scene>>, period: any, viewer: string, whole: boolean, now: Date) =>
  inOrg(s.orgId, (db) => orgStats(db, { period, tz: TZ, viewerId: viewer, wholeOrg: whole, now }), viewer);

describe('итоги работы (спека stats-page)', () => {
  it('границы периодов считаются по часовому поясу организации', () => {
    // 21 сентября 10:00 в Стамбуле = 07:00 UTC; сутки начались в 21:00 UTC предыдущего дня.
    const today = periodRange('today', TZ, MON_10);
    expect(today.from.toISOString()).toBe('2026-09-20T21:00:00.000Z');

    const yesterday = periodRange('yesterday', TZ, MON_10);
    expect(yesterday.from.toISOString()).toBe('2026-09-19T21:00:00.000Z');
    expect(yesterday.to.toISOString()).toBe(today.from.toISOString());

    // «Этот месяц» — с 1-го числа, «прошлый» — календарный целиком, и они не пересекаются.
    const thisMonth = periodRange('this_month', TZ, MON_10, 'ru');
    const lastMonth = periodRange('last_month', TZ, MON_10, 'ru');
    expect(thisMonth.from.toISOString()).toBe('2026-08-31T21:00:00.000Z');
    expect(lastMonth.to.toISOString()).toBe(thisMonth.from.toISOString());
    expect(thisMonth.label).toBe('сентябрь');
    expect(lastMonth.label).toBe('август');

    // Январь: прошлый месяц — декабрь прошлого года.
    const jan = periodRange('last_month', TZ, new Date('2027-01-15T09:00:00Z'), 'ru');
    expect(jan.label).toBe('декабрь');
    expect(jan.from.toISOString()).toBe('2026-11-30T21:00:00.000Z');
  });

  it('«30 дней» и «этот месяц» — разные числа, когда месяц только начался', () => {
    const first = new Date('2026-10-01T09:00:00Z');
    const month = periodRange('this_month', TZ, first);
    const window30 = periodRange('30d', TZ, first);
    expect(window30.from.getTime()).toBeLessThan(month.from.getTime());
  });

  it('считается по событиям приёмки: принятое вчера остаётся во «вчера»', async () => {
    const s = await scene();
    const yesterday = new Date(MON_10.getTime() - 86_400_000);
    const id = await acceptedAt(s, yesterday);
    // Дело изменилось сегодня — в статусе этого не видно, а в ленте событий видно.
    await inOrg(s.orgId, (db) => db.query('update tasks set updated_at = $2 where id = $1', [id, MON_10]), s.ownerId);

    const y = await stats(s, 'yesterday', s.ownerId, true, MON_10);
    expect(y.totals.done).toBe(1);
    const t = await stats(s, 'today', s.ownerId, true, MON_10);
    expect(t.totals.done).toBe(0);
  });

  it('повторная приёмка после доработки не удваивает число', async () => {
    const s = await scene();
    const id = await acceptedAt(s, MON_10);
    const later = new Date(MON_10.getTime() + 3600_000);
    await inOrg(s.orgId, (db) => transition(db, id, 'reopen', { kind: 'user', userId: s.ownerId }, { now: later }), s.ownerId);
    await inOrg(s.orgId, (db) => transition(db, id, 'take', { kind: 'user', userId: s.worker }, { now: later }), s.worker);
    await inOrg(s.orgId, (db) => transition(db, id, 'submit', { kind: 'user', userId: s.worker }, { now: later }), s.worker);
    await inOrg(s.orgId, (db) => transition(db, id, 'accept', { kind: 'user', userId: s.ownerId }, { now: later }), s.ownerId);

    const r = await stats(s, 'today', s.ownerId, true, new Date(later.getTime() + 60_000));
    expect(r.totals.done).toBe(1);
    expect(r.totals.submitted).toBe(0);
  });

  it('исполнитель видит только свои числа, владелец — всю компанию', async () => {
    const s = await scene();
    await acceptedAt(s, MON_10, s.worker);
    await acceptedAt(s, MON_10, s.other);

    const mine = await stats(s, 'today', s.worker, false, new Date(MON_10.getTime() + LATER));
    expect(mine.totals.done).toBe(1);
    expect(mine.people).toHaveLength(1);

    const all = await stats(s, 'today', s.ownerId, true, new Date(MON_10.getTime() + LATER));
    expect(all.totals.done).toBe(2);
    expect(all.people.length).toBeGreaterThanOrEqual(3);
  });

  it('человек без дел за период показан с нулём, а не пропущен', async () => {
    const s = await scene();
    await acceptedAt(s, MON_10, s.worker);
    const all = await stats(s, 'today', s.ownerId, true, new Date(MON_10.getTime() + LATER));
    const idle = all.people.find((p) => p.id === s.other);
    expect(idle).toBeDefined();
    expect(idle!.done).toBe(0);
  });

  it('пустая компания даёт нули, а не пустоту', async () => {
    const s = await scene();
    const r = await stats(s, '7d', s.ownerId, true, MON_10);
    expect(r.totals).toEqual({ done: 0, submitted: 0, dropped: 0, minutes: 0 });
    expect(r.people.length).toBeGreaterThan(0);
  });
  it('в «Итогах» чужая закрытая доска не значится даже нулевой строкой', async () => {
    const s2 = await scene();
    const secret = await inOrg(s2.orgId, (db) => createProject(db, { name: 'Переговоры о продаже', private: true },
      { kind: 'user', userId: s2.ownerId }), s2.ownerId);

    const forWorker = await stats(s2, 'today', s2.worker, false, MON_10);
    expect(forWorker.projects.some((p) => p.id === secret.id)).toBe(false);
    // Хозяин свою доску видит — скрыто чужое, а не всё подряд.
    const forOwner = await stats(s2, 'today', s2.ownerId, true, MON_10);
    expect(forOwner.projects.some((p) => p.id === secret.id)).toBe(true);
  });
});

// Время в «Итогах» (спека stats-page, раздел «Время»): по учёту времени, та же арифметика, что у
// отчёта по времени. «Сегодня» по Стамбулу — с 2026-09-20T21:00Z.
describe('время в итогах (спека stats-page)', () => {
  /** Дело исполнителя, чтобы было на что вести время. */
  const taskFor = (s: Awaited<ReturnType<typeof scene>>, who: string, title: string) => inOrg(s.orgId, (db) => createTask(db, {
    ...base, title, assigneeUserId: who, release: true,
  }, { kind: 'user', userId: s.ownerId }, MON_10), s.ownerId);

  const timer = async (s: Awaited<ReturnType<typeof scene>>, who: string, taskId: string, from: Date, to: Date | null) => {
    await inOrg(s.orgId, (db) => startTimer(db, who, taskId, from), who);
    if (to) await inOrg(s.orgId, (db) => stopTimer(db, who, to), who);
  };

  it('таймер и ручная запись за период складываются; задачи человека — от большего к меньшему', async () => {
    const s = await scene();
    const big = await taskFor(s, s.worker, 'Сверить склад');
    const small = await taskFor(s, s.worker, 'Позвонить поставщику');
    await timer(s, s.worker, big.id, MON_10, minutes(MON_10, 90));
    // Ручная запись за 21 сентября встаёт на полдень по поясу человека — внутри «сегодня».
    await inOrg(s.orgId, (db) => addManual(db, s.worker, small.id, 20, '2026-09-21'), s.worker);

    const r = await stats(s, 'today', s.ownerId, true, minutes(MON_10, 6 * 60));
    expect(r.totals.minutes).toBe(110);
    const me = r.people.find((p) => p.id === s.worker)!;
    expect(me.minutes).toBe(110);
    expect(me.tasks.map((x) => [x.id, x.minutes])).toEqual([[big.id, 90], [small.id, 20]]);
    expect(me.tasks[0]!.title).toBe('Сверить склад');
    expect(me.tasks[0]!.hidden).toBe(false);
    // Проект дела получает то же время: у обоих дел он один.
    const project = r.projects.find((p) => p.id === big.project_id);
    if (big.project_id) expect(project?.minutes).toBe(110);
    // Вчера этого времени нет.
    const y = await stats(s, 'yesterday', s.ownerId, true, minutes(MON_10, 6 * 60));
    expect(y.totals.minutes).toBe(0);
  });

  it('идущий таймер считается до «сейчас»', async () => {
    const s = await scene();
    const t = await taskFor(s, s.worker, 'Идёт');
    await timer(s, s.worker, t.id, MON_10, null);
    const r = await stats(s, 'today', s.ownerId, true, minutes(MON_10, 45));
    expect(r.totals.minutes).toBe(45);
    expect(r.people.find((p) => p.id === s.worker)!.tasks[0]!.minutes).toBe(45);
    await inOrg(s.orgId, (db) => stopTimer(db, s.worker, minutes(MON_10, 50)), s.worker);
  });

  it('таймер через границу периода делится между «вчера» и «сегодня»', async () => {
    const s = await scene();
    const t = await taskFor(s, s.worker, 'Ночная смена');
    // 23:00 → 01:00 по Стамбулу: час вчера и час сегодня.
    await timer(s, s.worker, t.id, new Date('2026-09-20T20:00:00Z'), new Date('2026-09-20T22:00:00Z'));
    const today = await stats(s, 'today', s.ownerId, true, MON_10);
    const yesterday = await stats(s, 'yesterday', s.ownerId, true, MON_10);
    expect(today.totals.minutes).toBe(60);
    expect(yesterday.totals.minutes).toBe(60);
  });

  it('рядовой видит только своё время', async () => {
    const s = await scene();
    const mine = await taskFor(s, s.worker, 'Моё');
    const theirs = await taskFor(s, s.other, 'Чужое');
    await timer(s, s.worker, mine.id, MON_10, minutes(MON_10, 30));
    await timer(s, s.other, theirs.id, MON_10, minutes(MON_10, 50));

    const r = await stats(s, 'today', s.worker, false, minutes(MON_10, 60));
    expect(r.totals.minutes).toBe(30);
    expect(r.people.map((p) => p.id)).toEqual([s.worker]);
    expect(r.people[0]!.tasks.map((x) => x.id)).toEqual([mine.id]);

    const all = await stats(s, 'today', s.ownerId, true, minutes(MON_10, 60));
    expect(all.totals.minutes).toBe(80);
  });

  it('время без задачи — отдельной строкой, дело закрытого проекта — без названия', async () => {
    const s = await scene();
    const admin = await addPerson(s.orgId, 'admin');
    // Время без задачи: запись учёта, у которой дела нет (дело удалили — `on delete set null`).
    await inOrg(s.orgId, (db) => db.query(
      `insert into time_entries(org_id, task_id, user_id, started_at, ended_at, minutes, source)
       values (current_setting('app.org_id')::uuid, null, $1, $2, $3, 15, 'timer')`,
      [s.worker, MON_10, minutes(MON_10, 15)]), s.worker);
    // Закрытый проект владельца: админ видит время владельца, но не видит, на что.
    const secret = await inOrg(s.orgId, (db) => createProject(db, { name: 'Переговоры о продаже', private: true },
      { kind: 'user', userId: s.ownerId }), s.ownerId);
    const hidden = await inOrg(s.orgId, (db) => createTask(db, {
      ...base, title: 'Условия сделки', assigneeUserId: s.ownerId, project: secret.id,
    }, { kind: 'user', userId: s.ownerId }, MON_10), s.ownerId);
    await timer(s, s.ownerId, hidden.id, MON_10, minutes(MON_10, 40));

    const r = await stats(s, 'today', admin, true, minutes(MON_10, 60));
    const worker = r.people.find((p) => p.id === s.worker)!;
    expect(worker.tasks).toEqual([{ id: null, key: null, title: null, hidden: false, minutes: 15 }]);
    const owner = r.people.find((p) => p.id === s.ownerId)!;
    expect(owner.minutes).toBe(40);
    expect(owner.tasks).toEqual([{ id: null, key: null, title: null, hidden: true, minutes: 40 }]);
    expect(JSON.stringify(r)).not.toContain('Условия сделки');

    // Хозяин закрытого проекта своё дело видит с названием.
    const own = await stats(s, 'today', s.ownerId, true, minutes(MON_10, 60));
    expect(own.people.find((p) => p.id === s.ownerId)!.tasks[0]).toMatchObject({ id: hidden.id, title: 'Условия сделки', hidden: false });
  });

  it('числа совпадают с отчётом по времени за тот же период', async () => {
    const s = await scene();
    const a = await taskFor(s, s.worker, 'А');
    const b = await taskFor(s, s.other, 'Б');
    // Через полночь, внутри дня, ручная и идущий таймер — всё, где арифметика может разойтись.
    await timer(s, s.worker, a.id, new Date('2026-09-20T20:00:30Z'), new Date('2026-09-20T22:10:50Z'));
    await timer(s, s.worker, a.id, MON_10, minutes(MON_10, 37));
    await inOrg(s.orgId, (db) => addManual(db, s.other, b.id, 25, '2026-09-21'), s.other);
    await timer(s, s.other, b.id, minutes(MON_10, 10), null);
    const now = minutes(MON_10, 6 * 60 + 13);

    for (const period of ['today', 'yesterday', '7d'] as const) {
      const r = await stats(s, period, s.ownerId, true, now);
      const report = await inOrg(s.orgId, (db) => timeReport(db, {
        userIds: [s.worker, s.other], from: new Date(r.from), to: new Date(r.to), groupBy: 'task', now,
      }), s.ownerId);
      expect(r.totals.minutes).toBe(report.totalMinutes);
      for (const g of report.groups) {
        const inStats = r.people.flatMap((p) => p.tasks).filter((x) => x.id === g.key).reduce((n, x) => n + x.minutes, 0);
        expect(inStats).toBe(g.minutes);
      }
    }
    await inOrg(s.orgId, (db) => stopTimer(db, s.other, now), s.other);
  });
});

describe('durationLabel', () => {
  it.each([
    ['ru', 45, '45 мин'], ['ru', 180, '3 ч'], ['ru', 760, '12 ч 40 мин'], ['ru', 0, '0 мин'],
    ['en', 45, '45 min'], ['en', 180, '3 h'], ['en', 760, '12 h 40 min'],
    ['tr', 45, '45 dk'], ['tr', 180, '3 sa'], ['tr', 760, '12 sa 40 dk'],
    ['vi', 45, '45 phút'], ['vi', 180, '3 giờ'], ['vi', 760, '12 giờ 40 phút'],
  ])('%s %i → «%s»', (lang, m, expected) => {
    expect(durationLabel(lang, m as number)).toBe(expected);
  });
});
