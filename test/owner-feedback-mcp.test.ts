import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import './helpers.js';
import { makeAgent } from './helpers.js';
import { closePools, withGlobal } from '../src/db/pool.js';
import { sha256 } from '../src/core/crypto.js';
import { connectClient, callTool } from './mcp-client.js';

async function insertInviteCode(): Promise<string> {
  const code = `code-${randomUUID()}`;
  await withGlobal((db) => db.query(
    `insert into product_invite_codes(code_hash, note, created_by) values ($1, 'test', 'test')`, [sha256(code)]));
  return code;
}

function parse(r: Awaited<ReturnType<typeof callTool>>): any {
  return JSON.parse((r.body.result as any).content[0].text);
}

afterAll(async () => { await closePools(); });

// Помеченное «рабочее» личное дело (спека owner-feedback): агент читает его в сводке и только.
describe('пометка «рабочее»: агент не пишет в личное дело', () => {
  it('comment_task, answer_question и propose_change(close_task) по помеченному делу → forbidden', async () => {
    const email = `share-${randomUUID()}@test.local`;
    const tok = await connectClient(email);
    const code = await insertInviteCode();
    const org = parse(await callTool(tok, 'create_org', { name: `Org ${randomUUID().slice(0, 6)}`, invite_code: code })).org_id as string;
    const item = parse(await callTool(tok, 'create_task', { org: 'personal', title: 'дело про бизнес', share_with: org, idempotency_key: randomUUID() }));
    const task = item.id as string;
    const ownerId = (await withGlobal((db) => db.query('select owner_user_id from orgs where id = $1', [org]))).rows[0].owner_user_id as string;
    // Агент в личном пространстве владельца: именно он может дотянуться до помеченного дела.
    const agent = await makeAgent(item.org_id as string, ownerId);
    const comment = await callTool(tok, 'comment_task', { org: 'personal', agent, task, text: 'от агента' });
    expect(JSON.stringify(comment.body.result)).toContain('forbidden');
    const answer = await callTool(tok, 'answer_question', { org: 'personal', agent, task, text: 'ответ' });
    expect(JSON.stringify(answer.body.result)).toContain('forbidden');
    const close = await callTool(tok, 'propose_change', { org: 'personal', agent, type: 'close_task', task, summary: 'закрыть' });
    expect(JSON.stringify(close.body.result)).toContain('forbidden');
  });

  it('adopt_task: агент берёт задачу человека под ведение и может её править; личное помеченное — forbidden', async () => {
    const email = `adopt-${randomUUID()}@test.local`;
    const tok = await connectClient(email);
    const code = await insertInviteCode();
    const org = parse(await callTool(tok, 'create_org', { name: `Org ${randomUUID().slice(0, 6)}`, invite_code: code })).org_id as string;
    const agent = parse(await callTool(tok, 'create_agent', { org, name: `agent-${randomUUID().slice(0, 6)}` })).id as string;

    const task = parse(await callTool(tok, 'create_task', {
      org, title: 'Позвонить в банк', assignee: email, description: 'как делать: позвонить по номеру из договора и спросить остаток',
      why: 'зачем', done_criteria: 'критерий',
      due_date: '2026-12-31', idempotency_key: randomUUID(),
      source: { kind: 'chat', title: 'разговор', quote: 'надо позвонить в банк' },
    })).id as string;
    // До усыновления агент не автор — править нельзя.
    const before = await callTool(tok, 'update_task', { org, agent, task, why: 'новая причина' });
    expect(JSON.stringify(before.body.result)).toContain('forbidden');

    const adopted = parse(await callTool(tok, 'adopt_task', { org, agent, task }));
    expect(adopted.author_agent_id).toBe(agent);
    const after = await callTool(tok, 'update_task', { org, agent, task, why: 'новая причина' });
    expect((after.body.result as any).isError).toBeFalsy();
    // Повторное усыновление — conflict.
    const again = await callTool(tok, 'adopt_task', { org, agent, task });
    expect(JSON.stringify(again.body.result)).toContain('conflict');

    const item = parse(await callTool(tok, 'create_task', { org: 'personal', title: 'личное про бизнес', share_with: org, idempotency_key: randomUUID() }));
    const personalAgent = await makeAgent(item.org_id as string, (await withGlobal((db) => db.query('select owner_user_id from orgs where id = $1', [org]))).rows[0].owner_user_id as string);
    const shared = await callTool(tok, 'adopt_task', { org: 'personal', agent: personalAgent, task: item.id });
    expect(JSON.stringify(shared.body.result)).toContain('forbidden');
  });
});
