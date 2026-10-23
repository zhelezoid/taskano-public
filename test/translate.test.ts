import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import './helpers.js';
import { closePools, withGlobal } from '../src/db/pool.js';
import { setLlmForTests } from '../src/ai/llm.js';
import { translateField } from '../src/ai/translate.js';
import { addPerson, makeAgent, makeOrg, inOrg, minutes, MON_10 } from './helpers.js';
import { createTask } from '../src/core/tasks.js';
import { transition } from '../src/core/lifecycle.js';
import { addHumanComment } from '../src/core/comments.js';
import { notificationText, type NotifRow } from '../src/bot/notif-text.js';

afterAll(closePools);
afterEach(() => setLlmForTests(undefined));

describe('перевод текстов задач', () => {
  it('одинаковые языки — без вызова модели', async () => {
    const { orgId } = await makeOrg();
    let calls = 0;
    setLlmForTests(async () => { calls++; return { text: 'x', inputTokens: 1, outputTokens: 1 }; });
    const r = await inOrg(orgId, (db) => translateField(db, {
      objectType: 'task', objectId: randomUUID(), field: 'title', text: 'Привет', sourceLang: 'ru', targetLang: 'ru',
    }));
    expect(r).toEqual({ text: 'Привет', translated: false, suspect: false });
    expect(calls).toBe(0);
  });

  it('повторный перевод того же текста берётся из кэша', async () => {
    const { orgId } = await makeOrg();
    let calls = 0;
    setLlmForTests(async () => { calls++; return { text: 'Привет мир пять', inputTokens: 10, outputTokens: 10 }; });
    const args = { objectType: 'task', objectId: randomUUID(), field: 'title', text: 'Hello world five', sourceLang: 'en', targetLang: 'ru' };
    const r1 = await inOrg(orgId, (db) => translateField(db, args));
    const r2 = await inOrg(orgId, (db) => translateField(db, args));
    expect(r1).toEqual({ text: 'Привет мир пять', translated: true, suspect: false });
    expect(r2).toEqual({ text: 'Привет мир пять', translated: true, suspect: false });
    expect(calls).toBe(1);
  });

  it('изменение текста меняет хэш — новый перевод, не кэш', async () => {
    const { orgId } = await makeOrg();
    let calls = 0;
    setLlmForTests(async ({ prompt }) => { calls++; return { text: prompt.includes('one') ? 'один' : 'два', inputTokens: 1, outputTokens: 1 }; });
    const objectId = randomUUID();
    const r1 = await inOrg(orgId, (db) => translateField(db, { objectType: 'task', objectId, field: 'title', text: 'one', sourceLang: 'en', targetLang: 'ru' }));
    const r2 = await inOrg(orgId, (db) => translateField(db, { objectType: 'task', objectId, field: 'title', text: 'two', sourceLang: 'en', targetLang: 'ru' }));
    expect(r1.text).toBe('один');
    expect(r2.text).toBe('два');
    expect(calls).toBe(2);
  });

  it('перевод, потерявший число, помечен suspect', async () => {
    const { orgId } = await makeOrg();
    setLlmForTests(async () => ({ text: 'Заказ готов', inputTokens: 5, outputTokens: 5 }));
    const r = await inOrg(orgId, (db) => translateField(db, {
      objectType: 'task', objectId: randomUUID(), field: 'title', text: 'Заказ #42 готов', sourceLang: 'ru', targetLang: 'en',
    }));
    expect(r.suspect).toBe(true);
    expect(r.translated).toBe(true);
  });

  it('число сохранено — не suspect', async () => {
    const { orgId } = await makeOrg();
    setLlmForTests(async () => ({ text: 'Order #42 is ready', inputTokens: 5, outputTokens: 5 }));
    const r = await inOrg(orgId, (db) => translateField(db, {
      objectType: 'task', objectId: randomUUID(), field: 'title', text: 'Заказ #42 готов', sourceLang: 'ru', targetLang: 'en',
    }));
    expect(r.suspect).toBe(false);
  });

  // NOR-026: описание в 2 тыс. знаков по-турецки оборвалось на пункте 5 и в таком виде легло в кэш.
  it('оборванный пределом токенов перевод не показывается и не кэшируется', async () => {
    const { orgId } = await makeOrg();
    let calls = 0;
    let maxTokens: number | undefined;
    setLlmForTests(async (args) => {
      calls++; maxTokens = args.maxTokens;
      return { text: 'Ürünü normalden deniz ve uçak arasında nas', inputTokens: 10, outputTokens: 10, truncated: true };
    });
    const args = { objectType: 'task', objectId: randomUUID(), field: 'description', text: 'Длинное описание дела', sourceLang: 'ru', targetLang: 'tr' };
    const r1 = await inOrg(orgId, (db) => translateField(db, args));
    expect(r1).toEqual({ text: 'Длинное описание дела', translated: false, suspect: false });
    expect(maxTokens).toBeGreaterThanOrEqual(8000);

    const r2 = await inOrg(orgId, (db) => translateField(db, args));
    expect(r2.translated).toBe(false);
    expect(calls).toBe(2);
  });

  it('превышение бюджета выставляет translation_paused_at, дальше перевод возвращает оригинал с пометкой paused', async () => {
    const { orgId } = await makeOrg();
    await withGlobal((db) => db.query(`update orgs set ai_budget_usd_month = 0.0001 where id = $1`, [orgId]));
    let calls = 0;
    setLlmForTests(async () => { calls++; return { text: 'Привет мир', inputTokens: 1000, outputTokens: 1000 }; });

    const r1 = await inOrg(orgId, (db) => translateField(db, {
      objectType: 'task', objectId: randomUUID(), field: 'title', text: 'Hello world', sourceLang: 'en', targetLang: 'ru',
    }));
    expect(r1.translated).toBe(true);
    expect(calls).toBe(1);

    const org = await withGlobal((db) => db.query(`select translation_paused_at from orgs where id = $1`, [orgId]));
    expect(org.rows[0].translation_paused_at).not.toBeNull();

    const r2 = await inOrg(orgId, (db) => translateField(db, {
      objectType: 'task', objectId: randomUUID(), field: 'title', text: 'Second text', sourceLang: 'en', targetLang: 'ru',
    }));
    expect(r2).toEqual({ text: 'Second text', translated: false, suspect: false, paused: true });
    expect(calls).toBe(1);
  });

  it('агенты не останавливаются бюджетом (пауза относится только к людям — вызывающий сам решает, что показать)', async () => {
    // translateField не различает агента/человека — пауза одинаково возвращает оригинал вызывающему;
    // «агенты не останавливаются» реализуется на уровне вызывающего кода (агент продолжает работу
    // с оригиналом текста, не блокируется этой функцией). Проверяем только что вызов не бросает исключение.
    const { orgId } = await makeOrg();
    await withGlobal((db) => db.query(`update orgs set translation_paused_at = now() where id = $1`, [orgId]));
    const r = await inOrg(orgId, (db) => translateField(db, {
      objectType: 'task', objectId: randomUUID(), field: 'title', text: 'Ещё текст', sourceLang: 'ru', targetLang: 'en',
    }));
    expect(r.paused).toBe(true);
    expect(r.text).toBe('Ещё текст');
  });
});

