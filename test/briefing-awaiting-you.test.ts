import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closePools } from '../src/db/pool.js';
import { createTask } from '../src/core/tasks.js';
import { createProject } from '../src/core/projects.js';
import { takeTask } from '../src/core/queue.js';
import { transition } from '../src/core/lifecycle.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { addPerson, inOrg, makeAgent, makeOrg, MON_10, minutes, uniq } from './helpers.js';
import type { Actor } from '../src/core/types.js';

// Сводка показывает владельцу сданное и вопросы по делам, которые он поставил сам, без агента
// (поле awaiting_you). Раньше она видела только дела агентов: на проверке каталога ChatGPT 02.10
// «дай сводку» не нашла ни сданного результата, ни вопроса, хотя оба ждали владельца.

afterAll(closePools);

async function mcp(userId: string): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildMcpServer({ userId }).connect(serverT);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientT);
  return client;
}

async function briefing(client: Client, args: Record<string, unknown> = {}): Promise<any> {
  const r = await client.callTool({ name: 'get_briefing', arguments: args }) as { isError?: boolean; content: { text: string }[] };
  expect(r.isError ?? false).toBe(false);
  return JSON.parse(r.content[0]!.text);
}

const user = (userId: string): Actor => ({ kind: 'user', userId });
const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу' };

describe('get_briefing: awaiting_you', () => {
  it('сданное и вопрос по делам владельца — в сводке; чужие и агентские — нет', async () => {
    const { orgId, ownerId } = await makeOrg();
    const a = await addPerson(orgId, 'member');
    const b = await addPerson(orgId, 'member');
    const agentId = await makeAgent(orgId, ownerId);

    const handed = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'сжать видео', assigneeUserId: a }, user(ownerId), MON_10), ownerId);
    await inOrg(orgId, (db) => takeTask(db, handed.id, user(a), { now: MON_10 }), a);
    await inOrg(orgId, (db) => transition(db, handed.id, 'submit', user(a), { now: minutes(MON_10, 5) }), a);

    const asked = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'настроить редиректы', assigneeUserId: b }, user(ownerId), MON_10), ownerId);
    await inOrg(orgId, (db) => takeTask(db, asked.id, user(b), { now: MON_10 }), b);
    await inOrg(orgId, (db) => transition(db, asked.id, 'question', user(b), { now: minutes(MON_10, 6), text: 'куда вести /blog?' }), b);

    // Дело агента — в разделе агента, не в awaiting_you.
    await inOrg(orgId, (db) => createTask(db, { ...base, title: `агентское ${uniq()}`, assigneeUserId: a },
      { kind: 'agent', agentId, userId: ownerId }, MON_10), ownerId);

    const owner = await briefing(await mcp(ownerId));
    expect(owner.awaiting_you.submitted.map((t: { id: string }) => t.id)).toEqual([handed.id]);
    expect(owner.awaiting_you.blocked.map((t: { id: string }) => t.id)).toEqual([asked.id]);
    expect(owner.awaiting_you.blocked[0].question).toEqual({ untrusted: true, text: 'куда вести /blog?' });
  });

  it('вопрос по делу из очереди (статус ready) — тоже в awaiting_you; после ответа уходит', async () => {
    const { orgId, ownerId } = await makeOrg();
    const a = await addPerson(orgId, 'member');
    // Первое дело занимает «Сейчас», второе остаётся в очереди.
    await inOrg(orgId, (db) => createTask(db, { ...base, title: 'текущее дело', assigneeUserId: a }, user(ownerId), MON_10), ownerId);
    const t = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'проверить 2 заливки', assigneeUserId: a }, user(ownerId), MON_10), ownerId);
    expect(t.status).toBe('ready');
    // Не взято: вопрос из очереди статус не меняет.
    const asked = await inOrg(orgId, (db) => transition(db, t.id, 'question', user(a), { now: minutes(MON_10, 3), text: 'прайс не соответствует' }), a);
    expect(asked.status).toBe('ready');

    const before = await briefing(await mcp(ownerId));
    expect(before.awaiting_you.blocked.map((x: { id: string }) => x.id)).toEqual([t.id]);
    expect(before.awaiting_you.blocked[0].question).toEqual({ untrusted: true, text: 'прайс не соответствует' });

    await inOrg(orgId, (db) => db.query(`update task_messages set answered_at = now() where task_id = $1`, [t.id]), ownerId);
    expect((await briefing(await mcp(ownerId))).awaiting_you.blocked).toEqual([]);
  });

  it('закрытый проект владельца в awaiting_you не попадает: сводку читает и рутина агентов', async () => {
    const { orgId, ownerId } = await makeOrg();
    const a = await addPerson(orgId, 'member');
    const secret = await inOrg(orgId, (db) => createProject(db, { name: `Найм ${uniq()}`, private: true }, user(ownerId)), ownerId);
    await inOrg(orgId, (db) => db.query('insert into project_members(org_id, project_id, user_id) values ($1, $2, $3) on conflict do nothing', [orgId, secret.id, a]), ownerId);
    const t = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'оффер кандидату', assigneeUserId: a, project: secret.id }, user(ownerId), MON_10), ownerId);
    await inOrg(orgId, (db) => takeTask(db, t.id, user(a), { now: MON_10 }), a);
    await inOrg(orgId, (db) => transition(db, t.id, 'submit', user(a), { now: minutes(MON_10, 5) }), a);
    expect((await inOrg(orgId, (db) => db.query('select status from tasks where id = $1', [t.id]), ownerId)).rows[0].status).toBe('submitted');

    expect((await briefing(await mcp(ownerId))).awaiting_you.submitted).toEqual([]);
  });
});
