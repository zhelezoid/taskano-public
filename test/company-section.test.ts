import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import './helpers.js';
import { closePools, withGlobal } from '../src/db/pool.js';
import { miniappRoutes } from '../src/web/miniapp-api.js';
import { createProject } from '../src/core/projects.js';
import { createTask } from '../src/core/tasks.js';
import { addPerson, inOrg, makeOrg, uniq } from './helpers.js';

// Раздел «Компания» (спека miniapp-company): люди, доски и их состав, агенты. Проверяем теми же
// ручками, что зовёт приложение, и смотрим на факт в базе, а не на ответ ручки.

afterAll(closePools);

const BOT_TOKEN = 'test-bot-token-company';
const app = express();
miniappRoutes(app, { botToken: BOT_TOKEN });
const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };

let tgSeq = 890000000;
const nextTg = (): number => (tgSeq += 1);

function initDataFor(telegramUserId: number): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: telegramUserId, first_name: 'Test' }),
  });
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

async function linkTelegram(userId: string, telegramUserId: number): Promise<void> {
  await withGlobal((db) => db.query(
    `insert into telegram_links(user_id, telegram_user_id, chat_id) values ($1, $2, $3)
     on conflict (user_id) do update set telegram_user_id = excluded.telegram_user_id`,
    [userId, telegramUserId, telegramUserId]));
}

const post = (tgId: number, url: string) => request(app).post(url).set('X-Telegram-Init-Data', initDataFor(tgId));
const get = (tgId: number, url: string) => request(app).get(url).set('X-Telegram-Init-Data', initDataFor(tgId));

/** Владелец компании и рядовой исполнитель, оба в Telegram: так их видит приложение. */
async function scene() {
  const { orgId, ownerId } = await makeOrg();
  const ownerTg = nextTg();
  await linkTelegram(ownerId, ownerTg);
  const person = await addPerson(orgId, 'member');
  const personTg = nextTg();
  await linkTelegram(person, personTg);
  return { orgId, ownerId, ownerTg, person, personTg };
}

