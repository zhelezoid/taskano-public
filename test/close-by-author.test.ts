import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import './helpers.js';
import { closePools } from '../src/db/pool.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { createTask } from '../src/core/tasks.js';
import { notificationText, type NotifRow } from '../src/bot/notif-text.js';
import type { Task } from '../src/core/types.js';
import { addPerson, inOrg, makeAgent, makeOrg, MON_10 } from './helpers.js';

// Сделанное, но не сданное дело постановщик закрывает сам — с доказательством.
// Было: NOR-023 давно выполнено, а кнопку «Завершить» исполнитель не нажал, и закрыть его было нечем,
// кроме отмены (в «Итогах» — «отменено», а не «сделано»).

afterAll(closePools);

async function call(userId: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: any }> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildMcpServer({ userId }).connect(serverT);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientT);
  const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text: string }[] };
  return { isError: !!r.isError, data: JSON.parse(r.content[0]!.text) };
}

const base = { why: 'зачем', doneCriteria: 'неделю переписка идёт с рабочего ящика', dueDate: '2026-12-31', description: 'как делать: писать поставщикам только с рабочего ящика' };
const EVIDENCE = 'В CRM вся переписка с поставщиками за неделю — с рабочего ящика';

async function world() {
  const { orgId, ownerId } = await makeOrg();
  const authorId = await addPerson(orgId, 'member');
  const workerId = await addPerson(orgId, 'member');
  const agentId = await makeAgent(orgId, ownerId);
  const task = await inOrg(orgId, (db) => createTask(
    db, { ...base, title: 'вести переписку с рабочего ящика', assigneeUserId: workerId },
    { kind: 'user', userId: authorId }, MON_10)) as Task;
  return { orgId, ownerId, authorId, workerId, agentId, task };
}

describe('закрыть несданное дело как сделанное', () => {
  it('постановщик закрывает с доказательством: сделано, исполнитель узнаёт, по чему', async () => {
    const w = await world();
    expect(w.task.status).not.toBe('submitted');

    const r = await call(w.authorId, 'review_result', { org: w.orgId, task: w.task.id, evidence: EVIDENCE });
    expect(r.isError).toBe(false);
    expect(r.data.status).toBe('done');

    // Сделано по событию приёмки — «Итоги» и сводка агента считают его выполненным, а не отменённым.
    const ev = await inOrg(w.orgId, (db) => db.query(
      `select type, data from events where task_id = $1 order by id desc limit 1`, [w.task.id]));
    expect(ev.rows[0].type).toBe('task_accepted');
    expect(ev.rows[0].data.closed_by_author).toBe(true);

    const n = await inOrg(w.orgId, (db) => db.query(
      `select id, kind, task_id, level, payload, created_at from notifications where user_id = $1 and kind = 'task_closed'`, [w.workerId]));
    expect(n.rowCount).toBe(1);
    const text = await inOrg(w.orgId, (db) => notificationText(db, 'ru', n.rows[0] as NotifRow, w.workerId));
    expect(text).toContain('закрыта как выполненная');
    expect(text).toContain(EVIDENCE);
  });

  it('без доказательства не закрывается', async () => {
    const w = await world();
    const r = await call(w.authorId, 'review_result', { org: w.orgId, task: w.task.id });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe('validation_failed');
    const st = await inOrg(w.orgId, (db) => db.query(`select status from tasks where id = $1`, [w.task.id]));
    expect(st.rows[0].status).not.toBe('done');
  });

  it('агент сам не закрывает — только предлагает постановщику', async () => {
    const w = await world();
    const own = await inOrg(w.orgId, (db) => createTask(
      db, { ...base, title: 'дело от агента', assigneeUserId: w.workerId },
      { kind: 'agent', agentId: w.agentId, userId: w.ownerId }, MON_10)) as Task;

    const r = await call(w.ownerId, 'review_result', { org: w.orgId, agent: w.agentId, task: own.id, evidence: EVIDENCE });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe('forbidden');
  });

  it('дело агента закрывает его хозяин — сам, без agent', async () => {
    const w = await world();
    const own = await inOrg(w.orgId, (db) => createTask(
      db, { ...base, title: 'дело от агента', assigneeUserId: w.workerId },
      { kind: 'agent', agentId: w.agentId, userId: w.ownerId }, MON_10)) as Task;

    const r = await call(w.ownerId, 'review_result', { org: w.orgId, task: own.id, evidence: EVIDENCE });
    expect(r.isError).toBe(false);
    expect(r.data.status).toBe('done');
  });

  it('доказательство у сданного дела — ошибка, а не молчаливый пропуск', async () => {
    const w = await world();
    await inOrg(w.orgId, (db) => db.query(`update tasks set status = 'submitted', submitted_at = now() where id = $1`, [w.task.id]));
    const r = await call(w.authorId, 'review_result', { org: w.orgId, task: w.task.id, evidence: EVIDENCE });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe('validation_failed');
  });

  it('владелец компании за постановщика не закрывает', async () => {
    const w = await world();
    const r = await call(w.ownerId, 'review_result', { org: w.orgId, task: w.task.id, evidence: EVIDENCE });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe('forbidden');
  });
});
