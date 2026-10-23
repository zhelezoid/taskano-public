import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { loginCookie } from './helpers.js';
import { closePools, withGlobal } from '../src/db/pool.js';
import { createApp } from '../src/web/app.js';
import { outbox, sendEmail } from '../src/email/send.js';
import { assertDemoEnv } from '../src/config/env.js';
import { issueLoginCode, verifyLoginCode } from '../src/core/login-codes.js';
import { DEMO_CODE_RE, demoCodeHash, generateDemoCode } from '../src/core/demo-code.js';
import { viaCloudflare } from './mcp-client.js';

// Спека demo-access: постоянный код для одного адреса, чтобы ревьюер каталога вошёл без почты.

afterAll(closePools);

// Свой адрес, а не demo@taskano.app: test/demo-seed.test.ts параллельно шлёт коды тому.
const DEMO = 'demo-login@taskano.app';
const CODE = 'TSK-DEMO-ABCDEFGHJKMNPQRSTUVW';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function enableDemo(): void {
  process.env.DEMO_LOGIN_EMAIL = DEMO;
  process.env.DEMO_LOGIN_CODE_SHA256 = sha(CODE);
}
function disableDemo(): void {
  delete process.env.DEMO_LOGIN_EMAIL;
  delete process.env.DEMO_LOGIN_CODE_SHA256;
}

/** Страница входа OAuth: DCR → authorize → id сессии входа. Своё приложение — свой потолок запросов. */
async function startLogin(app = createApp()): Promise<{ app: ReturnType<typeof createApp>; id: string }> {
  const reg = await request(app).post('/register').send({
    client_name: 'claude.ai', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  });
  const auth = await request(app).get('/authorize').query({
    client_id: reg.body.client_id, response_type: 'code', redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource: 'http://localhost:3000/mcp',
  });
  return { app, id: new URL(auth.headers.location!).pathname.split('/').pop()! };
}

const mailsTo = (to: string) => outbox.filter((m) => m.to === to).length;
const consentShown = (html: string) => html.includes('/consent');

describe('демо-вход', () => {
  beforeEach(enableDemo);
  afterEach(disableDemo);

  it('верный код ведёт к согласию, письмо не уходит', async () => {
    const before = mailsTo(DEMO);
    const { app, id } = await startLogin();
    const e = await request(app).post(`/oauth/login/${id}/email`).type('form').send({ email: ' Demo-Login@Taskano.app ' });
    expect(e.status).toBe(200);
    expect(e.text).not.toContain('pattern=');
    const c = await request(app).post(`/oauth/login/${id}/code`).type('form').send({ code: ` ${CODE.toLowerCase()} ` });
    expect(c.status).toBe(200);
    expect(consentShown(c.text)).toBe(true);
    const consent = await request(app).post(`/oauth/login/${id}/consent`).set('Cookie', loginCookie(c));
    expect(new URL(consent.headers.location!).searchParams.get('code')).toBeTruthy();
    expect(mailsTo(DEMO)).toBe(before);
    const issued = await withGlobal((db) => db.query('select 1 from login_codes where pending_id = $1', [id]));
    expect(issued.rowCount).toBe(0);
    const audit = await withGlobal((db) => db.query(`select payload from admin_audit where action = 'demo_login' and payload->>'pending_id' = $1`, [id]));
    expect(audit.rowCount).toBe(1);
  });

  it('неверный код — отказ, и пятьдесят ошибок не запирают верный код', async () => {
    let { app, id } = await startLogin();
    await request(app).post(`/oauth/login/${id}/email`).type('form').send({ email: DEMO });
    for (let i = 0; i < 51; i++) {
      // Потолок 20 POST в минуту с адреса — свойство экземпляра приложения; меняем экземпляр, а не код.
      if (i % 17 === 16) app = createApp();
      const r = await request(app).post(`/oauth/login/${id}/code`).type('form').send({ code: `TSK-DEMO-WRONG${i}` });
      expect(r.status).toBe(400);
      expect(consentShown(r.text)).toBe(false);
    }
    const ok = await request(createApp()).post(`/oauth/login/${id}/code`).type('form').send({ code: CODE });
    expect(consentShown(ok.text)).toBe(true);
  });

  it('отказы не пишутся в аудит строкой на каждый запрос', async () => {
    const { app, id } = await startLogin();
    await request(app).post(`/oauth/login/${id}/email`).type('form').send({ email: DEMO });
    for (let i = 0; i < 3; i++) await request(app).post(`/oauth/login/${id}/code`).type('form').send({ code: `nope${i}` });
    const audit = await withGlobal((db) => db.query(`select 1 from admin_audit where action = 'demo_login' and payload->>'pending_id' = $1`, [id]));
    expect(audit.rowCount).toBe(0);
  });

  it('хэш пустой строки не открывает вход пустым кодом', async () => {
    process.env.DEMO_LOGIN_CODE_SHA256 = sha('');
    const { app, id } = await startLogin();
    await request(app).post(`/oauth/login/${id}/email`).type('form').send({ email: DEMO });
    const r = await request(app).post(`/oauth/login/${id}/code`).type('form').send({ code: '' });
    expect(consentShown(r.text)).toBe(false);
  });

  it('код из demo-code входит, как бы его ни вставили', async () => {
    const code = generateDemoCode();
    expect(code).toMatch(DEMO_CODE_RE);
    process.env.DEMO_LOGIN_CODE_SHA256 = demoCodeHash(code);
    const { app, id } = await startLogin();
    await request(app).post(`/oauth/login/${id}/email`).type('form').send({ email: DEMO });
    const r = await request(app).post(`/oauth/login/${id}/code`).type('form').send({ code: ` ${code.toLowerCase().slice(0, 12)} ${code.toLowerCase().slice(12)} ` });
    expect(consentShown(r.text)).toBe(true);
  });

  it('страница кода не обещает письма', async () => {
    const { app, id } = await startLogin();
    const r = await request(app).post(`/oauth/login/${id}/email`).type('form').set('Accept-Language', 'en').send({ email: DEMO });
    expect(r.text).toContain('Demo access code');
    expect(r.text).not.toContain('from the email');
  });

  it('обычный адрес с демо-кодом не входит', async () => {
    const email = `someone-${Date.now()}@test.local`;
    const { app, id } = await startLogin();
    await request(app).post(`/oauth/login/${id}/email`).type('form').send({ email });
    expect(mailsTo(email)).toBe(1);
    const r = await request(app).post(`/oauth/login/${id}/code`).type('form').send({ code: CODE });
    expect(r.status).toBe(400);
    expect(consentShown(r.text)).toBe(false);
  });

  it('вход в бота демо-кодом не работает', async () => {
    const ok = await withGlobal(async (db) => {
      await issueLoginCode(db, DEMO, 'bot');
      return verifyLoginCode(db, DEMO, CODE, { purpose: 'bot' });
    });
    expect(ok).toBe(false);
  });
});

