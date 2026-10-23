import { afterAll, describe, expect, it } from 'vitest';
import { closePools } from '../src/db/pool.js';
import { createTask } from '../src/core/tasks.js';
import { addManual, parseDuration, startTimer, stopTimer, timeReport } from '../src/core/time.js';
import { addPerson, inOrg, makeAgent, makeOrg, makeUser, minutes, MON_10 } from './helpers.js';

afterAll(closePools);
const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };

describe('таймер: один активный на человека', () => {
  it('старт второго таймера останавливает первый (в той же организации)', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agent = await makeAgent(orgId, ownerId);
    const act = { kind: 'agent' as const, agentId: agent, userId: ownerId };
    const t1 = await inOrg(orgId, (db) => createTask(db, { ...base, title: 't1', assigneeUserId: person }, act, MON_10));
    const t2 = await inOrg(orgId, (db) => createTask(db, { ...base, title: 't2', assigneeUserId: person }, act, MON_10));

    await inOrg(orgId, (db) => startTimer(db, person, t1.id, MON_10));
    await inOrg(orgId, (db) => startTimer(db, person, t2.id, minutes(MON_10, 20)));

    const open = await inOrg(orgId, (db) => db.query(`select task_id, minutes, ended_at from time_entries where user_id = $1 and source = 'timer'`, [person]));
    expect(open.rowCount).toBe(2);
    const first = open.rows.find((r) => r.task_id === t1.id);
    const second = open.rows.find((r) => r.task_id === t2.id);
    expect(first.minutes).toBe(20);
    expect(first.ended_at).not.toBeNull();
    expect(second.ended_at).toBeNull();
  });

  it('старт таймера в другой организации закрывает открытый таймер из первой (withSystem)', async () => {
    const person = await makeUser();
    const { orgId: orgA, ownerId: ownerA } = await makeOrg();
    await inOrg(orgA, (db) => db.query(`insert into memberships(org_id, user_id, role, status, joined_at) values ($1,$2,'member','active',now())`, [orgA, person]));
    const { orgId: orgB, ownerId: ownerB } = await makeOrg();
    await inOrg(orgB, (db) => db.query(`insert into memberships(org_id, user_id, role, status, joined_at) values ($1,$2,'member','active',now())`, [orgB, person]));
    const agentA = await makeAgent(orgA, ownerA);
    const agentB = await makeAgent(orgB, ownerB);
    const taskA = await inOrg(orgA, (db) => createTask(db, { ...base, title: 'a', assigneeUserId: person }, { kind: 'agent', agentId: agentA, userId: ownerA }, MON_10));
    const taskB = await inOrg(orgB, (db) => createTask(db, { ...base, title: 'b', assigneeUserId: person }, { kind: 'agent', agentId: agentB, userId: ownerB }, MON_10));

    await inOrg(orgA, (db) => startTimer(db, person, taskA.id, MON_10));
    await inOrg(orgB, (db) => startTimer(db, person, taskB.id, minutes(MON_10, 15)));

    const a = await inOrg(orgA, (db) => db.query(`select ended_at, minutes from time_entries where user_id = $1 and task_id = $2`, [person, taskA.id]));
    const b = await inOrg(orgB, (db) => db.query(`select ended_at, minutes from time_entries where user_id = $1 and task_id = $2`, [person, taskB.id]));
    expect(a.rows[0].ended_at).not.toBeNull();
    expect(a.rows[0].minutes).toBe(15);
    expect(b.rows[0].ended_at).toBeNull();
  });

  it('stopTimer возвращает минуты (≥1) и закрывает запись', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agent = await makeAgent(orgId, ownerId);
    const t = await inOrg(orgId, (db) => createTask(db, { ...base, title: 't', assigneeUserId: person }, { kind: 'agent', agentId: agent, userId: ownerId }, MON_10));
    await inOrg(orgId, (db) => startTimer(db, person, t.id, MON_10));
    const m = await inOrg(orgId, (db) => stopTimer(db, person, minutes(MON_10, 37)));
    expect(m).toBe(37);
    await expect(inOrg(orgId, (db) => stopTimer(db, person, MON_10))).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('ручной ввод', () => {
  it('запись за прошлую дату хранит started_at = полдень той даты в поясе человека', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId, 'member', { tz: 'Europe/Istanbul' });
    const agent = await makeAgent(orgId, ownerId);
    const t = await inOrg(orgId, (db) => createTask(db, { ...base, title: 't', assigneeUserId: person }, { kind: 'agent', agentId: agent, userId: ownerId }, MON_10));
    const entry = await inOrg(orgId, (db) => addManual(db, person, t.id, 45, '2026-09-15'));
    expect(entry.minutes).toBe(45);
    // 12:00 Стамбул (UTC+3) = 09:00 UTC.
    expect(entry.startedAt.toISOString()).toBe('2026-09-15T09:00:00.000Z');
  });

  it('0, отрицательное и больше 16ч отклоняются', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agent = await makeAgent(orgId, ownerId);
    const t = await inOrg(orgId, (db) => createTask(db, { ...base, title: 't', assigneeUserId: person }, { kind: 'agent', agentId: agent, userId: ownerId }, MON_10));
    await expect(inOrg(orgId, (db) => addManual(db, person, t.id, 0))).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(inOrg(orgId, (db) => addManual(db, person, t.id, -10))).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(inOrg(orgId, (db) => addManual(db, person, t.id, 16 * 60 + 1))).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('разбор длительности', () => {
  it.each([
    ['45', 45],
    ['1ч 30м', 90],
    ['1ч', 60],
    ['90м', 90],
    ['1:30', 90],
    ['1.5h', 90],
    ['1,5 ч', 90],
    ['2h 15m', 135],
    ['1 saat 30 dk', 90],
    ['45 dk', 45],
    ['1 giờ 30 phút', 90],
    ['45 phút', 45],
  ])('«%s» → %i минут', (text, expected) => {
    expect(parseDuration(text)).toBe(expected);
  });

  it.each(['0', '-5', '17h', String(16 * 60 + 1), '', 'ерунда'])('«%s» → null', (text) => {
    expect(parseDuration(text)).toBeNull();
  });
});

describe('отчёт по времени', () => {
  it('человек в UTC+7: таймер через полночь режется по его дням, открытый — помечен', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId, 'member', { tz: 'Asia/Bangkok' }); // UTC+7, без DST
    const agent = await makeAgent(orgId, ownerId);
    const t = await inOrg(orgId, (db) => createTask(db, { ...base, title: 't', assigneeUserId: person }, { kind: 'agent', agentId: agent, userId: ownerId }, MON_10));

    // Полночь по Бангкоку (UTC+7) — 17:00 UTC накануне. Стартуем в 16:00 UTC (23:00 Бангкок), не закрываем.
    const start = new Date('2026-09-21T16:00:00Z');
    await inOrg(orgId, (db) => startTimer(db, person, t.id, start));

    const now = new Date('2026-09-21T19:00:00Z'); // 02:00 Бангкок следующих суток
    const report = await inOrg(orgId, (db) => timeReport(db, {
      userIds: [person], from: new Date('2026-09-20T00:00:00Z'), to: new Date('2026-09-23T00:00:00Z'), groupBy: 'day', now,
    }));

    // 23:00→00:00 (день 21-го, 60 мин) и 00:00→02:00 (день 22-го, 120 мин по «сейчас»).
    const day1 = report.groups.find((g) => g.key === '2026-09-21');
    const day2 = report.groups.find((g) => g.key === '2026-09-22');
    expect(day1?.minutes).toBe(60);
    expect(day1?.open).toBe(false);
    expect(day2?.minutes).toBe(120);
    expect(day2?.open).toBe(true);
  });

  it('открытый таймер считается до текущего момента и помечен open', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId, 'member', { tz: 'Europe/Istanbul' });
    const agent = await makeAgent(orgId, ownerId);
    const t = await inOrg(orgId, (db) => createTask(db, { ...base, title: 't', assigneeUserId: person }, { kind: 'agent', agentId: agent, userId: ownerId }, MON_10));
    await inOrg(orgId, (db) => startTimer(db, person, t.id, MON_10));
    const report = await inOrg(orgId, (db) => timeReport(db, {
      userIds: [person], from: MON_10, to: minutes(MON_10, 24 * 60), groupBy: 'task', now: minutes(MON_10, 3),
    }));
    const g = report.groups.find((x) => x.key === t.id);
    expect(g?.open).toBe(true);
    expect(g?.minutes).toBe(3);
    await inOrg(orgId, (db) => stopTimer(db, person, minutes(MON_10, 5)));
  });

  it('разбивка таймер/ручной и число задач', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId, 'member', { tz: 'Europe/Istanbul' });
    const agent = await makeAgent(orgId, ownerId);
    const t1 = await inOrg(orgId, (db) => createTask(db, { ...base, title: 't1', assigneeUserId: person }, { kind: 'agent', agentId: agent, userId: ownerId }, MON_10));
    const t2 = await inOrg(orgId, (db) => createTask(db, { ...base, title: 't2', assigneeUserId: person }, { kind: 'agent', agentId: agent, userId: ownerId }, MON_10));
    await inOrg(orgId, (db) => startTimer(db, person, t1.id, MON_10));
    await inOrg(orgId, (db) => stopTimer(db, person, minutes(MON_10, 30)));
    // Дата внесения (created_at) — всегда сейчас; started_at за конкретную дату задаётся forDate,
    // иначе брался бы реальный wall-clock now — тест был бы недетерминирован.
    await inOrg(orgId, (db) => addManual(db, person, t2.id, 20, '2026-09-21'));

    const report = await inOrg(orgId, (db) => timeReport(db, { userIds: [person], from: MON_10, to: minutes(MON_10, 24 * 60), groupBy: 'day' }));
    expect(report.totalMinutes).toBe(50);
    const day = report.groups[0]!;
    expect(day.timerMinutes).toBe(30);
    expect(day.manualMinutes).toBe(20);
    expect(day.taskCount).toBe(2);
  });

  it('агент без time_report_full видит только задачи своего направления', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId, 'member', { tz: 'Europe/Istanbul' });
    const agentA = await makeAgent(orgId, ownerId);
    const agentB = await makeAgent(orgId, ownerId);
    const taskA = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'a', assigneeUserId: person }, { kind: 'agent', agentId: agentA, userId: ownerId }, MON_10));
    const taskB = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'b', assigneeUserId: person }, { kind: 'agent', agentId: agentB, userId: ownerId }, MON_10));
    await inOrg(orgId, (db) => startTimer(db, person, taskA.id, MON_10));
    await inOrg(orgId, (db) => stopTimer(db, person, minutes(MON_10, 10)));
    await inOrg(orgId, (db) => startTimer(db, person, taskB.id, minutes(MON_10, 20)));
    await inOrg(orgId, (db) => stopTimer(db, person, minutes(MON_10, 50)));

    const scoped = await inOrg(orgId, (db) => timeReport(db, {
      userIds: [person], from: MON_10, to: minutes(MON_10, 24 * 60), groupBy: 'task', agentScope: agentA,
    }));
    expect(scoped.groups.map((g) => g.key)).toEqual([taskA.id]);
    expect(scoped.totalMinutes).toBe(10);

    const full = await inOrg(orgId, (db) => timeReport(db, { userIds: [person], from: MON_10, to: minutes(MON_10, 24 * 60), groupBy: 'task' }));
    expect(full.groups.map((g) => g.key).sort()).toEqual([taskA.id, taskB.id].sort());
    expect(full.totalMinutes).toBe(40);
  });
});
