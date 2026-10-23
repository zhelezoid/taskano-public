import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closePools, withOrg } from '../src/db/pool.js';
import { readEvents, ZERO_CURSOR } from '../src/core/events.js';
import { makeOrg, waitForEvents } from './helpers.js';

afterAll(closePools);

async function client(orgId: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_APP_URL });
  await c.connect();
  await c.query('begin');
  await c.query(`select set_config('app.org_id', $1, true)`, [orgId]);
  return c;
}
const insert = (c: pg.Client, type: string) =>
  c.query(`insert into events(org_id, type) values (current_setting('app.org_id')::uuid, $1)`, [type]);

describe('курсор событий без потерь', () => {
  it('события, закоммиченные в обратном порядке, читаются все ровно один раз', async () => {
    const { orgId } = await makeOrg();
    const t1 = await client(orgId);
    const t2 = await client(orgId);
    await insert(t1, 'first');               // меньший id, но коммит позже
    await insert(t2, 'second');
    await t2.query('commit');

    const seen: string[] = [];
    let cursor = ZERO_CURSOR;
    const read = async () => {
      const r = await withOrg(orgId, (db) => readEvents(db, cursor));
      seen.push(...r.events.map((e) => e.type));
      cursor = r.cursor;
    };
    await read();                            // t1 ещё открыта — second не должен уйти вперёд first
    expect(seen).toEqual([]);
    await t1.query('commit');
    // Горизонт видимости общий на весь кластер: транзакции соседнего прогона (другая тестовая
    // база) держат его позади — ждём ровно закоммиченного, а не проверяемого.
    await waitForEvents(orgId);
    await read();
    await read();
    expect(seen.sort()).toEqual(['first', 'second']);
    await t1.end();
    await t2.end();
  });

  it('фильтр по агенту двигает курсор и по чужим событиям', async () => {
    const { orgId } = await makeOrg();
    await withOrg(orgId, (db) => db.query(`insert into events(org_id, type) values ($1, 'x'), ($1, 'y')`, [orgId]));
    await waitForEvents(orgId);
    const r = await withOrg(orgId, (db) => readEvents(db, ZERO_CURSOR, { agentId: '00000000-0000-0000-0000-000000000000' }));
    expect(r.events).toHaveLength(0);
    expect(r.cursor).not.toBe(ZERO_CURSOR);
  });
});