describe('демо-вход выключен', () => {
  // Минутная пауза между письмами на один адрес — не то, что здесь проверяется.
  beforeEach(async () => {
    disableDemo();
    await withGlobal((db) => db.query('delete from login_codes where email = $1', [DEMO]));
  });

  it('без переменных демо-адрес получает обычный код письмом, а демо-код не подходит', async () => {
    const before = mailsTo(DEMO);
    const { app, id } = await startLogin();
    const e = await request(app).post(`/oauth/login/${id}/email`).type('form').send({ email: DEMO });
    expect(e.text).toContain('pattern=');
    expect(mailsTo(DEMO)).toBe(before + 1);
    const r = await request(app).post(`/oauth/login/${id}/code`).type('form').send({ code: CODE });
    expect(consentShown(r.text)).toBe(false);
  });

  it('одна почта без хэша демо не включает', async () => {
    process.env.DEMO_LOGIN_EMAIL = DEMO;
    const before = mailsTo(DEMO);
    const { app, id } = await startLogin();
    await request(app).post(`/oauth/login/${id}/email`).type('form').send({ email: DEMO });
    expect(mailsTo(DEMO)).toBe(before + 1);
    disableDemo();
  });
});

describe('почта демо-компании', () => {
  afterEach(disableDemo);
  const mail = (to: string) => ({ to, subject: 's', html: 'h', text: 't' });

  it('вымышленным людям письма не уходят', async () => {
    const to = `ali-${Date.now()}@demo.taskano.app`;
    await sendEmail(mail(to));
    expect(mailsTo(to)).toBe(0);
  });

  it('демо-адресу при включённом демо письма не уходят, при выключенном — уходят', async () => {
    const before = mailsTo(DEMO);
    enableDemo();
    await sendEmail(mail(DEMO));
    expect(mailsTo(DEMO)).toBe(before);
    disableDemo();
    await sendEmail(mail(DEMO));
    expect(mailsTo(DEMO)).toBe(before + 1);
  });

  it('обычному адресу письмо уходит', async () => {
    const to = `real-${Date.now()}@test.local`;
    await sendEmail(mail(to));
    expect(mailsTo(to)).toBe(1);
  });
});

describe('проверка окружения', () => {
  afterEach(disableDemo);

  it('сам код вместо хэша — старт падает', () => {
    process.env.DEMO_LOGIN_CODE_SHA256 = CODE;
    expect(() => assertDemoEnv()).toThrow(/64 hex/);
    process.env.DEMO_LOGIN_CODE_SHA256 = sha(CODE);
    expect(() => assertDemoEnv()).not.toThrow();
  });

  it('хэш пустой строки — старт падает', () => {
    process.env.DEMO_LOGIN_CODE_SHA256 = sha('');
    expect(() => assertDemoEnv()).toThrow(/пустой/);
  });

  it('постоянный код на адресе настоящего человека — старт падает', () => {
    process.env.DEMO_LOGIN_CODE_SHA256 = sha(CODE);
    process.env.DEMO_LOGIN_EMAIL = 'oleg@example.com';
    expect(() => assertDemoEnv()).toThrow(/demo…@taskano.app/);
    process.env.DEMO_LOGIN_EMAIL = 'demo@taskano.app';
    expect(() => assertDemoEnv()).not.toThrow();
  });
});

describe('потолок запросов входа за Cloudflare', () => {
  it('считается по адресу клиента, а не по узлу Cloudflare', async () => {
    const app = createApp();
    const post = (ip: string) => request(app).post('/oauth/login/00000000-0000-0000-0000-000000000000/code')
      .set(viaCloudflare(ip)).type('form').send({ code: 'x' });
    for (let i = 0; i < 20; i++) expect((await post('203.0.113.7')).status).not.toBe(429);
    expect((await post('203.0.113.7')).status).toBe(429);
    // Другой человек через тот же узел Cloudflare не заперт.
    expect((await post('198.51.100.9')).status).not.toBe(429);
  });
});
