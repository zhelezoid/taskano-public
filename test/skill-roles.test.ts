import { afterAll, describe, expect, it } from 'vitest';
import { closePools } from '../src/db/pool.js';
import { createTask } from '../src/core/tasks.js';
import { transition } from '../src/core/lifecycle.js';
import { orgStats } from '../src/core/stats.js';
import { addPerson, inOrg, makeOrg, MON_10 } from './helpers.js';

// Своё дело (поставил себе сам, без агента) закрывается сдачей: принять его некому (спека
// skill-roles). Раньше оно навсегда оставалось «сдано» и не попадало в «Итоги».

afterAll(closePools);

const base = {
  why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: по шагам',
};

describe('своё дело — сразу «сделано»', () => {
  it('сдача своего дела компании закрывает его и считается сделанным в «Итогах»', async () => {
    const { orgId, ownerId } = await makeOrg();
    const me = { kind: 'user' as const, userId: ownerId };
    const task = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'своё дело', assigneeUserId: ownerId }, me, MON_10));
    const now = new Date(MON_10.getTime() + 3600_000);
    const done = await inOrg(orgId, (db) => transition(db, task.id, 'submit', me, { now }));
    expect(done.status).toBe('done');

    const ev = await inOrg(orgId, (db) => db.query(
      `select type, data from events where task_id = $1 and type = 'task_accepted'`, [task.id]));
    expect(ev.rowCount).toBe(1);
    expect(ev.rows[0].data.self).toBe(true);

    const stats = await inOrg(orgId, (db) => orgStats(db, {
      period: 'today', tz: 'UTC', viewerId: ownerId, wholeOrg: true, now: new Date(now.getTime() + 60_000),
    }));
    expect(stats.totals.done).toBe(1);
    expect(stats.totals.submitted).toBe(0);
  });

  it('дело, поставленное другим человеком, после сдачи ждёт приёмки', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const task = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'чужое дело', assigneeUserId: person },
      { kind: 'user', userId: ownerId }, MON_10));
    const after = await inOrg(orgId, (db) => transition(db, task.id, 'submit', { kind: 'user', userId: person },
      { now: new Date(MON_10.getTime() + 3600_000) }));
    expect(after.status).toBe('submitted');
  });
});
