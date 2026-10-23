import request from 'supertest';
import { createHash, randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import { loginCookie } from './helpers.js';
import { createApp } from '../src/web/app.js';
import { outbox } from '../src/email/send.js';

// Клиент коннектора для тестов. Лежит ОТДЕЛЬНО от oauth-flow.test.ts: импорт тест-файла заставляет
// vitest прогонять его describe заново в каждом импортирующем файле, и пять копий проверок входа
// начинают драться за коды и ограничитель частоты (плавающие падения всего сьюта).

const app = createApp();

/**
 * Запрос, пришедший через Cloudflare: соединение с nginx — от узла Cloudflare (последний адрес в
 * X-Forwarded-For), адрес клиента — в CF-Connecting-IP. Заголовку от кого-то ещё сервер не верит.
 */
export const viaCloudflare = (ip: string, node = '104.16.0.1'): Record<string, string> =>
  ({ 'X-Forwarded-For': node, 'CF-Connecting-IP': ip });
const b64url = (b: Buffer) => b.toString('base64url');

/** `code` — постоянный код демо-входа (спека demo-access): письма нет, код известен заранее. */
export async function connectClient(email: string, opts: { code?: string } = {}): Promise<string> {
  const reg = await request(app).post('/register').send({
    client_name: 'claude.ai', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  });
  expect(reg.status).toBe(201);
  const clientId = reg.body.client_id as string;
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const auth = await request(app).get('/authorize').query({
    client_id: clientId, response_type: 'code', redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: challenge, code_challenge_method: 'S256', state: 'st1', resource: 'http://localhost:3000/mcp',
  });
  expect(auth.status).toBe(302);
  const loginPath = new URL(auth.headers.location!).pathname;
  const id = loginPath.split('/').pop()!;
  // Свой адрес клиента на каждое подключение: потолок страниц входа считается по нему (как за
  // Cloudflare), и файл с десятком подключений иначе упирался в 429 сам о себя.
  const ip = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  await request(app).post(`/oauth/login/${id}/email`).set(viaCloudflare(ip)).type('form').send({ email });
  const code = opts.code ?? /(\d{6})/.exec(outbox.filter((m) => m.to === email).at(-1)!.text)![1]!;
  const bad = await request(app).post(`/oauth/login/${id}/code`).set(viaCloudflare(ip)).type('form').send({ code: '000000' === code ? '111111' : '000000' });
  expect(bad.status).toBe(400);
  const good = await request(app).post(`/oauth/login/${id}/code`).set(viaCloudflare(ip)).type('form').send({ code });
  expect(good.status).toBe(200);
  const consent = await request(app).post(`/oauth/login/${id}/consent`).set(viaCloudflare(ip)).set('Cookie', loginCookie(good));
  expect(consent.status).toBe(302);
  const cb = new URL(consent.headers.location!);
  expect(cb.searchParams.get('state')).toBe('st1');
  const tok = await request(app).post('/token').type('form').send({
    grant_type: 'authorization_code', code: cb.searchParams.get('code'), code_verifier: verifier,
    client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', resource: 'http://localhost:3000/mcp',
  });
  expect(tok.status).toBe(200);
  return tok.body.access_token as string;
}

export async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const r = await request(app).post('/mcp').set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream').send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return r;
}
