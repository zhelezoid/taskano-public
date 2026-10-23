import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closePools } from '../src/db/pool.js';
import { createTask } from '../src/core/tasks.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { addHumanComment } from '../src/core/comments.js';
import { addPerson, inOrg, makeAgent, makeOrg, MON_10, uniq } from './helpers.js';

// Аудит безопасности 07.10: через коннектор участник и гость видят только дела, к
// которым причастны, — как в боте и приложении. Владелец видит любое.

afterAll(closePools);

async function mcp(userId: string): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildMcpServer({ userId }).connect(serverT);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientT);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; body: any }> {
  const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
  return { isError: r.isError, body: JSON.parse(r.content[0]!.text) };
}

const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать', source: { title: 'разговор' } };

describe('коннектор: досье только причастным', () => {
  it('участник не видит чужое дело ни в get_task, ни в find_task; своё и владельцу — видно', async () => {
    const { orgId, ownerId } = await makeOrg();
    const a = await addPerson(orgId, 'member');
    const b = await addPerson(orgId, 'member');
    const word = `секрет${uniq()}`;
    const theirs = await inOrg(orgId, (db) => createTask(db, { ...base, title: `переговоры ${word}`, assigneeUserId: b },
      { kind: 'user', userId: ownerId }, MON_10), ownerId);
    const mine = await inOrg(orgId, (db) => createTask(db, { ...base, title: `моё ${word}`, assigneeUserId: a },
      { kind: 'user', userId: ownerId }, MON_10), ownerId);

    const member = await mcp(a);
    const peek = await call(member, 'get_task', { org: orgId, task: theirs.id });
    expect(peek.isError).toBe(true);
    expect(peek.body.code).toBe('not_found');
    const own = await call(member, 'get_task', { org: orgId, task: mine.id });
    expect(own.isError ?? false).toBe(false);
    const found = await call(member, 'find_task', { org: orgId, query: word });
    expect(found.body.tasks.map((t: { id: string }) => t.id)).toEqual([mine.id]);

    const owner = await mcp(ownerId);
    expect((await call(owner, 'get_task', { org: orgId, task: theirs.id })).isError ?? false).toBe(false);
    const all = await call(owner, 'find_task', { org: orgId, query: word });
    expect(all.body.tasks.map((t: { id: string }) => t.id).sort()).toEqual([mine.id, theirs.id].sort());
  });

  it('лента событий, предложения и агент рядового хозяина — тоже только причастное (ревью 07.10)', async () => {
    const { orgId, ownerId } = await makeOrg();
    const a = await addPerson(orgId, 'member');
    const b = await addPerson(orgId, 'member');
    const theirs = await inOrg(orgId, (db) => createTask(db, { ...base, title: `чужое ${uniq()}`, assigneeUserId: b },
      { kind: 'user', userId: ownerId }, MON_10), ownerId);
    await inOrg(orgId, (db) => addHumanComment(db, theirs.id, b, 'секретная реплика'), b);
    const mine = await inOrg(orgId, (db) => createTask(db, { ...base, title: `своё ${uniq()}`, assigneeUserId: a },
      { kind: 'user', userId: ownerId }, MON_10), ownerId);

    const member = await mcp(a);
    const feed = await call(member, 'get_changes_since', { org: orgId });
    const ids = new Set(feed.body.events.map((e: { task_id: string | null }) => e.task_id));
    expect(ids.has(theirs.id)).toBe(false);
    expect(ids.has(mine.id)).toBe(true);
    expect(JSON.stringify(feed.body)).not.toContain('секретная реплика');
    const ownerFeed = await call(await mcp(ownerId), 'get_changes_since', { org: orgId });
    expect(ownerFeed.body.events.some((e: { task_id: string | null }) => e.task_id === theirs.id)).toBe(true);

    const proposals = await call(member, 'list_proposals', { org: orgId });
    expect(proposals.isError).toBe(true);
    expect(proposals.body.code).toBe('forbidden');

    // Хозяин агента — рядовой: через agent= он не обходит правило.
    const agentId = await makeAgent(orgId, a);
    const viaAgent = await call(member, 'get_task', { org: orgId, agent: agentId, task: theirs.id });
    expect(viaAgent.isError).toBe(true);
    expect(viaAgent.body.code).toBe('not_found');
    expect((await call(member, 'get_task', { org: orgId, task: 'слово' })).body.code).toBe('validation_failed');
  });
});
