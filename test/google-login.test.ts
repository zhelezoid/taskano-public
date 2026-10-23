import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTPayload } from 'jose';
import './helpers.js';
import { loginCookie, uniq } from './helpers.js';
import { closePools, withGlobal } from '../src/db/pool.js';
import { createApp } from '../src/web/app.js';
import { outbox } from '../src/email/send.js';
import { ensureUserByEmail } from '../src/core/people.js';
import { logger } from '../src/log.js';

// Спека google-login: вход через Google на странице подключения к Claude. Google заменён локальным
// сервером: свой RSA-ключ, свой JWKS и свой token-эндпоинт; id_token подписывается в тесте.

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const CLIENT_SECRET = 'test-google-secret-value';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const b64url = (b: Buffer) => b.toString('base64url');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let server: Server;
let base = '';
/** Что вернёт token-эндпоинт на следующий обмен; по умолчанию — id_token с `claims`. */
let tokenReply: (() => Promise<{ status: number; json: unknown }>) | null = null;
let claims: JWTPayload = {};
let signWith: 'ours' | 'other' = 'ours';
let lifetime: { iat: number; exp: number } | null = null;
const exchanges: Record<string, string>[] = [];

async function idToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuedAt(lifetime?.iat ?? now).setExpirationTime(lifetime?.exp ?? now + 3600)
    .sign(signWith === 'ours' ? privateKey : otherKey);
}

