import { afterAll, describe, expect, it } from 'vitest';
import { closePools } from '../src/db/pool.js';
import { createPlan, createTask } from '../src/core/tasks.js';
import { takeTask, pickNext } from '../src/core/queue.js';
import { transition } from '../src/core/lifecycle.js';
import { addPerson, inOrg, makeAgent, makeOrg, MON_10, minutes } from './helpers.js';

afterAll(closePools);

const agentActor = (agentId: string, userId: string) => ({ kind: 'agent' as const, agentId, userId });
const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };

async function holders(orgId: string, userId: string) {
  return inOrg(orgId, async (db) => (await db.query(
    `select id, author_agent_id from tasks where assignee_user_id = $1 and status in ('active','in_progress')`, [userId])).rows);
}

describe('очередь человека', () => {
  it('три агента — в каждый момент ровно одна задача в «Сейчас»', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agents = [await makeAgent(orgId, ownerId), await makeAgent(orgId, ownerId), await makeAgent(orgId, ownerId)];
    for (const a of agents) for (let i = 0; i < 3; i++) {
      await inOrg(orgId, (db) => createTask(db, { ...base, title: `t${i}`, assigneeUserId: person }, agentActor(a, ownerId), MON_10));
      expect(await holders(orgId, person)).toHaveLength(1);
    }
    const h = (await holders(orgId, person))[0]!;
    await inOrg(orgId, (db) => transition(db, h.id, 'submit', { kind: 'user', userId: person }, { now: minutes(MON_10, 5) }));
    expect(await holders(orgId, person)).toHaveLength(1);
  });

  it('квоты 60/40 при равной длительности дают 6 и 4 из 10', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const A = await makeAgent(orgId, ownerId);
    const B = await makeAgent(orgId, ownerId);
    await inOrg(orgId, (db) => db.query(
      `insert into queue_settings(org_id, user_id, quotas) values ($1, $2, $3)`, [orgId, person, { [A]: 60, [B]: 40 }]));
    for (const a of [A, B]) for (let i = 0; i < 10; i++) {
      await inOrg(orgId, (db) => createTask(db, { ...base, title: `t${i}`, assigneeUserId: person }, agentActor(a, ownerId), MON_10));
    }
    // Первая выдача случилась при создании (истории нет) — от неё и считаем.
    const picks: string[] = [];
    let now = minutes(MON_10, 1);
    for (let i = 0; i < 10; i++) {
      const h = (await holders(orgId, person))[0]!;
      picks.push(h.author_agent_id === A ? 'A' : 'B');
      await inOrg(orgId, (db) => takeTask(db, h.id, { kind: 'user', userId: person }, { now }));
      now = minutes(now, 30);
      await inOrg(orgId, (db) => transition(db, h.id, 'submit', { kind: 'user', userId: person }, { now }));
      now = minutes(now, 1);
    }
    expect(picks.filter((p) => p === 'A')).toHaveLength(6);
    expect(picks.filter((p) => p === 'B')).toHaveLength(4);
  });

  it('pickNext: срочное первым, затем срок сегодня', () => {
    const c = (id: string, extra: Partial<Parameters<typeof pickNext>[0][number]> = {}) => ({
      id, direction: 'a', priority: 'normal' as const, due_date: null, plan_created_at: 0, position: 0, created_at: 0, ...extra });
    expect(pickNext([c('x'), c('u', { priority: 'urgent' })], { today: '2026-09-21', quotas: {}, history: {} })!.id).toBe('u');
    expect(pickNext([c('x'), c('d', { due_date: '2026-09-21' })], { today: '2026-09-21', quotas: {}, history: {} })!.id).toBe('d');
  });

  it('автопилот выдаёт следующий draft с auto_release_ok; без флага — событие person_idle', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agent = await makeAgent(orgId, ownerId);
    const act = agentActor(agent, ownerId);
    const plan = await inOrg(orgId, (db) => createPlan(db, agent, 'цель', act));
    const s1 = await inOrg(orgId, (db) => createTask(db, { ...base, title: 's1', assigneeUserId: person, planId: plan.id, release: true }, act, MON_10));
    await inOrg(orgId, (db) => createTask(db, { ...base, title: 's2', assigneeUserId: person, planId: plan.id, autoReleaseOk: true }, act, MON_10));
    const s3 = await inOrg(orgId, (db) => createTask(db, { ...base, title: 's3', assigneeUserId: person, planId: plan.id }, act, MON_10));
    expect(s1.status).toBe('active');

    await inOrg(orgId, (db) => transition(db, s1.id, 'submit', { kind: 'user', userId: person }, { now: minutes(MON_10, 10) }));
    const h = await holders(orgId, person);
    expect(h).toHaveLength(1);
    await inOrg(orgId, (db) => transition(db, h[0]!.id, 'submit', { kind: 'user', userId: person }, { now: minutes(MON_10, 20) }));
    const s3Now = await inOrg(orgId, (db) => db.query('select status from tasks where id = $1', [s3.id]));
    expect(s3Now.rows[0].status).toBe('draft');
    const idle = await inOrg(orgId, (db) => db.query(`select count(*)::int as n from events where type = 'person_idle' and agent_id = $1`, [agent]));
    expect(idle.rows[0].n).toBe(1);
  });

  it('«Взял» на пункте из очереди возвращает прежний «Сейчас» в очередь', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agent = await makeAgent(orgId, ownerId);
    const t1 = await inOrg(orgId, (db) => createTask(db, { ...base, title: 't1', assigneeUserId: person }, agentActor(agent, ownerId), MON_10));
    const t2 = await inOrg(orgId, (db) => createTask(db, { ...base, title: 't2', assigneeUserId: person }, agentActor(agent, ownerId), MON_10));
    expect(t1.status).toBe('active');
    await inOrg(orgId, (db) => takeTask(db, t2.id, { kind: 'user', userId: person }, { now: minutes(MON_10, 3) }));
    const st = await inOrg(orgId, (db) => db.query('select id, status from tasks where id = any($1::uuid[])', [[t1.id, t2.id]]));
    const map = Object.fromEntries(st.rows.map((r) => [r.id, r.status]));
    expect(map[t1.id]).toBe('ready');
    expect(map[t2.id]).toBe('in_progress');
  });
});