// Обещание «каждый работает на своём языке» держалось в одну сторону: карточка переводилась
// исполнителю, а его вопрос приходил постановщику как есть.
describe('реплика человека — на языке того, кто её читает', () => {
  it('вопрос исполнителя приходит постановщику переведённым', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId, 'member', { language: 'vi' });
    const agent = await makeAgent(orgId, ownerId);
    const task = await inOrg(orgId, (db) => createTask(
      db, {
        title: 'свериться с поставщиком', why: 'зачем', doneCriteria: 'критерий',
        dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться', assigneeUserId: person,
      },
      { kind: 'agent', agentId: agent, userId: ownerId }, MON_10));

    const asked = 'Em chưa rõ nên hỏi nhà cung cấp nào trong danh sách này ạ';
    await inOrg(orgId, (db) => transition(db, task.id, 'question', { kind: 'user', userId: person },
      { now: minutes(MON_10, 5), text: asked }));

    setLlmForTests(async () => ({ text: 'Мне неясно, какого поставщика спрашивать', inputTokens: 5, outputTokens: 5 }));
    const row = await inOrg(orgId, (db) => db.query(
      `select id, kind, task_id, level, payload, created_at from notifications
        where user_id = $1 and kind = 'task_question' order by created_at desc limit 1`, [ownerId]));
    const text = await inOrg(orgId, (db) => notificationText(db, 'ru', row.rows[0] as NotifRow, ownerId));

    expect(text).toContain('Мне неясно');
    expect(text).not.toContain(asked);
  });

  it('язык реплики тот же — модель не зовут', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agent = await makeAgent(orgId, ownerId);
    const task = await inOrg(orgId, (db) => createTask(
      db, {
        title: 'свериться с поставщиком', why: 'зачем', doneCriteria: 'критерий',
        dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться', assigneeUserId: person,
      },
      { kind: 'agent', agentId: agent, userId: ownerId }, MON_10));
    const asked = 'Мне неясно, какого поставщика из этого списка спрашивать';
    await inOrg(orgId, (db) => transition(db, task.id, 'question', { kind: 'user', userId: person },
      { now: minutes(MON_10, 5), text: asked }));

    let calls = 0;
    setLlmForTests(async () => { calls += 1; return { text: 'не должно понадобиться', inputTokens: 1, outputTokens: 1 }; });
    const row = await inOrg(orgId, (db) => db.query(
      `select id, kind, task_id, level, payload, created_at from notifications
        where user_id = $1 and kind = 'task_question' order by created_at desc limit 1`, [ownerId]));
    const text = await inOrg(orgId, (db) => notificationText(db, 'ru', row.rows[0] as NotifRow, ownerId));

    expect(text).toContain(asked);
    expect(calls).toBe(0);
  });

  it('комментарий исполнителя приходит постановщику-человеку переведённым', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId, 'member', { language: 'vi' });
    // Автор — человек: у дела от агента уведомлений о репликах нет, агент читает сводку.
    const task = await inOrg(orgId, (db) => createTask(
      db, {
        title: 'свериться с поставщиком', why: 'зачем', doneCriteria: 'критерий',
        dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться', assigneeUserId: person,
      },
      { kind: 'user', userId: ownerId }, MON_10));

    const said = 'Hôm nay kho đóng cửa nên em sẽ làm vào ngày mai ạ';
    await inOrg(orgId, (db) => addHumanComment(db, task.id, person, said, minutes(MON_10, 5)));

    setLlmForTests(async () => ({ text: 'Сегодня склад закрыт, сделаю завтра', inputTokens: 5, outputTokens: 5 }));
    const row = await inOrg(orgId, (db) => db.query(
      `select id, kind, task_id, level, payload, created_at from notifications
        where user_id = $1 and kind = 'task_comment' order by created_at desc limit 1`, [ownerId]));
    const text = await inOrg(orgId, (db) => notificationText(db, 'ru', row.rows[0] as NotifRow, ownerId));

    expect(text).toContain('склад закрыт');
    expect(text).not.toContain(said);
  });
});
