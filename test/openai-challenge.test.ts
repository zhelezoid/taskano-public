import { afterAll, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import './helpers.js';
import { closePools } from '../src/db/pool.js';
import { createApp } from '../src/web/app.js';

// Подтверждение домена в каталоге ChatGPT: OpenAI читает токен по /.well-known/openai-apps-challenge —
// ровно строку, text/plain. Без настроенного токена адреса нет.

afterAll(closePools);
afterEach(() => { delete process.env.OPENAI_APPS_CHALLENGE; });

describe('/.well-known/openai-apps-challenge', () => {
  it('без токена — 404', async () => {
    const r = await request(createApp()).get('/.well-known/openai-apps-challenge');
    expect(r.status).toBe(404);
  });

  it('с токеном — ровно токен, text/plain', async () => {
    process.env.OPENAI_APPS_CHALLENGE = ' tok_abc123 ';
    const r = await request(createApp()).get('/.well-known/openai-apps-challenge');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/plain/);
    expect(r.text).toBe('tok_abc123');
  });
});