describe('ревью ядра — регрессии', () => {
  const c = (id: string, direction: string) => ({ id, direction, priority: 'normal' as const, due_date: null, plan_created_at: 0, position: 0, created_at: 0 });

  it('направление без явной квоты не голодает', () => {
    const picks = new Set<string>();
    const history: Record<string, number> = {};
    for (let i = 0; i < 20; i++) {
      const p = pickNext([c('a', 'A'), c('b', 'B')], { today: '2026-09-21', quotas: { A: 100 }, history })!;
      picks.add(p.direction);
      history[p.direction] = (history[p.direction] ?? 0) + 1;
    }
    expect(picks.has('B')).toBe(true);
  });

  it('вопрос по задаче из очереди не даёт второй «Сейчас»', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agent = await makeAgent(orgId, ownerId);
    const act = agentActor(agent, ownerId);
    await inOrg(orgId, (db) => createTask(db, { ...base, title: 'z', assigneeUserId: person }, act, MON_10));
    const y = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'y', assigneeUserId: person }, act, MON_10));
    const after = await inOrg(orgId, (db) => transition(db, y.id, 'unclear', { kind: 'user', userId: person }, { now: MON_10, text: '?' }));
    expect(after.status).toBe('ready');
    const n = await inOrg(orgId, (db) => db.query(`select count(*)::int as n from tasks where assignee_user_id = $1 and status in ('active','in_progress','blocked')`, [person]));
    expect(n.rows[0].n).toBe(1);
  });

  it('возвращённая на доработку задача снова попадает в «Сейчас»', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agent = await makeAgent(orgId, ownerId);
    const act = agentActor(agent, ownerId);
    const t = await inOrg(orgId, (db) => createTask(db, { ...base, title: 't', assigneeUserId: person }, act, MON_10));
    await inOrg(orgId, (db) => transition(db, t.id, 'submit', { kind: 'user', userId: person }, { now: MON_10 }));
    const r = await inOrg(orgId, (db) => transition(db, t.id, 'rework', act, { now: minutes(MON_10, 5), text: 'нет фото' }));
    expect(r.status).toBe('active');
  });
});