describe('раздел «Компания» (спека miniapp-company)', () => {
  it('владелец видит людей, проекты и агентов; рядовой исполнитель — «не найдено»', async () => {
    const s = await scene();
    const mine = await get(s.ownerTg, '/app/api/company').expect(200);
    expect(mine.body.role).toBe('owner');
    expect(mine.body.people.length).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(mine.body.projects)).toBe(true);
    // Границу держит ручка, а не спрятанная кнопка.
    await get(s.personTg, '/app/api/company').expect(404);
  });

  it('свою строку человек видит помеченной — кнопки «вывести» у неё нет', async () => {
    const s = await scene();
    const r = await get(s.ownerTg, '/app/api/company').expect(200);
    const mine = r.body.people.find((p: any) => p.id === s.ownerId);
    expect(mine.me).toBe(true);
    expect(r.body.people.filter((p: any) => p.me).length).toBe(1);
  });
  // Итоги (спека stats-page): своя ручка, но та же граница — исполнителю только его числа.
  it('итоги: владелец видит компанию, исполнитель — только себя', async () => {
    const s = await scene();
    const all = await get(s.ownerTg, '/app/api/stats?period=today').expect(200);
    expect(all.body.whole_org).toBe(true);
    expect(all.body.totals).toEqual({ done: 0, submitted: 0, dropped: 0, minutes: 0 });
    expect(all.body.people.length).toBeGreaterThanOrEqual(2);

    const mine = await get(s.personTg, '/app/api/stats?period=today').expect(200);
    expect(mine.body.whole_org).toBe(false);
    expect(mine.body.people).toHaveLength(1);
  });

  // Обещание «остальные видят только себя» держала половина страницы: людей фильтровали, а
  // перечень проектов с числом дел отдавали целиком — по компании, а не по смотрящему.
  it('итоги: рядовой видит проекты со своими делами и свои числа в них', async () => {
    const s = await scene();
    const project = await inOrg(s.orgId, (db) => createProject(db, { name: `Общий ${uniq()}` },
      { kind: 'user', userId: s.ownerId }), s.ownerId);
    // Дело владельца в проекте — рядовому его видеть в числах не положено.
    await inOrg(s.orgId, (db) => createTask(db, {
      ...base, title: 'дело владельца', assigneeUserId: s.ownerId, project: project.id, release: true,
    }, { kind: 'user', userId: s.ownerId }), s.ownerId);

    const alien = await get(s.personTg, '/app/api/stats?period=today').expect(200);
    expect(alien.body.projects.find((p: any) => p.id === project.id)).toBeUndefined();

    // Появилось своё дело — проект показывается, но с одним делом, а не с двумя.
    await inOrg(s.orgId, (db) => createTask(db, {
      ...base, title: 'дело исполнителя', assigneeUserId: s.person, project: project.id, release: true,
    }, { kind: 'user', userId: s.ownerId }), s.ownerId);

    const mine = await get(s.personTg, '/app/api/stats?period=today').expect(200);
    expect(mine.body.projects.find((p: any) => p.id === project.id).open).toBe(1);
    const owner = await get(s.ownerTg, '/app/api/stats?period=today').expect(200);
    expect(owner.body.projects.find((p: any) => p.id === project.id).open).toBe(2);
  });

  it('итоги: неизвестный период — понятный отказ, календарный месяц назван', async () => {
    const s = await scene();
    const bad = await get(s.ownerTg, '/app/api/stats?period=forever');
    expect(bad.status).toBe(400);
    const month = await get(s.ownerTg, '/app/api/stats?period=this_month').expect(200);
    expect(month.body.label).toBeTruthy();
  });
  it('владелец видит в «Компании» свою реальную загрузку, включая закрытую доску', async () => {
    const s = await scene();
    const project = await inOrg(s.orgId, (db) => createProject(db, { name: `Мой ${uniq()}`, private: true },
      { kind: 'user', userId: s.ownerId }), s.ownerId);
    await inOrg(s.orgId, (db) => createTask(db, {
      ...base, title: 'Своё закрытое дело', assigneeUserId: s.ownerId, project: project.id, release: true,
    }, { kind: 'user', userId: s.ownerId }), s.ownerId);

    // Второе дело ждёт очереди: «сколько на человеке» — это и то, что в работе, и то, что впереди.
    await inOrg(s.orgId, (db) => createTask(db, {
      ...base, title: 'Второе своё дело', assigneeUserId: s.ownerId, project: project.id, release: true,
    }, { kind: 'user', userId: s.ownerId }), s.ownerId);

    const r = await get(s.ownerTg, '/app/api/company').expect(200);
    const me = r.body.people.find((p: any) => p.me);
    // Ноль при живых делах — то, что владелец видел до этой правки: ручной фильтр приватности
    // стоял поверх правила видимости и прятал от человека его собственное. Пять при тридцати пяти —
    // вторая половина той же ошибки: очередь в счёт не шла.
    expect(me.open).toBe(2);
  });
  it('приложение не управляет компанией: административных ручек нет вовсе', async () => {
    const s = await scene();
    // Людей и проекты заводят разговором с агентом — там называют, кто человек и что он закрывает,
    // а форма из трёх полей этого не даёт.
    await post(s.ownerTg, '/app/api/company/people').send({ email: 'x@test.local' }).expect(404);
    await post(s.ownerTg, '/app/api/company/projects').send({ name: 'Новый' }).expect(404);
    await post(s.ownerTg, `/app/api/company/people/${s.person}/offboard`).send({}).expect(404);
  });

  it('свой профиль человек правит сам — у него может не быть агента вовсе', async () => {
    const s = await scene();
    // Рядовой исполнитель в раздел «Компания» не ходит, но о себе сказать вправе — и это
    // единственная ручка раздела, которая его пускает (ревью: проверка «200 или 404» пропускала
    // ровно тот случай, ради которого правило вводилось).
    const mine = await post(s.personTg, `/app/api/company/people/${s.person}/about`)
      .send({ org: s.orgId, about: 'Закупки по Турции' }).expect(200);
    expect(mine.body.about).toBe('Закупки по Турции');
    // А чужую строку рядовой не трогает: это решение владельца, и держит его ядро.
    const alien = await post(s.personTg, `/app/api/company/people/${s.ownerId}/about`)
      .send({ org: s.orgId, about: 'переписал начальника' });
    expect([403, 404]).toContain(alien.status);
    const byOwner = await post(s.ownerTg, `/app/api/company/people/${s.person}/about`)
      .send({ org: s.orgId, about: 'Закупки по Турции и Вьетнаму' }).expect(200);
    expect(byOwner.body.about).toBe('Закупки по Турции и Вьетнаму');
  });
});