beforeAll(async () => {
  const ours = await generateKeyPair('RS256', { extractable: true });
  privateKey = ours.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  const jwk = { ...(await exportJWK(ours.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const g = express();
  g.get('/certs', (_req, res) => { res.json({ keys: [jwk] }); });
  g.post('/token', express.urlencoded({ extended: false }), async (req, res) => {
    exchanges.push({ ...req.body });
    if (tokenReply) { const r = await tokenReply(); res.status(r.status).json(r.json); return; }
    res.json({ access_token: 'ya29.x', id_token: await idToken(), token_type: 'Bearer', expires_in: 3599 });
  });
  server = await new Promise<Server>((ok) => { const s = g.listen(0, '127.0.0.1', () => ok(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((ok) => server.close(ok));
  await closePools();
});

function enableGoogle(): void {
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = CLIENT_SECRET;
}
function disableGoogle(): void {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
}

const newApp = () => createApp({ google: { authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: `${base}/token`, jwksUrl: `${base}/certs` } });

/** DCR → authorize с настоящим PKCE, как это делает claude.ai. */
async function startLogin(app = newApp()) {
  const reg = await request(app).post('/register').send({
    client_name: 'claude.ai', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  });
  const verifier = b64url(randomBytes(32));
  const auth = await request(app).get('/authorize').query({
    client_id: reg.body.client_id, response_type: 'code', redirect_uri: REDIRECT, state: 'claude-st',
    code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    resource: 'http://localhost:3000/mcp',
  });
  return { app, id: new URL(auth.headers.location!).pathname.split('/').pop()!, clientId: reg.body.client_id as string, verifier };
}

/** Имя cookie привязки: своё у каждой сессии входа. */
const cookieName = (id: string) => `tk_g_${id.slice(0, 8)}`;

/** Кнопка Google → наш старт: state, nonce, PKCE и cookie tk_g_<id>. `jar` — заголовок Cookie этого браузера. */
async function startGoogle(app: ReturnType<typeof createApp>, id: string) {
  const r = await request(app).get(`/oauth/google/start/${id}`);
  const loc = new URL(r.headers.location ?? 'http://none/');
  const setCookie = ([] as string[]).concat(r.headers['set-cookie'] ?? []);
  const cookie = new RegExp(`${cookieName(id)}=([^;]+)`).exec(setCookie.join('\n'))?.[1] ?? '';
  const q = loc.searchParams;
  return { r, loc, setCookie, cookie, jar: `${cookieName(id)}=${cookie}`, state: q.get('state')!, nonce: q.get('nonce')!, challenge: q.get('code_challenge')! };
}

const goodClaims = (email: string, nonce: string): JWTPayload =>
  // hd — домен Workspace: почте с ним Google хозяин (аудит 07.10). Личный аккаунт на чужой домен — без hd.
  ({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: `g-${uniq()}`, email, email_verified: true, nonce, name: 'Test Person',
    hd: email.split('@')[1]?.toLowerCase() });

const callback = (app: ReturnType<typeof createApp>, query: Record<string, string>, jar?: string) => {
  const req = request(app).get('/oauth/google/callback').query(query).set('Accept-Language', 'ru');
  return jar === undefined ? req : req.set('Cookie', jar);
};

const pendingRow = (id: string) => withGlobal(async (db) =>
  (await db.query('select user_id, via_google_cookie_hash from oauth_pending where id = $1', [id])).rows[0] as
    { user_id: string | null; via_google_cookie_hash: string | null } | undefined);

const FAILED_RU = 'Не удалось войти через Google — войдите по коду из почты.';

beforeEach(() => {
  enableGoogle();
  tokenReply = null; claims = {}; signWith = 'ours'; lifetime = null;
});
afterEach(() => {
  disableGoogle();
  delete process.env.DEMO_LOGIN_EMAIL;
  delete process.env.DEMO_LOGIN_CODE_SHA256;
});

describe('вход через Google: без настройки страница прежняя', () => {
  it('без GOOGLE_* — ни кнопки, ни стиля, ни маршрутов', async () => {
    disableGoogle();
    const { app, id } = await startLogin();
    const r = await request(app).get(`/oauth/login/${id}`);
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/google|gsi|gbtn/i);
    expect((await request(app).get(`/oauth/google/start/${id}`)).status).toBe(404);
    expect((await request(app).get('/oauth/google/callback').query({ state: 'x', code: 'y' })).status).toBe(404);
  });

  it('одна только половина настройки — кнопки нет', async () => {
    delete process.env.GOOGLE_CLIENT_SECRET;
    const { app, id } = await startLogin();
    expect((await request(app).get(`/oauth/login/${id}`)).text).not.toContain('/oauth/google/start/');
  });

  it('с GOOGLE_* страница отличается только блоком кнопки; код и согласие — байт в байт', async () => {
    const { app, id } = await startLogin();
    const strip = (html: string) => html
      .replace(/<div class="gsi">[\s\S]*?<\/div>/, '')
      .replace(/\n\.gsi\{[\s\S]*?<\/style>/, '</style>');
    for (const lang of ['ru', 'en', 'tr', 'vi']) {
      const on = await request(app).get(`/oauth/login/${id}`).set('Accept-Language', lang);
      disableGoogle();
      const off = await request(app).get(`/oauth/login/${id}`).set('Accept-Language', lang);
      enableGoogle();
      expect(on.text).not.toBe(off.text);
      expect(strip(on.text)).toBe(off.text);
    }
    const email = `gl-same-${uniq()}@test.local`;
    const codeOn = await request(app).post(`/oauth/login/${id}/email`).type('form').send({ email });
    disableGoogle();
    const codeOff = await request(app).get(`/oauth/login/${id}`);
    enableGoogle();
    expect(codeOn.text).toBe(codeOff.text);
    expect(codeOn.text).not.toMatch(/google/i);
  });
});

describe('вход через Google: кнопка и старт', () => {
  it('кнопка над полем почты, логотип встроен, ничего с чужих адресов', async () => {
    const { app, id } = await startLogin();
    for (const [lang, label] of [['ru', 'Войти через Google'], ['en', 'Sign in with Google'], ['tr', 'Google ile giriş yap'], ['vi', 'Đăng nhập bằng Google']]) {
      const r = await request(app).get(`/oauth/login/${id}`).set('Accept-Language', lang!);
      expect(r.text).toContain(`<a class="gbtn" href="/oauth/google/start/${id}"><svg`);
      expect(r.text).toContain(`<span>${label}</span>`);
      expect(r.text.indexOf('class="gbtn"')).toBeLessThan(r.text.indexOf('name="email"'));
      expect(r.text).not.toMatch(/<script/i);
      expect(r.text).not.toMatch(/url\(|@import|@font-face/i);
      for (const m of r.text.matchAll(/\b(?:src|href|action)="([^"]*)"/g)) expect(m[1], m[0]).toMatch(/^\//);
      expect(r.text.match(/<form/g)).toHaveLength(1);
      expect(r.headers['content-security-policy']).toBe("frame-ancestors 'none'");
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['cache-control']).toBe('no-store');
    }
  });

  it('старт ставит cookie tk_g и ведёт на Google с state, nonce, PKCE S256; в базе — только хэши', async () => {
    const { app, id } = await startLogin();
    const g = await startGoogle(app, id);
    expect(g.r.status).toBe(302);
    expect(g.r.headers['cache-control']).toBe('no-store');
    expect(`${g.loc.origin}${g.loc.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const q = g.loc.searchParams;
    expect(q.get('client_id')).toBe(CLIENT_ID);
    expect(q.get('redirect_uri')).toBe('http://localhost:3000/oauth/google/callback');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('scope')).toBe('openid email profile');
    expect(q.get('prompt')).toBe('select_account');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(g.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(g.state.length).toBeGreaterThanOrEqual(32);
    expect(g.nonce.length).toBeGreaterThanOrEqual(32);
    expect(g.nonce).not.toBe(g.state);
    expect(q.get('client_secret')).toBeNull();
    const c = g.setCookie.find((x) => x.startsWith(`${cookieName(id)}=`))!;
    expect(c).toMatch(/; HttpOnly/);
    expect(c).toMatch(/; Secure/);
    expect(c).toMatch(/; SameSite=Lax/);
    expect(c).toMatch(/; Path=\/oauth(;|$)/);
    expect(c).toMatch(/; Max-Age=600(;|$)/);
    const rows = await withGlobal(async (db) => (await db.query('select * from oauth_google_states where pending_id = $1', [id])).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0].state_hash).toBe(sha(g.state));
    expect(rows[0].cookie_hash).toBe(sha(g.cookie));
    expect(rows[0].nonce_hash).toBe(sha(g.nonce));
    const dump = JSON.stringify(rows);
    for (const secret of [g.state, g.cookie, g.nonce]) expect(dump).not.toContain(secret);
    // Вызов PKCE сходится с verifier, который сервер отдаст при обмене.
    expect(b64url(createHash('sha256').update(rows[0].code_verifier).digest())).toBe(g.challenge);
  });

  it('истёкшая сессия входа — 410, cookie не ставится', async () => {
    const r = await request(newApp()).get('/oauth/google/start/00000000-0000-0000-0000-000000000000');
    expect(r.status).toBe(410);
    expect(r.headers['set-cookie']).toBeUndefined();
  });
});

describe('вход через Google: обратный вызов', () => {
  it('личный аккаунт Google на чужой рабочий адрес (без hd) — не входит, только кодом (аудит 07.10)', async () => {
    const { app, id } = await startLogin();
    const g = await startGoogle(app, id);
    claims = { ...goodClaims(`gl-ex-${uniq()}@company.test`, g.nonce), hd: undefined };
    const cb = await callback(app, { code: 'google-auth-code', state: g.state }, g.jar);
    expect(cb.status).toBe(400);
    expect((await pendingRow(id))!.user_id).toBeNull();
  });

  it('gmail без hd и Workspace с совпадающим hd — Google хозяин почты', async () => {
    const { googleOwnsEmail } = await import('../src/oauth/google.js');
    expect(googleOwnsEmail('a@gmail.com', undefined)).toBe(true);
    expect(googleOwnsEmail('a@googlemail.com', undefined)).toBe(true);
    expect(googleOwnsEmail('a@firm.com', 'firm.com')).toBe(true);
    expect(googleOwnsEmail('a@firm.com', 'other.com')).toBe(false);
    expect(googleOwnsEmail('a@firm.com', undefined)).toBe(false);
  });

  it('новый человек: обмен с PKCE → согласие → код OAuth → токен', async () => {
    const { app, id, clientId, verifier } = await startLogin();
    const g = await startGoogle(app, id);
    const email = `gl-new-${uniq()}@gmail.test`;
    claims = goodClaims(email, g.nonce);
    const before = exchanges.length;
    const cb = await callback(app, { code: 'google-auth-code', state: g.state }, g.jar);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe(`/oauth/login/${id}`);
    const ex = exchanges.slice(before);
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({
      grant_type: 'authorization_code', code: 'google-auth-code', client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      redirect_uri: 'http://localhost:3000/oauth/google/callback',
    });
    expect(b64url(createHash('sha256').update(ex[0]!.code_verifier!).digest())).toBe(g.challenge);

    const page = await request(app).get(`/oauth/login/${id}`);
    expect(page.text).toContain(`action="/oauth/login/${id}/consent"`);
    const consent = await request(app).post(`/oauth/login/${id}/consent`).set('Cookie', g.jar);
    expect(consent.status).toBe(302);
    const back = new URL(consent.headers.location!);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('claude-st');
    expect(([] as string[]).concat(consent.headers['set-cookie'] ?? []).join()).toContain(`${cookieName(id)}=;`);

    const user = await withGlobal(async (db) => (await db.query(
      `select e.user_id, e.verified_at from user_emails e where e.email = $1`, [email])).rows[0]);
    expect(user.verified_at).not.toBeNull();
    const tok = await request(app).post('/token').type('form').send({
      grant_type: 'authorization_code', code: back.searchParams.get('code'), code_verifier: verifier,
      client_id: clientId, redirect_uri: REDIRECT, resource: 'http://localhost:3000/mcp',
    });
    expect(tok.status).toBe(200);
    const owner = await withGlobal(async (db) => (await db.query(
      `select user_id from oauth_tokens where token_hash = $1`, [sha(tok.body.access_token)])).rows[0]);
    expect(owner.user_id).toBe(user.user_id);
  });

  it('существующий человек с той же почтой — тот же аккаунт', async () => {
    const email = `gl-old-${uniq()}@gmail.test`;
    const existing = await withGlobal(async (db) => (await ensureUserByEmail(db, email, { language: 'en' })).user.id);
    const { app, id } = await startLogin();
    const g = await startGoogle(app, id);
    claims = goodClaims(email.toUpperCase(), g.nonce);
    const cb = await callback(app, { code: 'c', state: g.state }, g.jar);
    expect(cb.status).toBe(302);
    expect((await pendingRow(id))!.user_id).toBe(existing);
    const n = await withGlobal(async (db) => (await db.query('select count(*)::int as n from user_emails where email = $1', [email])).rows[0].n);
    expect(n).toBe(1);
  });

  const REJECTS: [string, (email: string, nonce: string) => void][] = [
    ['email_verified=false', (e, n) => { claims = { ...goodClaims(e, n), email_verified: false }; }],
    ['email_verified строкой "true"', (e, n) => { claims = { ...goodClaims(e, n), email_verified: 'true' }; }],
    ['чужой aud', (e, n) => { claims = { ...goodClaims(e, n), aud: 'someone-else.apps.googleusercontent.com' }; }],
    ['чужой iss', (e, n) => { claims = { ...goodClaims(e, n), iss: 'https://evil.example' }; }],
    ['просроченный', (e, n) => {
      claims = goodClaims(e, n);
      const now = Math.floor(Date.now() / 1000);
      lifetime = { iat: now - 7200, exp: now - 3600 };
    }],
    ['aud массивом без azp', (e, n) => { claims = { ...goodClaims(e, n), aud: [CLIENT_ID, 'other.apps.googleusercontent.com'] }; }],
    ['aud массивом, azp чужой', (e, n) => { claims = { ...goodClaims(e, n), aud: [CLIENT_ID, 'other'], azp: 'other' }; }],
    ['azp чужой при одном aud', (e, n) => { claims = { ...goodClaims(e, n), azp: 'other.apps.googleusercontent.com' }; }],
    ['выписан больше 10 минут назад', (e, n) => {
      claims = goodClaims(e, n);
      const now = Math.floor(Date.now() / 1000);
      lifetime = { iat: now - 20 * 60, exp: now + 3600 };
    }],
    ['неверный nonce', (e) => { claims = goodClaims(e, 'not-the-nonce'); }],
    ['без nonce', (e, n) => { const { nonce: _n, ...rest } = goodClaims(e, n); claims = rest; }],
    ['подпись чужим ключом', (e, n) => { claims = goodClaims(e, n); signWith = 'other'; }],
  ];

  it.each(REJECTS)('отказ: %s — 400, без входа', async (_name, setup) => {
    const { app, id } = await startLogin();
    const g = await startGoogle(app, id);
    const email = `gl-rej-${uniq()}@gmail.test`;
    setup(email, g.nonce);
    const cb = await callback(app, { code: 'c', state: g.state }, g.jar);
    expect(cb.status).toBe(400);
    expect(cb.text).toContain(FAILED_RU);
    // Тот же браузер — сразу предложение войти кодом.
    expect(cb.text).toContain(`action="/oauth/login/${id}/email"`);
    expect((await pendingRow(id))!.user_id).toBeNull();
    const made = await withGlobal(async (db) => (await db.query('select 1 from user_emails where email = $1', [email])).rowCount);
    expect(made).toBe(0);
  });

  const ACCEPTS: [string, (email: string, nonce: string) => void][] = [
    ['aud массивом, azp — наш client id', (e, n) => { claims = { ...goodClaims(e, n), aud: [CLIENT_ID, 'other'], azp: CLIENT_ID }; }],
    ['azp — наш client id', (e, n) => { claims = { ...goodClaims(e, n), azp: CLIENT_ID }; }],
    ['срок вышел 30 секунд назад — в пределах допуска часов', (e, n) => {
      claims = goodClaims(e, n);
      const now = Math.floor(Date.now() / 1000);
      lifetime = { iat: now - 300, exp: now - 30 };
    }],
  ];

  it.each(ACCEPTS)('принимается: %s', async (_name, setup) => {
    const { app, id } = await startLogin();
    const g = await startGoogle(app, id);
    setup(`gl-acc-${uniq()}@gmail.test`, g.nonce);
    expect((await callback(app, { code: 'c', state: g.state }, g.jar)).status).toBe(302);
    expect((await pendingRow(id))!.user_id).not.toBeNull();
  });

  it('в сессию, куда тем временем вошли кодом, Google не входит — 400 без формы', async () => {
    const { app, id } = await startLogin();
    const g = await startGoogle(app, id);
    const codeEmail = `gl-race-${uniq()}@test.local`;
    await request(app).post(`/oauth/login/${id}/email`).type('form').send({ email: codeEmail });
    const code = /(\d{6})/.exec(outbox.filter((m) => m.to === codeEmail).at(-1)!.text)![1]!;
    expect((await request(app).post(`/oauth/login/${id}/code`).type('form').send({ code })).status).toBe(200);
    const codeUser = (await pendingRow(id))!.user_id;
    const googleEmail = `gl-race-g-${uniq()}@gmail.test`;
    claims = goodClaims(googleEmail, g.nonce);
    const cb = await callback(app, { code: 'c', state: g.state }, g.jar);
    expect(cb.status).toBe(400);
    expect(cb.text).toContain(FAILED_RU);
    expect(cb.text).not.toContain('<form');
    const row = (await pendingRow(id))!;
    expect(row.user_id).toBe(codeUser);
    expect(row.via_google_cookie_hash).toBeNull();
    // Откат целиком: человек под почтой Google не заведён.
    expect(await withGlobal(async (db) => (await db.query('select 1 from user_emails where email = $1', [googleEmail])).rowCount)).toBe(0);
  });

  it('аккаунт Google запоминается: та же почта с другим sub — отказ, с тем же — вход', async () => {
    const email = `gl-sub-${uniq()}@gmail.test`;
    const login = async (sub: string) => {
      const { app, id } = await startLogin();
      const g = await startGoogle(app, id);
      claims = { ...goodClaims(email, g.nonce), sub };
      return { cb: await callback(app, { code: 'c', state: g.state }, g.jar), id };
    };
    const first = await login('sub-original');
    expect(first.cb.status).toBe(302);
    const stored = await withGlobal(async (db) => (await db.query(
      'select u.google_sub from users u join user_emails e on e.user_id = u.id where e.email = $1', [email])).rows[0].google_sub);
    expect(stored).toBe('sub-original');
    const other = await login('sub-someone-else');
    expect(other.cb.status).toBe(400);
    expect(other.cb.text).toContain(FAILED_RU);
    expect((await pendingRow(other.id))!.user_id).toBeNull();
    expect((await login('sub-original')).cb.status).toBe(302);
  });

  it('два входа в одном браузере не затирают cookie друг друга', async () => {
    const a = await startLogin();
    const b = await startLogin(a.app);
    const ga = await startGoogle(a.app, a.id);
    const gb = await startGoogle(a.app, b.id);
    expect(cookieName(a.id)).not.toBe(cookieName(b.id));
    const jar = `${ga.jar}; ${gb.jar}`;
    claims = goodClaims(`gl-two-a-${uniq()}@gmail.test`, ga.nonce);
    expect((await callback(a.app, { code: 'c', state: ga.state }, jar)).status).toBe(302);
    claims = goodClaims(`gl-two-b-${uniq()}@gmail.test`, gb.nonce);
    expect((await callback(a.app, { code: 'c', state: gb.state }, jar)).status).toBe(302);
    expect((await request(a.app).post(`/oauth/login/${a.id}/consent`).set('Cookie', jar)).status).toBe(302);
    expect((await request(a.app).post(`/oauth/login/${b.id}/consent`).set('Cookie', jar)).status).toBe(302);
  });

  it('чужой state — 400, обмена нет', async () => {
    const { app, id } = await startLogin();
    const g = await startGoogle(app, id);
    claims = goodClaims(`gl-st-${uniq()}@gmail.test`, g.nonce);
    const before = exchanges.length;
    const cb = await callback(app, { code: 'c', state: b64url(randomBytes(32)) }, g.jar);
    expect(cb.status).toBe(400);
    expect(cb.text).toContain(FAILED_RU);
    expect(exchanges.length).toBe(before);
    expect((await pendingRow(id))!.user_id).toBeNull();
  });

  it('state одноразовый: повтор того же обратного вызова — 400', async () => {
    const { app, id } = await startLogin();
    const g = await startGoogle(app, id);
    claims = goodClaims(`gl-rep-${uniq()}@gmail.test`, g.nonce);
    expect((await callback(app, { code: 'c', state: g.state }, g.jar)).status).toBe(302);
    await withGlobal((db) => db.query('update oauth_pending set user_id = null, via_google_cookie_hash = null where id = $1', [id]));
    const before = exchanges.length;
    const again = await callback(app, { code: 'c', state: g.state }, g.jar);
    expect(again.status).toBe(400);
    expect(exchanges.length).toBe(before);
    expect((await pendingRow(id))!.user_id).toBeNull();
  });

  it('state истёк — 400', async () => {
    const { app, id } = await startLogin();
    const g = await startGoogle(app, id);
    claims = goodClaims(`gl-exp-${uniq()}@gmail.test`, g.nonce);
    await withGlobal((db) => db.query(`update oauth_google_states set expires_at = now() - interval '1 second' where pending_id = $1`, [id]));
    expect((await callback(app, { code: 'c', state: g.state }, g.jar)).status).toBe(400);
    expect((await pendingRow(id))!.user_id).toBeNull();
  });

  it('нет cookie (другой браузер) — 400 без формы, без обмена', async () => {
    const { app, id } = await startLogin();
    const g = await startGoogle(app, id);
    claims = goodClaims(`gl-nc-${uniq()}@gmail.test`, g.nonce);
    const before = exchanges.length;
    const cb = await callback(app, { code: 'c', state: g.state });
    expect(cb.status).toBe(400);
    expect(cb.text).toContain(FAILED_RU);
    expect(cb.text).not.toContain('<form');
    expect(exchanges.length).toBe(before);
    expect((await pendingRow(id))!.user_id).toBeNull();
  });

  it('чужой cookie — 400', async () => {
    const { app, id } = await startLogin();
    const g = await startGoogle(app, id);
    claims = goodClaims(`gl-wc-${uniq()}@gmail.test`, g.nonce);
    const cb = await callback(app, { code: 'c', state: g.state }, `${cookieName(id)}=${b64url(randomBytes(32))}`);
    expect(cb.status).toBe(400);
    expect((await pendingRow(id))!.user_id).toBeNull();
  });

  it('человек отменил у Google (access_denied) — страница входа с обеими возможностями', async () => {
    const { app, id } = await startLogin();
    const g = await startGoogle(app, id);
    const before = exchanges.length;
    const cb = await callback(app, { error: 'access_denied', state: g.state }, g.jar);
    expect(cb.status).toBe(200);
    expect(cb.text).toContain('Вход через Google отменён.');
    expect(cb.text).toContain(`href="/oauth/google/start/${id}"`);
    expect(cb.text).toContain(`action="/oauth/login/${id}/email"`);
    expect(exchanges.length).toBe(before);
    expect((await pendingRow(id))!.user_id).toBeNull();
  });

  it('обмен у Google упал — 502 с предложением войти кодом', async () => {
    const { app, id } = await startLogin();
    const g = await startGoogle(app, id);
    tokenReply = async () => ({ status: 400, json: { error: 'invalid_grant', error_description: 'Bad Request' } });
    const cb = await callback(app, { code: 'c', state: g.state }, g.jar);
    expect(cb.status).toBe(502);
    expect(cb.text).toContain(FAILED_RU);
    expect(cb.text).toContain(`action="/oauth/login/${id}/email"`);
    expect((await pendingRow(id))!.user_id).toBeNull();
  });

  it('демо-адрес через Google не входит', async () => {
    process.env.DEMO_LOGIN_EMAIL = 'demo-google@taskano.app';
    process.env.DEMO_LOGIN_CODE_SHA256 = sha('TSK-DEMO-ABCDEFGHJKMNPQRSTUVW');
    for (const email of ['demo-google@taskano.app', 'demo@taskano.app', 'emma.clarke@demo.taskano.app']) {
      const { app, id } = await startLogin();
      const g = await startGoogle(app, id);
      claims = goodClaims(email, g.nonce);
      const cb = await callback(app, { code: 'c', state: g.state }, g.jar);
      expect(cb.status, email).toBe(400);
      expect((await pendingRow(id))!.user_id, email).toBeNull();
    }
  });
});

describe('вход через Google: согласие привязано к браузеру', () => {
  async function googleSession() {
    const s = await startLogin();
    const g = await startGoogle(s.app, s.id);
    claims = goodClaims(`gl-cs-${uniq()}@gmail.test`, g.nonce);
    expect((await callback(s.app, { code: 'c', state: g.state }, g.jar)).status).toBe(302);
    return { ...s, jar: g.jar };
  }

  it('согласие сессии Google без cookie — 403, код не выдан', async () => {
    const { app, id } = await googleSession();
    const r = await request(app).post(`/oauth/login/${id}/consent`).set('Accept-Language', 'ru');
    expect(r.status).toBe(403);
    expect(r.text).toContain('Откройте вход заново в том же браузере.');
    expect(r.headers.location).toBeUndefined();
    expect(await pendingRow(id)).toBeDefined();
  });

  it('согласие сессии Google с чужим cookie — 403', async () => {
    const { app, id } = await googleSession();
    const r = await request(app).post(`/oauth/login/${id}/consent`).set('Cookie', `${cookieName(id)}=${b64url(randomBytes(32))}`);
    expect(r.status).toBe(403);
    expect(await pendingRow(id)).toBeDefined();
  });

  it.each([['ru', 'Начните вход заново'], ['en', 'Start the sign-in again'], ['tr', 'Girişi yeniden başlatın'], ['vi', 'Bắt đầu đăng nhập lại']])(
    'почта и код не перехватывают сессию Google — 409 (%s)', async (lang, text) => {
      const { app, id } = await googleSession();
      const before = (await pendingRow(id))!;
      const email = `gl-hijack-${uniq()}@test.local`;
      const e = await request(app).post(`/oauth/login/${id}/email`).type('form').send({ email }).set('Accept-Language', lang);
      expect(e.status).toBe(409);
      expect(e.text).toContain(`<a href="/oauth/login/${id}?restart=1">${text}</a>`);
      expect(outbox.some((m) => m.to === email)).toBe(false);
      const c = await request(app).post(`/oauth/login/${id}/code`).type('form').send({ code: '123456' }).set('Accept-Language', lang);
      expect(c.status).toBe(409);
      expect(c.text).toContain(text);
      expect(await pendingRow(id)).toEqual(before);
    });

  it('демо-адрес не перехватывает сессию Google', async () => {
    process.env.DEMO_LOGIN_EMAIL = 'demo-hijack@taskano.app';
    process.env.DEMO_LOGIN_CODE_SHA256 = sha('TSK-DEMO-ABCDEFGHJKMNPQRSTUVW');
    const { app, id } = await googleSession();
    const before = (await pendingRow(id))!;
    expect((await request(app).post(`/oauth/login/${id}/email`).type('form').send({ email: 'demo-hijack@taskano.app' })).status).toBe(409);
    expect(await pendingRow(id)).toEqual(before);
  });

  it('«Другая почта» снимает привязку: затем вход кодом — согласие как раньше', async () => {
    const { app, id } = await googleSession();
    await request(app).get(`/oauth/login/${id}?restart=1`);
    const email = `gl-rs-${uniq()}@test.local`;
    await request(app).post(`/oauth/login/${id}/email`).type('form').send({ email });
    const code = /(\d{6})/.exec(outbox.filter((m) => m.to === email).at(-1)!.text)![1]!;
    const entered = await request(app).post(`/oauth/login/${id}/code`).type('form').send({ code });
    expect(entered.status).toBe(200);
    expect((await request(app).post(`/oauth/login/${id}/consent`).set('Cookie', loginCookie(entered))).status).toBe(302);
  });

  it('сессия, вошедшая кодом: согласие только из браузера, который ввёл код (аудит 07.10)', async () => {
    const { app, id } = await startLogin();
    const email = `gl-code-${uniq()}@test.local`;
    await request(app).post(`/oauth/login/${id}/email`).type('form').send({ email });
    const code = /(\d{6})/.exec(outbox.filter((m) => m.to === email).at(-1)!.text)![1]!;
    const entered = await request(app).post(`/oauth/login/${id}/code`).type('form').send({ code });
    expect(entered.status).toBe(200);
    // Тот, кто знает pending_id (сам начал вход и прислал ссылку), без cookie согласия не получит.
    const stranger = await request(app).post(`/oauth/login/${id}/consent`);
    expect(stranger.status).toBe(403);
    const forged = await request(app).post(`/oauth/login/${id}/consent`).set('Cookie', `tk_c_${id.slice(0, 8)}=forged`);
    expect(forged.status).toBe(403);
    const r = await request(app).post(`/oauth/login/${id}/consent`).set('Cookie', loginCookie(entered));
    expect(r.status).toBe(302);
    expect(new URL(r.headers.location!).searchParams.get('code')).toBeTruthy();
  });
});

describe('вход через Google: в логах нет секретов', () => {
  it('ни code, ни id_token, ни state, ни cookie, ни секрета клиента', async () => {
    const lines: string[] = [];
    const spies = (['info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(logger, m).mockImplementation(((...args: unknown[]) => { lines.push(JSON.stringify(args)); }) as never));
    try {
      const seen: string[] = [CLIENT_SECRET];
      // Успех, отказ по nonce, обмен упал, нет cookie, повтор.
      for (const scenario of ['ok', 'nonce', 'exchange', 'nocookie'] as const) {
        const { app, id } = await startLogin();
        const g = await startGoogle(app, id);
        const code = `gcode-${uniq()}-${scenario}`;
        claims = goodClaims(`gl-log-${uniq()}@gmail.test`, scenario === 'nonce' ? 'bad' : g.nonce);
        const token = await idToken();
        tokenReply = scenario === 'exchange'
          ? async () => ({ status: 500, json: { error: 'server_error', error_description: token } })
          : async () => ({ status: 200, json: { id_token: token } });
        seen.push(code, token, g.state, g.cookie, g.nonce);
        await callback(app, { code, state: g.state }, scenario === 'nocookie' ? undefined : g.jar);
        await callback(app, { code, state: g.state }, g.jar);
      }
      expect(lines.length).toBeGreaterThan(0);
      const all = lines.join('\n');
      for (const s of seen) expect(all.includes(s), 'в логе секрет').toBe(false);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

describe('вход через Google: уборка', () => {
  it('runCleanup удаляет истёкшие сессии входа и старые состояния Google, живые не трогает', async () => {
    const { app, id: live } = await startLogin();
    const fresh = await startGoogle(app, live);
    const stale = await startGoogle(app, live);
    const { id: dead } = await startLogin();
    const deadState = await startGoogle(app, dead);
    await withGlobal(async (db) => {
      await db.query(`update oauth_google_states set expires_at = now() - interval '2 days' where state_hash = $1`, [sha(stale.state)]);
      await db.query(`update oauth_pending set expires_at = now() - interval '1 minute' where id = $1`, [dead]);
    });
    const { runCleanup } = await import('../src/worker/cleanup.js');
    await runCleanup(new Date());
    const states = await withGlobal(async (db) => (await db.query(
      'select state_hash from oauth_google_states where state_hash = any($1)', [[sha(fresh.state), sha(stale.state), sha(deadState.state)]])).rows
      .map((r) => r.state_hash as string));
    expect(states).toEqual([sha(fresh.state)]);
    expect(await pendingRow(live)).toBeDefined();
    expect(await pendingRow(dead)).toBeUndefined();
  });
});
