import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import './helpers.js';
import { closePools } from '../src/db/pool.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { createProject } from '../src/core/projects.js';
import { taskLink } from '../src/runtime/attention.js';
import { addPerson, inOrg, makeOrg } from './helpers.js';

// Диспетчер дал ссылку t_356, а в приложении дело видно как NOR-033 — по ссылке его не узнать;
// и create_task без project молча клал дело на общую доску, хотя по смыслу оно доска склада или доставки.

afterAll(closePools);

async function call(userId: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: any }> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildMcpServer({ userId }).connect(serverT);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientT);
  const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text: string }[] };
  return { isError: !!r.isError, data: JSON.parse(r.content[0]!.text) };
}

const task = (extra: Record<string, unknown>) => ({
  title: 'сверить остатки', why: 'зачем', done_criteria: 'таблица сверена', due_date: '2026-12-31',
  description: 'как делать: открыть таблицу остатков и сверить', source: { title: 'разговор', quote: 'сверь остатки' }, ...extra,
});

describe('ключ доски в ответе create_task и в ссылке', () => {
  it('ответ несёт ключ, ссылка — тот же ключ', async () => {
    const { orgId, ownerId } = await makeOrg();
    const worker = await addPerson(orgId);
    const r = await call(ownerId, 'create_task', { org: orgId, ...task({ assignee: worker, idempotency_key: `k-${Date.now()}` }) });
    expect(r.isError).toBe(false);
    expect(r.data.key).toMatch(/^[A-Z0-9]+-\d{3}$/);
    expect(r.data.link).toContain(`start=t_${r.data.short_id}_${r.data.key}`);
  });

  it('ссылка без ключа прежняя — старые ссылки не ломаются', () => {
    expect(taskLink(356)).toMatch(/start=t_356$/);
    expect(taskLink(356, 'NOR-033')).toMatch(/start=t_356_NOR-033$/);
  });

  it('несколько досок и нет project — отказ с перечнем досок', async () => {
    const { orgId, ownerId } = await makeOrg();
    const worker = await addPerson(orgId);
    // Первая доска компании появляется с первым делом; одна доска — дело без project ложится на неё.
    const first = await call(ownerId, 'create_task', { org: orgId, ...task({ assignee: worker, idempotency_key: `f-${Date.now()}` }) });
    expect(first.isError).toBe(false);
    await inOrg(orgId, (db) => createProject(db, { name: 'Склад', key: 'SKL' }, { kind: 'user', userId: ownerId }));
    const r = await call(ownerId, 'create_task', { org: orgId, ...task({ assignee: worker, idempotency_key: `m-${Date.now()}` }) });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe('validation_failed');
    expect(JSON.stringify(r.data)).toContain('Склад');

    const ok = await call(ownerId, 'create_task', { org: orgId, ...task({ assignee: worker, project: 'Склад', idempotency_key: `p-${Date.now()}` }) });
    expect(ok.isError).toBe(false);
    expect(ok.data.key).toMatch(/^SKL-\d{3}$/);
  });
});
