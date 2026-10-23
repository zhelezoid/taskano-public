import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import './helpers.js';
import { closePools } from '../src/db/pool.js';
import { createApp } from '../src/web/app.js';

// Спека oauth-login-page: рядом с формой входа — что даёт Taskano, на языке браузера; форма та же,
// и ничего с чужих адресов (на странице вводится вход).

afterAll(closePools);

/** DCR → authorize → id сессии входа, как это делает claude.ai. */
async function startLogin(): Promise<{ app: ReturnType<typeof createApp>; id: string }> {
  const app = createApp();
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

const CASES = [
  { header: 'ru-RU,ru;q=0.9,en;q=0.8', lang: 'ru', title: 'Вход в Taskano', promo: 'Срок называет исполнитель', button: 'Взять' },
  { header: 'tr-TR,tr;q=0.9', lang: 'tr', title: 'Taskano girişi', promo: 'Tarihi işi yapan belirler', button: 'Üstlen' },
  { header: 'vi-VN,vi;q=0.9', lang: 'vi', title: 'Đăng nhập Taskano', promo: 'Người làm tự chọn hạn', button: 'Nhận việc' },
  { header: 'en-US,en;q=0.9', lang: 'en', title: 'Sign in to Taskano', promo: 'The doer names the due date', button: 'Take' },
  { header: 'de-DE,de;q=0.9', lang: 'en', title: 'Sign in to Taskano', promo: 'The doer names the due date', button: 'Take' },
] as const;

describe('страница входа OAuth', () => {
  it.each(CASES)('Accept-Language $header → $lang', async ({ header, lang, title, promo, button }) => {
    const { app, id } = await startLogin();
    const r = await request(app).get(`/oauth/login/${id}`).set('Accept-Language', header);
    expect(r.status).toBe(200);
    expect(r.text).toContain(`<html lang="${lang}">`);
    expect(r.text).toContain(`<h1>${title}</h1>`);
    expect(r.text).toContain(promo);
    expect(r.text).toContain(`<span>${button}</span>`);
    expect(r.text).toContain('NOR-004');
    expect(r.text).toContain('src="/logo-96.png?v=2"');
  });

  it('форма почты — прежние action и name', async () => {
    const { app, id } = await startLogin();
    const r = await request(app).get(`/oauth/login/${id}`);
    expect(r.text).toContain(`<form method="post" action="/oauth/login/${id}/email">`);
    expect(r.text).toMatch(/<input id="e" name="email" type="email"[^>]*required/);
    // Пример в рекламе не должен выглядеть для тестов и людей как ещё одна форма.
    expect(r.text.match(/<form/g)).toHaveLength(1);
    expect(r.text.match(/<input/g)).toHaveLength(1);
  });

  it('форма кода — прежние action и name', async () => {
    const { app, id } = await startLogin();
    const r = await request(app).post(`/oauth/login/${id}/email`).type('form').send({ email: `lp-${Date.now()}@test.local` });
    expect(r.status).toBe(200);
    expect(r.text).toContain(`<form method="post" action="/oauth/login/${id}/code">`);
    expect(r.text).toMatch(/<input id="c" name="code"/);
    expect(r.text).toContain(`href="/oauth/login/${id}?restart=1"`);
  });

  it('истёкшая сессия — 410 и тот же вид страницы', async () => {
    const r = await request(createApp()).get('/oauth/login/00000000-0000-0000-0000-000000000000').set('Accept-Language', 'ru');
    expect(r.status).toBe(410);
    expect(r.text).toContain('Сессия входа истекла');
    expect(r.text).toContain('class="promo"');
  });

  it('ничего не грузится с чужих адресов: ни скриптов, ни шрифтов, ни картинок', async () => {
    const { app, id } = await startLogin();
    for (const l of ['ru', 'tr', 'vi', 'en']) {
      const r = await request(app).get(`/oauth/login/${id}`).set('Accept-Language', l);
      expect(r.text).not.toMatch(/<script/i);
      expect(r.text).not.toMatch(/<(link|img|iframe|source|video|audio|embed|object)\b[^>]*\b(src|href)="(https?:)?\/\//i);
      expect(r.text).not.toMatch(/url\(|@import|@font-face/i);
      // Все ссылки — на этот же сервер.
      for (const m of r.text.matchAll(/\b(?:src|href|action)="([^"]*)"/g)) expect(m[1], m[0]).toMatch(/^\//);
    }
  });

  it('заголовки защиты те же: без встраивания во фрейм, без кэша', async () => {
    const { app, id } = await startLogin();
    const r = await request(app).get(`/oauth/login/${id}`);
    expect(r.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['cache-control']).toBe('no-store');
  });
});
