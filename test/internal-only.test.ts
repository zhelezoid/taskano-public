import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import './helpers.js';
import { closePools, withGlobal } from '../src/db/pool.js';
import { createApp } from '../src/web/app.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { ensureUserByEmail, mayEnter } from '../src/core/people.js';
import { outbox } from '../src/email/send.js';
import { invitePerson } from '../src/core/invitations.js';
import { inOrg, makeOrg } from './helpers.js';
import { viaCloudflare } from './mcp-client.js';

// Решение владельца 20.10.2026: Taskano — внутренний инструмент. Посторонний не входит
// на taskano.app и в бота и не заводит компанию; участник компании и приглашённый входят как прежде.

afterAll(closePools);
beforeEach(() => { process.env.INTERNAL_ONLY = '1'; });
afterEach(() => { delete process.env.INTERNAL_ONLY; });

const app = createApp();
const uniq = () => `${Date.now()}-${randomBytes(3).toString('hex')}`;

async function loginPage(): Promise<string> {
  const reg = await request(app).post('/register').send({
    client_name: 'claude.ai', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'],
  });
  const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest().toString('base64url');
  const auth = await request(app).get('/authorize').query({
    client_id: reg.body.client_id, response_type: 'code', redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: 'http://localhost:3000/mcp',
  });
  return new URL(auth.headers.location!).pathname.split('/').pop()!;
}

describe('внутренний режим: только свои', () => {
  it('посторонней почте вход закрыт, письмо с кодом не уходит', async () => {
    const email = `stranger-${uniq()}@test.local`;
    expect(await withGlobal((db) => mayEnter(db, email))).toBe(false);
    const id = await loginPage();
    const r = await request(app).post(`/oauth/login/${id}/email`).set(viaCloudflare(`10.9.${randomBytes(1)[0]}.1`)).type('form').send({ email });
    expect(r.status).toBe(403);
    expect(r.text).toMatch(/invitation only|по приглашению/);
    expect(outbox.some((m) => m.to === email)).toBe(false);
  });

  it('приглашённый в компанию входит', async () => {
    const { orgId, ownerId } = await makeOrg();
    const email = `invited-${uniq()}@test.local`;
    await inOrg(orgId, (db) => invitePerson(db, { email, role: 'member' }, { kind: 'user', userId: ownerId }));
    expect(await withGlobal((db) => mayEnter(db, email))).toBe(true);
  });

  it('человек только с личным пространством — посторонний', async () => {
    const email = `alone-${uniq()}@test.local`;
    await withGlobal((db) => ensureUserByEmail(db, email));
    expect(await withGlobal((db) => mayEnter(db, email))).toBe(false);
  });

  it('create_org отказывает', async () => {
    const { ownerId } = await makeOrg();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await buildMcpServer({ userId: ownerId }).connect(serverT);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(clientT);
    const r = await client.callTool({ name: 'create_org', arguments: { name: `Чужая ${uniq()}` } }) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text).code).toBe('forbidden');
  });

  it('лендинг и документация — страница «внутренний инструмент», без адреса коннектора', async () => {
    for (const path of ['/', '/docs']) {
      const r = await request(app).get(path);
      expect(r.status).toBe(200);
      expect(r.text).toContain('internal tool');
      expect(r.text).not.toContain('taskano.app/mcp');
    }
  });
});
