import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import './helpers.js';
import { closePools } from '../src/db/pool.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { makeOrg } from './helpers.js';
import { withGlobal } from '../src/db/pool.js';
import { outbox } from '../src/email/send.js';
import { readFileSync } from 'node:fs';
import { invitationMail } from '../src/email/templates/invitation.js';
import { type Lang } from '../app/src/i18n.js';

// Приглашение уходит письмом, и другого входа нет (спека roles-and-rights). Значит система обязана
// сама потребовать адрес: без этого агент отвечал владельцу «дайте её Telegram» и заводил разговор
// в тупик — ника и телефона для приглашения не существует.

afterAll(closePools);

async function invite(userId: string, args: Record<string, unknown>): Promise<string> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildMcpServer({ userId }).connect(serverT);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientT);
  const r = await client.callTool({ name: 'invite_person', arguments: args as never })
    .catch((e: unknown) => ({ content: [{ text: String(e) }] }));
  return JSON.stringify(r);
}

// Язык письма — указанный приглашающим, иначе язык компании (спека translation-and-email): человека
// турецкой компании незачем звать английским письмом.
describe('язык приглашения', () => {
  it('приглашающий язык не назвал — письмо уходит на языке компании', async () => {
    const { orgId, ownerId } = await makeOrg();
    await withGlobal((db) => db.query(`update orgs set language = 'tr' where id = $1`, [orgId]));
    outbox.length = 0;

    await invite(ownerId, { email: `worker-${Date.now()}@example.com` });

    const mail = outbox.find((m) => m.subject.includes('şirketinde'));
    expect(mail, JSON.stringify(outbox.map((m) => m.subject))).toBeTruthy();
    expect(mail!.text).toContain('Botta girişinizi onaylayın');
  });
});

describe('приглашение требует адрес почты', () => {
  it('почту не назвали — система просит её, а не молчит про недостающее поле', async () => {
    const { ownerId } = await makeOrg();

    const r = await invite(ownerId, { name: 'Мария' });

    expect(r).toMatch(/email address is required/i);
    expect(r).toMatch(/ask them for it/i);
  });

  it('Telegram-ник и телефон почтой не считаются, и это сказано прямо', async () => {
    const { ownerId } = await makeOrg();

    for (const wrong of ['@maria_tg', '+79990001122', 'Мария']) {
      const r = await invite(ownerId, { email: wrong, name: 'Мария' });
      expect(r, wrong).toMatch(/only be sent to an email address/i);
      expect(r, wrong).toMatch(/Telegram handle/i);
    }
  });
});

// Письмо — единственное, что человек видит до первого дела: из него он должен понять, кто и куда его
// позвал, как устроена работа и как открыть приложение с телефона (спеки telegram-bot, mini-app).
describe('письмо приглашённому', () => {
  const LANGS: Lang[] = ['ru', 'en', 'tr', 'vi'];
  const made = (lang: string) => invitationMail('worker@example.com', {
    inviterName: 'Олег', orgName: 'Contoso', personName: 'Мария',
    link: 'https://t.me/taskano_bot?start=inv_tok',
  }, lang);

  it('называет компанию и того, кто позвал, — в теме и в письме, на каждом языке', () => {
    for (const lang of LANGS) {
      const m = made(lang);
      expect(m.subject, lang).toContain('Олег');
      expect(m.subject, lang).toContain('Contoso');
      for (const body of [m.html!, m.text!]) {
        expect(body, lang).toContain('Олег');
        expect(body, lang).toContain('Contoso');
        expect(body, lang).toContain('Мария');
      }
    }
  });

  it('на каждом языке объясняет, как вынести приложение на экран телефона', () => {
    for (const lang of LANGS) {
      const m = made(lang);
      // Ярлык ставится меню самого Telegram — своей кнопки у приложения нет (она сбивала с толку).
      expect(m.html, lang).toContain('…');
      expect(m.text, lang).toContain('…');
      // Одинаково на обеих системах: человек не должен гадать, про его ли телефон речь.
      expect(m.html, lang).toMatch(/iPhone/);
      expect(m.html, lang).toMatch(/Android/i);
    }
  });

  // Письмо называет кнопки, которые человек будет искать глазами. Разошлись строки — человек ищет
  // «Готово», а на карточке «Завершить», и инструкция превращается в помеху.
  it('надписи кнопок в письме — те же, что в боте и в приложении', () => {
    for (const lang of LANGS) {
      const html = made(lang).html!;
      const bot = JSON.parse(readFileSync(new URL(`../src/i18n/${lang}.json`, import.meta.url), 'utf8'));
      expect(html, `${lang} btn.done`).toContain(bot['btn.done']);
      expect(html, `${lang} menu.app_button`).toContain(bot['menu.app_button']);
    }
  });

  it('управляющему не обещают, что он видит только свои дела', () => {
    for (const role of ['owner', 'admin'] as const) {
      const m = invitationMail('boss@example.com', {
        inviterName: 'Олег', orgName: 'Contoso', role, link: 'https://t.me/b?start=inv_t',
      }, 'ru');
      expect(m.text, role).not.toContain('Вы видите только свои дела');
      expect(m.text, role).toContain('всей компании');
    }
    // Рядовому — ровно наоборот: чужого он не увидит, и это стоит сказать.
    expect(made('ru').text).toContain('Вы видите только свои дела');
  });

  it('ссылка на бота — в письме и в текстовой версии, и она одна', () => {
    const m = made('en');
    expect(m.text).toContain('https://t.me/taskano_bot?start=inv_tok');
    const hrefs = [...m.html!.matchAll(/href="([^"]+)"/g)].map((h) => h[1]);
    expect(hrefs).toEqual(['https://t.me/taskano_bot?start=inv_tok']);
  });

  it('в нерусских языках нет русских кавычек-ёлочек', () => {
    for (const lang of ['en', 'tr', 'vi']) {
      const m = made(lang);
      expect(`${m.subject}${m.text}${m.html}`, lang).not.toMatch(/[«»]/);
    }
  });

  it('шрифтовой стек с одинарными кавычками: двойные оборвали бы атрибут style', () => {
    for (const lang of ['ru', 'en', 'tr', 'vi']) {
      const html = made(lang).html!;
      expect(html, lang).toContain("'Segoe UI'");
      expect(html, lang).not.toContain('"Segoe UI"');
    }
  });
});
