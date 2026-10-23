import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closePools, withGlobal, withOrg } from '../src/db/pool.js';
import { createTask } from '../src/core/tasks.js';
import { addSource } from '../src/core/sources.js';
import { transition } from '../src/core/lifecycle.js';
import { ensurePersonalOrg } from '../src/core/people.js';
import { setTaskShare } from '../src/core/sharing.js';
import { getBriefing } from '../src/runtime/briefing.js';
import { addPerson, makeAgent, makeOrg, minutes, MON_10 } from './helpers.js';

afterAll(closePools);

describe('изоляция организаций (core-data-model)', () => {
  it('организация A не видит данные B и не может писать в B', async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    const agentB = await makeAgent(b.orgId, b.ownerId);
    const personB = await addPerson(b.orgId);
    await withOrg(b.orgId, (db) => createTask(db, {
      title: 'секрет B', description: 'как делать: держать материал внутри организации B, наружу не выносить', why: 'w', doneCriteria: 'c', dueDate: '2026-09-22', assigneeUserId: personB,
    }, { kind: 'agent', agentId: agentB, userId: b.ownerId }, MON_10));

    const tables = (await withOrg(a.orgId, (db) => db.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity`))).rows.map((r) => r.relname as string);
    expect(tables.length).toBeGreaterThan(20);
    for (const t of tables) {
      const n = await withOrg(a.orgId, (db) => db.query(`select count(*)::int as n from ${t} where org_id = $1`, [b.orgId]));
      expect(n.rows[0].n, `таблица ${t}`).toBe(0);
    }
    await expect(withOrg(a.orgId, (db) => db.query(
      `insert into agents(org_id, name, owner_user_id) values ($1, 'x', $2)`, [b.orgId, b.ownerId]))).rejects.toThrow(/row-level security/);
  });

  it('каждая таблица слоя организации имеет org_id и FORCE RLS; роль app без BYPASSRLS', async () => {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const declared = (await c.query(`select obj_description('public'::regnamespace) as d`)).rows[0].d.replace('org-layer: ', '').split(' ');
    const rows = (await c.query(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity,
              exists(select 1 from information_schema.columns col where col.table_name = c.relname and col.column_name = 'org_id') as has_org
         from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'`)).rows;
    const byName = new Map(rows.map((r) => [r.relname, r]));
    for (const t of declared) {
      const r = byName.get(t);
      expect(r, t).toBeTruthy();
      expect(r.relrowsecurity && r.relforcerowsecurity && r.has_org, t).toBe(true);
    }
    // Любая таблица с org_id и без RLS — только из явного глобального списка.
    const GLOBAL_WITH_ORG = new Set(['bots', 'runner_links', 'memberships', 'group_links', 'agent_tokens']);
    for (const r of rows) if (r.has_org && !r.relrowsecurity) expect(GLOBAL_WITH_ORG.has(r.relname), r.relname).toBe(true);
    const role = (await c.query(`select rolbypassrls from pg_roles where rolname = 'taskano_app'`)).rows[0];
    expect(role.rolbypassrls).toBe(false);
    await c.end();
  });

  // Спека owner-feedback: пометка «рабочее» открывает личное дело ровно одной названной организации.
  it('чужая организация не видит ни непомеченных личных дел, ни помеченных для другой компании', async () => {
    const a = await makeOrg();
    const c = await makeOrg(a.ownerId);              // вторая компания того же человека
    const b = await makeOrg();                        // чужая компания, чужой владелец
    const personalOrg = await withGlobal((db) => ensurePersonalOrg(db, a.ownerId));
    const actor = { kind: 'user' as const, userId: a.ownerId };
    const marked = await withOrg(personalOrg, (db) => createTask(db, { title: 'помечено для A', assigneeUserId: a.ownerId }, actor, MON_10));
    const plain = await withOrg(personalOrg, (db) => createTask(db, { title: 'без пометки', assigneeUserId: a.ownerId }, actor, MON_10));
    await withOrg(personalOrg, (db) => setTaskShare(db, marked.id, a.ownerId, a.orgId));
    for (const id of [marked.id, plain.id]) {
      await withOrg(personalOrg, (db) => transition(db, id, 'submit', actor, { now: MON_10 }));
    }

    const seen = async (orgId: string) => (await withOrg(orgId, (db) => getBriefing(db, minutes(MON_10, 1))))
      .owner_activity.done.map((x) => x.task);
    expect(await seen(a.orgId)).toEqual([marked.id]);
    expect(await seen(c.orgId)).toEqual([]);
    expect(await seen(b.orgId)).toEqual([]);
  });

  // Спека task-context: источники дела — материалы организации, чужой они не видны.
  it('чужая организация не видит источников дела (task_sources)', async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    const agentB = await makeAgent(b.orgId, b.ownerId);
    const personB = await addPerson(b.orgId);
    const taskB = await withOrg(b.orgId, (db) => createTask(db, {
      title: 'секрет B', description: 'как делать: держать материал внутри организации B, наружу не выносить', why: 'w', doneCriteria: 'c', dueDate: '2026-09-22', assigneeUserId: personB,
    }, { kind: 'agent', agentId: agentB, userId: b.ownerId }, MON_10));
    await withOrg(b.orgId, (db) => addSource(db, {
      taskId: taskB.id, kind: 'external', title: 'Linear EXT-1', system: 'linear', externalId: `EXT-${taskB.short_id}`,
      quote: 'слова людей организации B',
    }, { kind: 'agent', agentId: agentB, userId: b.ownerId }, MON_10));

    const seen = async (orgId: string) => (await withOrg(orgId, (db) => db.query('select count(*)::int as n from task_sources'))).rows[0].n;
    expect(await seen(b.orgId)).toBe(1);
    expect(await seen(a.orgId)).toBe(0);
    // И по ключу внешней системы — тоже ничего (так ищет find_task с external).
    const byExternal = await withOrg(a.orgId, (db) => db.query(
      'select count(*)::int as n from task_sources where system = $1 and external_id = $2', ['linear', `EXT-${taskB.short_id}`]));
    expect(byExternal.rows[0].n).toBe(0);
  });

  it('запрос вне withOrg не видит строк слоя организации', async () => {
    const a = await makeOrg();
    await makeAgent(a.orgId, a.ownerId);
    const { withGlobal } = await import('../src/db/pool.js');
    const n = await withGlobal((db) => db.query('select count(*)::int as n from agents'));
    expect(n.rows[0].n).toBe(0);
  });
});
