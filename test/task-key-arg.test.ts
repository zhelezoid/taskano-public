import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closePools } from '../src/db/pool.js';
import { createTask } from '../src/core/tasks.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { inOrg, makeOrg, MON_10 } from './helpers.js';

// Дело называют ключом («NOR-012») — его показывают find_task, сводка и бот. Раньше ключ в поле
// `task` уходил в SQL как uuid и ронял get_task / update_task немой «internal» (найдено на бою
// 02.10.2026, инциденты 17272f8d, 9f58ba18).

afterAll(closePools);

async function mcp(userId: string): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildMcpServer({ userId }).connect(serverT);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientT);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: any }> {
  const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
  return { isError: !!r.isError, data: JSON.parse(r.content[0]!.text) };
}

const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу' };

async function world() {
  const { orgId, ownerId } = await makeOrg();
  const task = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'сверить остатки', assigneeUserId: ownerId }, { kind: 'user', userId: ownerId }, MON_10));
  const owner = await mcp(ownerId);
  const found = await call(owner, 'find_task', { query: 'сверить остатки' });
  const key = found.data.tasks.find((t: { id: string }) => t.id === task.id).key as string;
  return { task, owner, key };
}

describe('аргумент task принимает ключ дела', () => {
  it('get_task и update_task по ключу работают так же, как по id', async () => {
    const w = await world();
    expect(w.key).toMatch(/^[A-Z][A-Z0-9]{1,4}-\d+$/);

    const byKey = await call(w.owner, 'get_task', { task: w.key });
    expect(byKey.isError).toBe(false);
    expect(byKey.data.task?.id ?? byKey.data.id).toBe(w.task.id);

    // Ключ без ведущих нулей и в нижнем регистре — тот же ключ.
    const loose = w.key.replace(/-0+(\d)/, '-$1').toLowerCase();
    expect((await call(w.owner, 'get_task', { task: loose })).isError).toBe(false);

    const upd = await call(w.owner, 'update_task', { task: w.key, title: 'сверить остатки на складе' });
    expect(upd.isError).toBe(false);
    expect(upd.data.id).toBe(w.task.id);
    expect(upd.data.title).toBe('сверить остатки на складе');
  });

  it('несуществующий ключ — not_found, а не internal', async () => {
    const w = await world();
    const r = await call(w.owner, 'get_task', { task: 'ZZZ-999' });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe('not_found');
  });

  it('строка не вида id и не ключ — validation_failed, а не internal', async () => {
    const w = await world();
    const r = await call(w.owner, 'get_task', { task: 'not-an-id-at-all' });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe('validation_failed');
  });
});
