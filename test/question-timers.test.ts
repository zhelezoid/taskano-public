import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePools, withGlobal } from '../src/db/pool.js';
import { createTask } from '../src/core/tasks.js';
import { answerQuestion, transition } from '../src/core/lifecycle.js';
import { notify } from '../src/core/notify.js';
import { tickOrg } from '../src/worker/tick.js';
import { sha256 } from '../src/core/crypto.js';
import { addPerson, inOrg, makeAgent, makeOrg, minutes, MON_10 } from './helpers.js';
import { callTool, connectClient } from './mcp-client.js';

// Вопрос без ответа 4 р.ч. эскалируется по самой реплике, а не по статусу дела (аудит архитектуры,
// CRIT): вопрос по делу из очереди (ready/rework) статус не меняет, и таймер, смотревший только на
// `blocked`, его не видел никогда.

afterAll(closePools);

const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу' };
const agentActor = (agentId: string, userId: string) => ({ kind: 'agent' as const, agentId, userId });

async function rows(orgId: string, kind: string, userId: string) {
  return (await inOrg(orgId, (db) => db.query(`select * from notifications where kind = $1 and user_id = $2 order by created_at`, [kind, userId]))).rows;
}

/** Человек с делом в «Сейчас» и вторым делом в очереди — вопрос задаётся по второму. */
async function queuedTask(authorAgent: boolean) {
  const { orgId, ownerId } = await makeOrg();
  const person = await addPerson(orgId);
  const agent = await makeAgent(orgId, ownerId);
  const actor = authorAgent ? agentActor(agent, ownerId) : { kind: 'user' as const, userId: ownerId };
  const first = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'первое', assigneeUserId: person }, actor, MON_10));
  const second = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'второе', assigneeUserId: person }, actor, MON_10));
  expect(first.status).toBe('active');
  expect(second.status).toBe('ready');
  return { orgId, ownerId, person, agent, task: second };
}

describe('вопрос без ответа по делу вне «Сейчас»', () => {
  it('вопрос по ready-делу агента → через 4 р.ч. «Решение» владельцу агента, один раз', async () => {
    const { orgId, ownerId, person, task } = await queuedTask(true);
    const asked = await inOrg(orgId, (db) => transition(db, task.id, 'question', { kind: 'user', userId: person }, { now: MON_10, text: 'где взять?' }));
    expect(asked.status).toBe('ready');

    await tickOrg(orgId, minutes(MON_10, 200));
    expect(await rows(orgId, 'question_unanswered', ownerId)).toHaveLength(0);
    await tickOrg(orgId, minutes(MON_10, 245));
    await tickOrg(orgId, minutes(MON_10, 250));
    const r = await rows(orgId, 'question_unanswered', ownerId);
    expect(r).toHaveLength(1);
    expect(r[0].task_id).toBe(task.id);
  });

  it('«Непонятно» по rework-делу человека → напоминание автору', async () => {
    const { orgId, ownerId, person, task } = await queuedTask(false);
    await inOrg(orgId, (db) => db.query(`update tasks set status = 'rework' where id = $1`, [task.id]));
    const asked = await inOrg(orgId, (db) => transition(db, task.id, 'unclear', { kind: 'user', userId: person }, { now: MON_10, text: 'что именно?' }));
    expect(asked.status).toBe('rework');
    const before = (await rows(orgId, 'task_question', ownerId)).length;

    await tickOrg(orgId, minutes(MON_10, 245));
    const after = await rows(orgId, 'task_question', ownerId);
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1).dedupe_key).toMatch(/^question_reminder:/);
  });

  it('реплика стороннего участника вопрос не закрывает — эскалация всё равно приходит', async () => {
    const { orgId, ownerId, person, task } = await queuedTask(false);
    const bystander = await addPerson(orgId);
    await inOrg(orgId, (db) => transition(db, task.id, 'question', { kind: 'user', userId: person }, { now: MON_10, text: 'где взять?' }));
    await inOrg(orgId, (db) => db.query(
      `insert into task_messages(org_id, task_id, author_user_id, kind, text, created_at)
       values (current_setting('app.org_id')::uuid, $1, $2, 'comment', 'не забудь про остатки', $3)`,
      [task.id, bystander, minutes(MON_10, 10)]));
    const before = (await rows(orgId, 'task_question', ownerId)).length;
    await tickOrg(orgId, minutes(MON_10, 245));
    expect(await rows(orgId, 'task_question', ownerId)).toHaveLength(before + 1);
  });

  it('ответ по ready-делу (путь бота) ставит answered_at и снимает эскалацию; статус не меняется', async () => {
    const { orgId, ownerId, person, task } = await queuedTask(false);
    await inOrg(orgId, (db) => transition(db, task.id, 'question', { kind: 'user', userId: person }, { now: MON_10, text: 'где взять?' }));
    const answered = await inOrg(orgId, (db) => answerQuestion(db, task.id, { kind: 'user', userId: ownerId }, 'в шкафу', minutes(MON_10, 30)));
    expect(answered.status).toBe('ready');
    const q = (await inOrg(orgId, (db) => db.query(`select answered_at from task_messages where task_id = $1 and kind = 'question'`, [task.id]))).rows[0];
    expect(q.answered_at).not.toBeNull();
    const toPerson = await rows(orgId, 'task_answer', person);
    expect(toPerson).toHaveLength(1);

    const before = (await rows(orgId, 'task_question', ownerId)).length;
    await tickOrg(orgId, minutes(MON_10, 245));
    expect(await rows(orgId, 'task_question', ownerId)).toHaveLength(before);
  });

  it('blocked-дело эскалируется один раз, как раньше; старый ключ по делу не даёт второй', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agent = await makeAgent(orgId, ownerId);
    const t = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'вопрос', assigneeUserId: person }, agentActor(agent, ownerId), MON_10));
    await inOrg(orgId, (db) => transition(db, t.id, 'take', { kind: 'user', userId: person }, { now: MON_10 }));
    await inOrg(orgId, (db) => transition(db, t.id, 'question', { kind: 'user', userId: person }, { now: MON_10, text: 'где взять?' }));

    await tickOrg(orgId, minutes(MON_10, 245));
    await tickOrg(orgId, minutes(MON_10, 250));
    await tickOrg(orgId, minutes(MON_10, 24 * 60));
    expect(await rows(orgId, 'question_unanswered', ownerId)).toHaveLength(1);

    // Эскалация, поставленная до выкатки старым ключом (`question_unanswered:<дело>`), — новой нет.
    const t2 = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'вопрос 2', assigneeUserId: person }, agentActor(agent, ownerId), MON_10));
    await inOrg(orgId, (db) => db.query(`update tasks set status = 'in_progress' where id = $1`, [t2.id]));
    await inOrg(orgId, (db) => transition(db, t2.id, 'question', { kind: 'user', userId: person }, { now: MON_10, text: 'а тут?', skipFill: true }));
    await inOrg(orgId, (db) => notify(db, { userId: ownerId, kind: 'question_unanswered', level: 'decision', taskId: t2.id, dedupeKey: `question_unanswered:${t2.id}` }));
    await tickOrg(orgId, minutes(MON_10, 24 * 60 + 5));
    const all = await rows(orgId, 'question_unanswered', ownerId);
    expect(all.filter((n) => n.task_id === t2.id)).toHaveLength(1);
  });
});

