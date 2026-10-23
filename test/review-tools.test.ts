import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import './helpers.js';
import { closePools, withGlobal } from '../src/db/pool.js';
import { addMember, ensureUserByEmail } from '../src/core/people.js';
import { createTask } from '../src/core/tasks.js';
import { transition } from '../src/core/lifecycle.js';
import { sha256 } from '../src/core/crypto.js';
import { connectClient, callTool } from './mcp-client.js';
import { inOrg, MON_10 } from './helpers.js';

// Инструменты ревью (src/mcp/tools/review.ts, спека agent-runtime «review_person/get_changes_since/
// agent_metrics/agent_notes»): проверяем через MCP, данные готовим напрямую ядром (как в runtime.test.ts).

afterAll(closePools);

async function insertInviteCode(): Promise<string> {
  const code = randomUUID();
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query(`insert into product_invite_codes(code_hash, note, created_by) values ($1, 'test', 'test')`, [sha256(code)]);
  await client.end();
  return code;
}

/** Участник организации, у которого нет MCP-токена, — данные готовятся напрямую ядром. */
async function addExistingMember(orgId: string, email: string, role: 'member' | 'owner' | 'admin' = 'member'): Promise<string> {
  return withGlobal(async (db) => {
    const { user } = await ensureUserByEmail(db, email, { verified: true });
    await addMember(db, orgId, user.id, role);
    return user.id as string;
  });
}

function parse(r: Awaited<ReturnType<typeof callTool>>): any {
  return JSON.parse(r.body.result.content[0].text);
}

const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };

describe('MCP: инструменты ревью (review_person / get_changes_since / agent_metrics / agent_notes)', () => {
  let ownerToken: string;
  let orgId: string;
  let ownerId: string;
  let agentId: string;
  let personEmail: string;
  let personId: string;

  beforeAll(async () => {
    const ownerEmail = `owner-${randomUUID()}@test.local`;
    ownerToken = await connectClient(ownerEmail);
    const code = await insertInviteCode();
    const org = await callTool(ownerToken, 'create_org', { name: `Org ${randomUUID().slice(0, 6)}`, invite_code: code });
    orgId = parse(org).org_id as string;
    ownerId = (await withGlobal((db) => db.query('select owner_user_id from orgs where id = $1', [orgId]))).rows[0].owner_user_id;

    const agentRes = await callTool(ownerToken, 'create_agent', { org: orgId, name: `agent-${randomUUID().slice(0, 6)}` });
    agentId = parse(agentRes).id as string;

    personEmail = `person-${randomUUID()}@test.local`;
    personId = await addExistingMember(orgId, personEmail);
  });

  it('review_person: вопрос человека приходит как untrusted, второй вызов не повторяет те же changes', async () => {
    // Ставим агенту вопрос по задаче человека — как в runtime.test.ts::raiseQuestion.
    const actor = { kind: 'agent' as const, agentId, userId: ownerId };
    const taskId = await inOrg(orgId, async (db) => {
      const t = await createTask(db, { ...base, title: 'ревью-вопрос', assigneeUserId: personId }, actor, MON_10);
      await transition(db, t.id, 'take', { kind: 'user', userId: personId }, { now: MON_10 });
      await transition(db, t.id, 'question', { kind: 'user', userId: personId }, { now: MON_10, text: 'где взять доступ?' });
      return t.id;
    });

    const r1 = await callTool(ownerToken, 'review_person', { org: orgId, agent: agentId, person: personEmail });
    expect(r1.body.result.isError).toBeFalsy();
    const body1 = parse(r1);
    expect(body1.open_questions).toHaveLength(1);
    expect(body1.open_questions[0]).toMatchObject({ task_id: taskId, question: { untrusted: true, text: 'где взять доступ?' } });
    expect(body1.changes_since_last_review.length).toBeGreaterThan(0);
    const questionChange = body1.changes_since_last_review.find((c: any) => c.type === 'question');
    expect(questionChange.data.text).toEqual({ untrusted: true, text: 'где взять доступ?' });

    // Курсор ревью сдвинулся — повторный вызов без новых событий не должен вернуть те же changes.
    const r2 = await callTool(ownerToken, 'review_person', { org: orgId, agent: agentId, person: personEmail });
    const body2 = parse(r2);
    expect(body2.changes_since_last_review).toHaveLength(0);
    // Открытый вопрос остаётся текущим состоянием — не событием, поэтому виден снова.
    expect(body2.open_questions).toHaveLength(1);
  });

  it('review_person: участник без прав на агента (не владелец агента) получает forbidden', async () => {
    const otherEmail = `member-${randomUUID()}@test.local`;
    await addExistingMember(orgId, otherEmail);
    const otherToken = await connectClient(otherEmail);
    const r = await callTool(otherToken, 'review_person', { org: orgId, agent: agentId, person: personEmail });
    expect(r.body.result.isError).toBe(true);
    expect(parse(r).code).toBe('forbidden');
  });

  it('get_changes_since: hasMore/cursor присутствуют, текст людей — untrusted', async () => {
    const r = await callTool(ownerToken, 'get_changes_since', { org: orgId, agent: agentId });
    expect(r.body.result.isError).toBeFalsy();
    const body = parse(r);
    expect(typeof body.hasMore).toBe('boolean');
    expect(body.cursor).toMatch(/^\d+:\d+$/);
    expect(Array.isArray(body.events)).toBe(true);
    const questionEvent = body.events.find((e: any) => e.type === 'question');
    expect(questionEvent).toBeTruthy();
    expect(questionEvent.data.text).toEqual({ untrusted: true, text: 'где взять доступ?' });
  });

  it('agent_metrics: одна принятая задача — accepted_pct 100, в ответе нет id человека', async () => {
    const actor = { kind: 'agent' as const, agentId, userId: ownerId };
    await inOrg(orgId, async (db) => {
      const t = await createTask(db, { ...base, title: 'ревью-метрика', assigneeUserId: personId }, actor, MON_10);
      await transition(db, t.id, 'take', { kind: 'user', userId: personId }, { now: MON_10 });
      await transition(db, t.id, 'submit', { kind: 'user', userId: personId }, { now: MON_10, result: { text: 'готово' } });
      return t.id;
    });
    const accepted = await callTool(ownerToken, 'review_result', { org: orgId, agent: agentId, task: (await inOrg(orgId, (db) => db.query(
      `select id from tasks where assignee_user_id = $1 and title = 'ревью-метрика'`, [personId],
    ))).rows[0].id });
    expect(accepted.body.result.isError).toBeFalsy();

    const r = await callTool(ownerToken, 'agent_metrics', { org: orgId, agent: agentId });
    expect(r.body.result.isError).toBeFalsy();
    const body = parse(r);
    expect(body.accepted_pct).toBe(100);
    expect(JSON.stringify(body)).not.toContain(personId);
  });

  it('set_agent_note / get_agent_notes: запись и чтение', async () => {
    const set = await callTool(ownerToken, 'set_agent_note', { org: orgId, agent: agentId, key: 'style', value: 'коротко и по делу' });
    expect(set.body.result.isError).toBeFalsy();

    const get = await callTool(ownerToken, 'get_agent_notes', { org: orgId, agent: agentId });
    expect(get.body.result.isError).toBeFalsy();
    const notes = parse(get) as { key: string; value: string }[];
    expect(notes.find((n) => n.key === 'style')).toMatchObject({ key: 'style', value: 'коротко и по делу' });
  });
});
