import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHash, randomBytes } from 'node:crypto';
import { loginCookie } from './helpers.js';
import { closePools } from '../src/db/pool.js';
import { createApp } from '../src/web/app.js';
import { outbox } from '../src/email/send.js';
import { callTool, connectClient } from './mcp-client.js';

afterAll(closePools);
const app = createApp();
const b64url = (b: Buffer) => b.toString('base64url');

describe('OAuth-поток коннектора', () => {
  it('без токена /mcp отвечает 401 со ссылкой на metadata', async () => {
    const r = await request(app).post('/mcp').send({});
    expect(r.status).toBe(401);
    expect(r.headers['www-authenticate']).toMatch(/resource_metadata=/);
    const meta = await request(app).get('/.well-known/oauth-protected-resource/mcp');
    expect(meta.status).toBe(200);
  });

  // Адрес коннектора, открытый в браузере, был пустой страницей 405 — человек решал, что сайт не работает.
  it('GET /mcp: браузеру — инструкция подключения, программе без токена — 401 с metadata', async () => {
    const browser = await request(app).get('/mcp').set('Accept', 'text/html,application/xhtml+xml,*/*;q=0.8');
    expect(browser.status).toBe(302);
    expect(browser.headers.location).toBe('/docs#setup');
    const client = await request(app).get('/mcp').set('Accept', 'text/event-stream');
    expect(client.status).toBe(401);
    expect(client.headers['www-authenticate']).toMatch(/resource_metadata=/);
  });

  it('DCR → вход по коду почты → токен с PKCE → whoami', async () => {
    const token = await connectClient(`owner-${Date.now()}@test.local`);
    const r = await callTool(token, 'whoami');
    expect(r.status).toBe(200);
    const payload = JSON.parse(r.body.result.content[0].text);
    expect(payload.orgs.some((o: { kind: string }) => o.kind === 'personal')).toBe(true);
  });
});

describe('OAuth — защита (аудит безопасности)', () => {
  it('DCR отклоняет адрес возврата не claude.ai', async () => {
    const r = await request(app).post('/register').send({
      client_name: 'evil', redirect_uris: ['https://attacker.example/cb'], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'], response_types: ['code'],
    });
    expect(r.status).toBe(400);
  });

  it('DCR не выдаёт и не хранит секрет клиента', async () => {
    const r = await request(app).post('/register').send({
      client_name: 'c', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    });
    expect(r.status).toBe(201);
    expect(r.body.client_secret).toBeUndefined();
    expect(r.body.token_endpoint_auth_method).toBe('none');
  });

  it('повтор ротированного refresh-токена отзывает всю цепочку', async () => {
    const email = `chain-${Date.now()}@test.local`;
    // Повторяем поток, чтобы получить и refresh-токен.
    const reg = await request(app).post('/register').send({
      client_name: 'claude.ai', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    });
    const clientId = reg.body.client_id;
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const auth = await request(app).get('/authorize').query({
      client_id: clientId, response_type: 'code', redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: challenge, code_challenge_method: 'S256', resource: 'http://localhost:3000/mcp',
    });
    const id = new URL(auth.headers.location!).pathname.split('/').pop()!;
    await request(app).post(`/oauth/login/${id}/email`).type('form').send({ email });
    const code = /(\d{6})/.exec(outbox.filter((m) => m.to === email).at(-1)!.text)![1]!;
    const entered = await request(app).post(`/oauth/login/${id}/code`).type('form').send({ code });
    // Чужой браузер (без cookie того, кто ввёл код) согласие не отправит — аудит 07.10, HIGH.
    const stranger = await request(app).post(`/oauth/login/${id}/consent`);
    expect(stranger.status).toBe(403);
    expect(stranger.headers.location).toBeUndefined();
    const consent = await request(app).post(`/oauth/login/${id}/consent`).set('Cookie', loginCookie(entered));
    const authCode = new URL(consent.headers.location!).searchParams.get('code');
    const t1 = await request(app).post('/token').type('form').send({ grant_type: 'authorization_code', code: authCode, code_verifier: verifier, client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback' });
    const t2 = await request(app).post('/token').type('form').send({ grant_type: 'refresh_token', refresh_token: t1.body.refresh_token, client_id: clientId });
    expect(t2.status).toBe(200);
    const reuse = await request(app).post('/token').type('form').send({ grant_type: 'refresh_token', refresh_token: t1.body.refresh_token, client_id: clientId });
    expect(reuse.status).toBe(400);
    const after = await callTool(t2.body.access_token, 'whoami');
    expect(after.status).toBe(401);
    const t3 = await request(app).post('/token').type('form').send({ grant_type: 'refresh_token', refresh_token: t2.body.refresh_token, client_id: clientId });
    expect(t3.status).toBe(400);
  });

  it('код входа не подходит к чужой странице входа', async () => {
    const { withGlobal } = await import('../src/db/pool.js');
    const { issueLoginCode, verifyLoginCode } = await import('../src/core/login-codes.js');
    const email = `bind-${Date.now()}@test.local`;
    const a = '11111111-1111-1111-1111-111111111111';
    const b = '22222222-2222-2222-2222-222222222222';
    const code = await withGlobal((db) => issueLoginCode(db, email, 'oauth', { pendingId: a }));
    expect(await withGlobal((db) => verifyLoginCode(db, email, code, { purpose: 'oauth', pendingId: b }))).toBe(false);
    expect(await withGlobal((db) => verifyLoginCode(db, email, code, { purpose: 'bot' }))).toBe(false);
    expect(await withGlobal((db) => verifyLoginCode(db, email, code, { purpose: 'oauth', pendingId: a }))).toBe(true);
  });

  it('чужие неверные коды в боте не закрывают владельцу почты вход в коннектор (аудит 07.10)', async () => {
    const { withGlobal } = await import('../src/db/pool.js');
    const { issueLoginCode, verifyLoginCode, LIMITS } = await import('../src/core/login-codes.js');
    const email = `lock-${Date.now()}@test.local`;
    const now = new Date();
    // Кто-то в боте вводит чужую почту и ошибается — больше, чем потолок неудач.
    const rounds = Math.ceil(LIMITS.failedPerEmailHour / 5) + 1;
    for (let i = 0; i < rounds; i++) {
      const sentAt = new Date(now.getTime() - (rounds - i) * 61_000);
      await withGlobal((db) => issueLoginCode(db, email, 'bot', { now: sentAt }));
      for (let k = 0; k < 5; k++) await withGlobal((db) => verifyLoginCode(db, email, '000000', { purpose: 'bot', now }));
    }
    // Владелец почты входит в коннектор своим кодом.
    const pending = '33333333-3333-3333-3333-333333333333';
    const code = await withGlobal((db) => issueLoginCode(db, email, 'oauth', { pendingId: pending, now: new Date(now.getTime() + 61_000) }));
    expect(await withGlobal((db) => verifyLoginCode(db, email, code, { purpose: 'oauth', pendingId: pending, now: new Date(now.getTime() + 62_000) }))).toBe(true);
  });
});