describe('answer_question (MCP) по делу из очереди', () => {
  it('ставит answered_at у вопроса, статус не меняется', async () => {
    const email = `aq-${randomUUID()}@test.local`;
    const tok = await connectClient(email);
    const code = `code-${randomUUID()}`;
    await withGlobal((db) => db.query(`insert into product_invite_codes(code_hash, note, created_by) values ($1, 'test', 'test')`, [sha256(code)]));
    const parse = (r: Awaited<ReturnType<typeof callTool>>): any => JSON.parse((r.body.result as any).content[0].text);
    const org = parse(await callTool(tok, 'create_org', { name: `Org ${randomUUID().slice(0, 6)}`, invite_code: code })).org_id as string;
    const agent = parse(await callTool(tok, 'create_agent', { org, name: `agent-${randomUUID().slice(0, 6)}` })).id as string;
    const person = await addPerson(org);
    const mk = async (title: string) => parse(await callTool(tok, 'create_task', {
      org, agent, title, assignee: person, why: 'зачем', done_criteria: 'критерий', due_date: '2026-12-31',
      description: 'как делать: открыть таблицу и свериться', idempotency_key: randomUUID(),
      source: { kind: 'chat', title: 'разговор', quote: title },
    })).id as string;
    await mk('первое');
    const second = await mk('второе');
    const st = (await inOrg(org, (db) => db.query('select status from tasks where id = $1', [second]))).rows[0].status;
    expect(st).toBe('ready');
    await inOrg(org, (db) => transition(db, second, 'question', { kind: 'user', userId: person }, { text: 'где взять?' }));

    const res = parse(await callTool(tok, 'answer_question', { org, agent, task: second, text: 'в шкафу' }));
    expect(res.status).toBe('ready');
    const q = (await inOrg(org, (db) => db.query(`select answered_at from task_messages where task_id = $1 and kind = 'question'`, [second]))).rows[0];
    expect(q.answered_at).not.toBeNull();
  });
});
