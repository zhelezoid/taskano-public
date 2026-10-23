import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/web/app.js';

// Лендинг taskano.app: корень отдаёт английскую страницу со ссылкой на публичный skill.
describe('лендинг', () => {
  it('GET / — страница на английском, ссылка на репозиторий skill, без встраивания во фрейм', async () => {
    const r = await request(createApp()).get('/');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.text).toContain('<html lang="en">');
    expect(r.text).toContain('https://github.com/example-org/taskano-skill');
    expect(r.headers['x-frame-options']).toBe('DENY');
  });

  // Правовые страницы: их требует каталог коннекторов, и на них ссылается карточка коннектора —
  // битая ссылка там означает отказ в публикации. Подвал лендинга ведёт на них же.
  it('GET /privacy, /terms, /support — страницы на месте, с контактом поддержки', async () => {
    const app = createApp();
    for (const page of ['privacy', 'terms', 'support']) {
      const r = await request(app).get(`/${page}`);
      expect(r.status, page).toBe(200);
      expect(r.headers['content-type'], page).toMatch(/text\/html/);
      // Контакт поддержки обязателен на каждой: человек приходит с проблемой на любую из них.
      expect(r.text, page).toContain('support@taskano.app');
      expect(r.text, page).toContain('/legal.css');
    }
    expect((await request(app).get('/legal.css')).status).toBe(200);
  });

  it('подвал лендинга ведёт на правовые страницы', async () => {
    const r = await request(createApp()).get('/');
    for (const page of ['/privacy', '/terms', '/support']) {
      expect(r.text, page).toContain(`href="${page}"`);
    }
  });

  // Документация: на неё ведёт поле Documentation URL карточки в каталоге — битая ссылка там означает
  // отказ, а без адреса коннектора в тексте человеку не с чего начать.
  it('GET /docs — документация с адресом коннектора, и на неё ведут все страницы сайта', async () => {
    const app = createApp();
    const r = await request(app).get('/docs');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.text).toContain('https://taskano.app/mcp');
    expect(r.text).toContain('support@taskano.app');
    for (const page of ['/', '/privacy', '/terms', '/support']) {
      expect((await request(app).get(page)).text, page).toContain('href="/docs"');
    }
  });

  it('иконки для вкладки и «На экран Домой» отдаются и подключены на страницах', async () => {
    const app = createApp();
    for (const f of ['/favicon.png', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/logo-96.png']) {
      const r = await request(app).get(f);
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/image\/png/);
    }
    const m = await request(app).get('/site.webmanifest');
    expect(m.status).toBe(200);
    expect(JSON.parse(m.text).icons).toHaveLength(2);
    for (const page of ['/', '/docs', '/privacy', '/terms', '/support']) {
      expect((await request(app).get(page)).text).toContain('rel="apple-touch-icon"');
    }
  });
});
