import { afterAll, describe, expect, it } from 'vitest';
import { closePools } from '../src/db/pool.js';
import { createTask } from '../src/core/tasks.js';
import { transition } from '../src/core/lifecycle.js';
import { stopTask, takeTask } from '../src/core/queue.js';
import { orgStats } from '../src/core/stats.js';
import { startTimer, timeReport } from '../src/core/time.js';
import { getBriefing } from '../src/runtime/briefing.js';
import { addPerson, inOrg, makeAgent, makeOrg, minutes, MON_10 } from './helpers.js';

// «Взять» ведёт учёт времени (спека time-tracking): смена статуса в работу и из неё пишет
// `time_entries`, из которых считают `time_report` и «Итоги».

afterAll(closePools);
const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };

async function scene() {
  const { orgId, ownerId } = await makeOrg();
  const person = await addPerson(orgId);
  const agent = await makeAgent(orgId, ownerId);
  const act = { kind: 'agent' as const, agentId: agent, userId: ownerId };
  const make = (title: string) => inOrg(orgId, (db) => createTask(db, { ...base, title, assigneeUserId: person }, act, MON_10));
  const me = { kind: 'user' as const, userId: person };
  const take = (taskId: string, at: Date) => inOrg(orgId, (db) => takeTask(db, taskId, me, { now: at }), person);
  const entries = () => inOrg(orgId, (db) => db.query(
    `select task_id, started_at, ended_at, minutes from time_entries where user_id = $1 and source = 'timer' order by started_at, id`, [person]));
  return { orgId, ownerId, person, agent, act, me, make, take, entries };
}

describe('«Взять» ведёт учёт времени', () => {
  it('взял → открытая запись по делу; остановил → закрыта с минутами', async () => {
    const s = await scene();
    const t = await s.make('t');
    await s.take(t.id, MON_10);
    let rows = (await s.entries()).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].task_id).toBe(t.id);
    expect(rows[0].started_at.toISOString()).toBe(MON_10.toISOString());
    expect(rows[0].ended_at).toBeNull();

    await inOrg(s.orgId, (db) => stopTask(db, t.id, s.person, { now: minutes(MON_10, 40) }), s.person);
    rows = (await s.entries()).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].ended_at).not.toBeNull();
    expect(rows[0].minutes).toBe(40);
  });

  it('взял другое → первая запись закрыта, вторая открыта', async () => {
    const s = await scene();
    const t1 = await s.make('t1');
    const t2 = await s.make('t2');
    await s.take(t1.id, MON_10);
    await s.take(t2.id, minutes(MON_10, 25));
    const rows = (await s.entries()).rows;
    expect(rows).toHaveLength(2);
    const first = rows.find((r) => r.task_id === t1.id);
    const second = rows.find((r) => r.task_id === t2.id);
    expect(first.minutes).toBe(25);
    expect(second.ended_at).toBeNull();
  });

  it.each([
    ['сдал', 'submit', {}],
    ['отказался (передал)', 'decline', { text: 'не моё, пусть сделает Ахмет' }],
    ['отменили', 'cancel', {}],
    ['вопрос', 'question', { text: 'где таблица?' }],
  ] as const)('%s → запись закрыта', async (_name, action, extra) => {
    const s = await scene();
    const t = await s.make('t');
    await s.take(t.id, MON_10);
    const actor = action === 'cancel' ? s.act : s.me;
    await inOrg(s.orgId, (db) => transition(db, t.id, action, actor, { ...extra, now: minutes(MON_10, 15) }), actor.userId);
    const rows = (await s.entries()).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].minutes).toBe(15);
  });

  it('таймер по другому делу, запущенный ботом, при выходе этого дела из работы не закрывается', async () => {
    const s = await scene();
    const t1 = await s.make('t1');
    const t2 = await s.make('t2');
    await s.take(t1.id, MON_10);
    // «Старт» в боте по другому делу: прежний таймер человека закрывается им самим.
    await inOrg(s.orgId, (db) => startTimer(db, s.person, t2.id, minutes(MON_10, 10)), s.person);
    await inOrg(s.orgId, (db) => stopTask(db, t1.id, s.person, { now: minutes(MON_10, 30) }), s.person);
    const rows = (await s.entries()).rows;
    const other = rows.find((r) => r.task_id === t2.id);
    expect(other.ended_at).toBeNull();
    expect(rows.find((r) => r.task_id === t1.id).minutes).toBe(10);
  });

  it('повторный «взял» по делу с уже идущим таймером — одна запись', async () => {
    const s = await scene();
    const t = await s.make('t');
    await inOrg(s.orgId, (db) => startTimer(db, s.person, t.id, MON_10), s.person);
    await s.take(t.id, minutes(MON_10, 5));
    const rows = (await s.entries()).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].started_at.toISOString()).toBe(MON_10.toISOString());
    expect(rows[0].ended_at).toBeNull();
  });

  it('time_report и «Итоги» после «взял/остановил» показывают минуты', async () => {
    const s = await scene();
    const t = await s.make('t');
    await s.take(t.id, MON_10);
    await inOrg(s.orgId, (db) => stopTask(db, t.id, s.person, { now: minutes(MON_10, 50) }), s.person);

    const report = await inOrg(s.orgId, (db) => timeReport(db, {
      userIds: [s.person], from: minutes(MON_10, -60), to: minutes(MON_10, 120), groupBy: 'task', now: minutes(MON_10, 120),
    }));
    expect(report.totalMinutes).toBe(50);
    expect(report.groups).toEqual([expect.objectContaining({ key: t.id, minutes: 50, timerMinutes: 50 })]);

    const stats = await inOrg(s.orgId, (db) => orgStats(db, {
      period: 'today', tz: 'UTC', viewerId: s.ownerId, wholeOrg: true, now: minutes(MON_10, 120),
    }), s.ownerId);
    expect(stats.totals.minutes).toBe(50);
    expect(stats.people.find((p) => p.id === s.person)!.minutes).toBe(50);
  });

  it('сводка агента не получает событий таймера от «взял/остановил»', async () => {
    const s = await scene();
    const t = await s.make('t');
    await s.take(t.id, MON_10);
    await inOrg(s.orgId, (db) => stopTask(db, t.id, s.person, { now: minutes(MON_10, 20) }), s.person);

    const timerEvents = await inOrg(s.orgId, (db) => db.query(
      `select type from events where task_id = $1 and type like 'timer_%'`, [t.id]));
    expect(timerEvents.rowCount).toBe(0);
    const brief = await inOrg(s.orgId, (db) => getBriefing(db, minutes(MON_10, 30)));
    const types = brief.agents.find((a) => a.id === s.agent)!.events.map((e) => e.type);
    expect(types.filter((x) => x.startsWith('timer_'))).toEqual([]);
  });
});
