import { afterAll, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { closePools, withGlobal } from '../src/db/pool.js';
import { createApp } from '../src/web/app.js';
import { runnerRoutes } from '../src/web/runner-page.js';
import { sha256, decrypt, randomToken } from '../src/core/crypto.js';
import { resetFetch, setFetchForTests } from '../src/runtime/fire.js';
import { inOrg, makeOrg } from './helpers.js';

// Страница подключения исполнителя `/runner/:token` (src/web/runner-page.ts, спека agent-runtime,
// «Настройка»): одноразовая ссылка, шифрование токена /fire, защита от SSRF (только https://api.anthropic.com).

afterAll(closePools);
afterEach(resetFetch);

const app = createApp({ extraRoutes: runnerRoutes });

async function makeLink(orgId: string, ownerId: string, opts: { expired?: boolean; usedAt?: Date } = {}): Promise<string> {
  const token = randomToken();
  const expiresAt = opts.expired ? new Date(Date.now() - 60000) : new Date(Date.now() + 30 * 60000);
  await withGlobal((db) => db.query(
    `insert into runner_links(token_hash, org_id, created_by, expires_at, used_at) values ($1, $2, $3, $4, $5)`,
    [sha256(token), orgId, ownerId, expiresAt, opts.usedAt ?? null],
  ));
  return token;
}

describe('GET /runner/:token', () => {
  it('валидная ссылка — 200 с формой', async () => {
    const { orgId, ownerId } = await makeOrg();
    const token = await makeLink(orgId, ownerId);
    const r = await request(app).get(`/runner/${token}`);
    expect(r.status).toBe(200);
    expect(r.text).toContain('<form');
    expect(r.text).toContain('fire_url');
  });

  it('неизвестный токен — ошибка без формы', async () => {
    const r = await request(app).get(`/runner/${randomToken()}`);
    expect(r.status).toBe(410);
    expect(r.text).not.toContain('<form');
  });

  it('истёкшая ссылка — ошибка без формы', async () => {
    const { orgId, ownerId } = await makeOrg();
    const token = await makeLink(orgId, ownerId, { expired: true });
    const r = await request(app).get(`/runner/${token}`);
    expect(r.status).toBe(410);
    expect(r.text).not.toContain('<form');
  });

  it('уже использованная ссылка — ошибка без формы', async () => {
    const { orgId, ownerId } = await makeOrg();
    const token = await makeLink(orgId, ownerId, { usedAt: new Date() });
    const r = await request(app).get(`/runner/${token}`);
    expect(r.status).toBe(410);
    expect(r.text).not.toContain('<form');
  });

  it('язык страницы — по Accept-Language, по умолчанию английский', async () => {
    const { orgId, ownerId } = await makeOrg();
    const token = await makeLink(orgId, ownerId);
    const en = await request(app).get(`/runner/${token}`);
    expect(en.text).toContain('<html lang="en"');
    expect(en.text).toContain('Connect the runner');
    const ru = await request(app).get(`/runner/${token}`).set('Accept-Language', 'ru-RU,ru;q=0.9');
    expect(ru.text).toContain('<html lang="ru"');
    expect(ru.text).toContain('Подключение исполнителя');
    const tr = await request(app).get(`/runner/${token}`).set('Accept-Language', 'tr');
    expect(tr.text).toContain('<html lang="tr"');
  });

  it('токен с HTML-метасимволами отражается в форме только в закодированном виде', async () => {
    const { orgId, ownerId } = await makeOrg();
    const evilToken = '"><script>alert(1)</script>';
    await withGlobal((db) => db.query(
      `insert into runner_links(token_hash, org_id, created_by, expires_at) values ($1, $2, $3, now() + interval '30 minutes')`,
      [sha256(evilToken), orgId, ownerId],
    ));
    const r = await request(app).get(`/runner/${encodeURIComponent(evilToken)}`);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('<script>alert(1)</script>');
    expect(r.text).toContain(encodeURIComponent(evilToken));
  });
});

describe('POST /runner/:token — защита fire_url (SSRF)', () => {
  const badUrls = [
    ['не https', 'http://api.anthropic.com/v1/routines/r1/fire'],
    ['другой хост', 'https://evil.com/v1/routines/r1/fire'],
    ['похожий поддомен-обманка', 'https://api.anthropic.com.evil.com/v1/routines/r1/fire'],
    // Классический трюк с userinfo: до `@` — обманка, реальный host (после `@`) — чужой.
    ['userinfo-трюк (хост после @ чужой)', 'https://api.anthropic.com@evil.com/v1/routines/r1/fire'],
  ] as const;

  for (const [label, url] of badUrls) {
    it(`${label}: ${url} — отказ, runners не записан`, async () => {
      const { orgId, ownerId } = await makeOrg();
      const token = await makeLink(orgId, ownerId);
      const r = await request(app).post(`/runner/${token}`).type('form').send({ fire_url: url, fire_token: 'secret-1' });
      expect(r.status).toBe(400);
      expect(r.text).toContain('<form'); // форма остаётся — можно попробовать ещё раз
      const runner = await inOrg(orgId, (db) => db.query('select 1 from runners where org_id = $1', [orgId]));
      expect(runner.rowCount).toBe(0);
      // Ссылка не была потрачена неудачной попыткой — по ней снова можно открыть форму.
      const again = await request(app).get(`/runner/${token}`);
      expect(again.status).toBe(200);
    });
  }

  // Примечание: `https://evil.com@api.anthropic.com/…` — здесь `evil.com` до `@` это userinfo,
  // а не host. По WHATWG URL host = api.anthropic.com — валидатор (new URL().hostname) корректно
  // видит настоящий api.anthropic.com и пропускает такой адрес. См. отчёт субагента.
  it('userinfo перед реальным хостом (evil.com@api.anthropic.com) — реально указывает на api.anthropic.com, принимается', async () => {
    const { orgId, ownerId } = await makeOrg();
    const token = await makeLink(orgId, ownerId);
    setFetchForTests(async () => new Response(null, { status: 200 }));
    const r = await request(app).post(`/runner/${token}`)
      .type('form').send({ fire_url: 'https://evil.com@api.anthropic.com/v1/routines/r1/fire', fire_token: 'secret-userinfo' });
    expect(r.status).toBe(200);
    const runner = await inOrg(orgId, (db) => db.query('select fire_url from runners where org_id = $1', [orgId]));
    expect(runner.rowCount).toBe(1);
    expect(new URL(runner.rows[0].fire_url).hostname).toBe('api.anthropic.com');
  });

  it('пустой токен без валидного fire_url тоже отклоняется', async () => {
    const { orgId, ownerId } = await makeOrg();
    const token = await makeLink(orgId, ownerId);
    const r = await request(app).post(`/runner/${token}`).type('form').send({ fire_url: 'https://api.anthropic.com/v1/r/fire', fire_token: '' });
    expect(r.status).toBe(400);
    const runner = await inOrg(orgId, (db) => db.query('select 1 from runners where org_id = $1', [orgId]));
    expect(runner.rowCount).toBe(0);
  });
});

describe('POST /runner/:token — успешное подключение', () => {
  it('валидный POST шифрует токен, помечает ссылку использованной, повтор отклоняется', async () => {
    const { orgId, ownerId } = await makeOrg();
    const otherOrg = (await makeOrg()).orgId;
    const token = await makeLink(orgId, ownerId);
    const calls: string[] = [];
    setFetchForTests(async (url) => { calls.push(String(url)); return new Response(null, { status: 200 }); });

    const plainToken = 'super-secret-fire-token';
    const r = await request(app).post(`/runner/${token}`)
      .type('form').send({ fire_url: 'https://api.anthropic.com/v1/routines/r1/fire', fire_token: plainToken });
    expect(r.status).toBe(200);
    expect(r.text).toContain('The runner is connected');
    expect(calls).toHaveLength(1); // пробный /fire при подключении

    const runner = await inOrg(orgId, (db) => db.query('select fire_token_enc from runners where org_id = $1', [orgId]));
    expect(runner.rowCount).toBe(1);
    const enc = runner.rows[0].fire_token_enc as string;
    expect(enc).not.toBe(plainToken);
    expect(enc).not.toContain(plainToken);
    expect(decrypt(enc, orgId)).toBe(plainToken);
    expect(() => decrypt(enc, otherOrg)).toThrow();

    const link = await withGlobal((db) => db.query('select used_at from runner_links where token_hash = $1', [sha256(token)]));
    expect(link.rows[0].used_at).not.toBeNull();

    // Повторный POST по той же (уже использованной) ссылке — отказ, второй /fire-вызов не делается.
    const r2 = await request(app).post(`/runner/${token}`)
      .type('form').send({ fire_url: 'https://api.anthropic.com/v1/routines/r2/fire', fire_token: 'another-token' });
    expect(r2.status).toBe(410);
    expect(r2.text).not.toContain('<form');
    expect(calls).toHaveLength(1); // второй /fire не звонили
    const runnerAfter = await inOrg(orgId, (db) => db.query('select fire_url from runners where org_id = $1', [orgId]));
    expect(runnerAfter.rows[0].fire_url).toBe('https://api.anthropic.com/v1/routines/r1/fire'); // не перезаписан
  });

  it('два одновременных POST по одной ссылке — проходит ровно один (аудит 07.10)', async () => {
    const { orgId, ownerId } = await makeOrg();
    const token = await makeLink(orgId, ownerId);
    setFetchForTests(async () => new Response(null, { status: 200 }));
    const send = (n: string) => request(app).post(`/runner/${token}`)
      .type('form').send({ fire_url: `https://api.anthropic.com/v1/routines/${n}/fire`, fire_token: `t-${n}` });
    const [a, b] = await Promise.all([send('a'), send('b')]);
    expect([a.status, b.status].sort()).toEqual([200, 410]);
  });

  it('пробный /fire вернул 401 — подключение отклонено как broken', async () => {
    const { orgId, ownerId } = await makeOrg();
    const token = await makeLink(orgId, ownerId);
    setFetchForTests(async () => new Response(null, { status: 401 }));
    const r = await request(app).post(`/runner/${token}`)
      .type('form').send({ fire_url: 'https://api.anthropic.com/v1/routines/r1/fire', fire_token: 'bad-token' });
    expect(r.status).toBe(400);
    expect(r.text).toContain('401');
    const runner = await inOrg(orgId, (db) => db.query(`select status from runners where org_id = $1`, [orgId]));
    expect(runner.rows[0].status).toBe('broken');
  });
});
