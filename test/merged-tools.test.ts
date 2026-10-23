import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import './helpers.js';
import { closePools } from '../src/db/pool.js';
import { MERGED_TOOLS } from '../src/mcp/merged.js';
import { callTool, connectClient } from './mcp-client.js';
import { createApp } from '../src/web/app.js';

// Слияние поверхности коннектора (спека connector-surface): имени больше нет, но skill у людей
// закэширован и какое-то время зовёт старое. Ответ обязан говорить, чем звать теперь.

afterAll(closePools);

function parse(r: Awaited<ReturnType<typeof callTool>>): any {
  return JSON.parse(r.body.result.content[0].text);
}

describe('слитые имена инструментов', () => {
  // Вход по коду ограничен по IP: один человек на файл, оба теста смотрят на одну поверхность.
  let token: string;
  beforeAll(async () => { token = await connectClient(`merged-${randomUUID()}@test.local`); });

  it('старое имя отвечает, чем его звать теперь и с каким полем', async () => {
    const gone = await callTool(token, 'personal_add', { title: 'дело' });
    expect(gone.body.result.isError).toBe(true);
    const body = parse(gone);
    expect(body.code).toBe('not_found');
    expect(body.message).toContain('personal_add');
    expect(body.message).toContain('create_task with org: "personal"');
    expect(body.details.merged_into).toBe(MERGED_TOOLS.personal_add);

    // И так — про каждое слитое имя, а не только про то, которое вспомнили в тесте.
    for (const name of Object.keys(MERGED_TOOLS)) {
      const r = await callTool(token, name, {});
      expect(r.body.result.isError, name).toBe(true);
      expect(parse(r).message, name).toContain('merged into');
    }
  });

  it('слитых имён нет в списке инструментов, а целевые — есть', async () => {
    const names = await toolNames(token);
    for (const name of Object.keys(MERGED_TOOLS)) expect(names, name).not.toContain(name);
    for (const name of ['find_task', 'find_person', 'create_task', 'update_task', 'review_result', 'update_group', 'comment_task']) {
      expect(names, name).toContain(name);
    }
  });
});

/** Список инструментов так, как его видит коннектор: `tools/list` тем же транспортом. */
async function toolNames(token: string): Promise<string[]> {
  const list = await request(createApp()).post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  return (list.body.result.tools as { name: string }[]).map((t) => t.name);
}
