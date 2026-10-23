import { createHmac, randomUUID } from 'node:crypto';
import express from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './helpers.js';
import { closePools, withGlobal } from '../src/db/pool.js';
import { setLlmForTests } from '../src/ai/llm.js';
import {
  releaseTranslateScheduler, setTranslateSchedulerForTests, type TranslateTaskPayload,
} from '../src/ai/translate-queue.js';
import { logger } from '../src/log.js';
import { sha256 } from '../src/core/crypto.js';
import { addMember, ensureUserByEmail } from '../src/core/people.js';
import { addHumanComment } from '../src/core/comments.js';
import { answerQuestion, transition } from '../src/core/lifecycle.js';
import { requestDue } from '../src/core/due.js';
import { createTask, updateTask, type TaskPatch } from '../src/core/tasks.js';
import { miniappRoutes } from '../src/web/miniapp-api.js';
import { runTranslateJob } from '../src/worker/translate.js';
import { addPerson, inOrg, makeAgent, makeOrg, makeUser } from './helpers.js';
import { callTool, connectClient } from './mcp-client.js';

// Перевод дела заранее (спека translation-prefetch): фоновая задача translate_task греет
// кэш, карточка переводит недостающее параллельно, а время открытия видно в журнале.

afterAll(closePools);

const BOT_TOKEN = 'test-bot-token-prefetch';
const app = express();
miniappRoutes(app, { botToken: BOT_TOKEN });

const TR = {
  title: 'Müşteri siparişini kontrol et',
  why: 'Müşteri bekliyor ve sipariş gecikti',
  doneCriteria: 'Sipariş durumu müşteriye bildirildi',
  description: 'Tabloyu aç, sipariş numarasını bul, kargo durumunu kontrol et ve müşteriye yaz.',
  dueDate: '2026-12-31',
  sourceLanguage: 'tr',
};
const NOTES = ['Tamam, bakıyorum', 'Kargo firması cevap vermedi', 'Yarın tekrar arayacağım'];

let tgSeq = 860000000;
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

interface Scene { orgId: string; ownerId: string; person: string; tg: number }

/** Русскоязычный исполнитель с привязкой к Telegram и русскоязычный автор: дело на турецком им чужое. */
async function scene(): Promise<Scene> {
  const { orgId, ownerId } = await makeOrg();
  const person = await addPerson(orgId, 'member');
  const tg = (tgSeq += 1);
  await withGlobal((db) => db.query(
    `insert into telegram_links(user_id, telegram_user_id, chat_id) values ($1, $2, $2)`, [person, tg]));
  return { orgId, ownerId, person, tg };
}

async function turkishTask(s: Scene, notes = NOTES): Promise<string> {
  const task = await inOrg(s.orgId, (db) => createTask(db, { ...TR, assigneeUserId: s.person }, { kind: 'user', userId: s.ownerId }), s.ownerId);
  for (const text of notes) {
    await inOrg(s.orgId, (db) => db.query(
      `insert into task_messages(org_id, task_id, author_user_id, kind, text, source_language)
       values (current_setting('app.org_id')::uuid, $1, $2, 'comment', $3, 'tr')`, [task.id, s.ownerId, text]), s.ownerId);
  }
  return task.id;
}

const open = (s: Scene, taskId: string) =>
  request(app).get(`/app/api/tasks/${taskId}`).set('X-Telegram-Init-Data', initDataFor(s.tg));

/** Модель-заглушка: считает вызовы, ждёт `delayMs`, отвечает «перевод: …». */
function stubModel(delayMs = 0) {
  const state = { calls: 0 };
  setLlmForTests(async ({ prompt }) => {
    state.calls++;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return { text: `перевод: ${prompt.replace(/<\/?text>/g, '')}`, inputTokens: 5, outputTokens: 5 };
  });
  return state;
}

/** Планировщик записью в массив: задачу «воркера» тест запускает сам. */
function captureJobs(): TranslateTaskPayload[] {
  const jobs: TranslateTaskPayload[] = [];
  setTranslateSchedulerForTests(async (p) => { jobs.push(p); });
  return jobs;
}

beforeEach(() => { setTranslateSchedulerForTests(async () => {}); });
afterEach(() => {
  setLlmForTests(undefined);
  setTranslateSchedulerForTests(async () => {});
  vi.restoreAllMocks();
});

describe('открытие карточки: модель зовётся только за недостающим', () => {
  it('повторное открытие переведённой карточки не зовёт модель', async () => {
    const s = await scene();
    const taskId = await turkishTask(s);
    const model = stubModel();
    const info = vi.spyOn(logger, 'info');

    const first = await open(s, taskId);
    expect(first.status).toBe(200);
    expect(first.body.task.is_translated).toBe(true);
    expect(first.body.task.title).toBe(`перевод: ${TR.title}`);
    expect(first.body.notes).toHaveLength(3);
    expect(model.calls).toBe(7); // 4 поля + 3 записи
    const afterFirst = model.calls;

    const second = await open(s, taskId);
    expect(second.status).toBe(200);
    expect(second.body.task.title).toBe(`перевод: ${TR.title}`);
    expect(model.calls).toBe(afterFirst); // ни одного нового вызова
    const logged = info.mock.calls.filter((c) => c[1] === 'mini app: карточка открыта').map((c) => c[0] as { llm: number });
    expect(logged.map((l) => l.llm)).toEqual([7, 0]);
  });

  it('с пустым кэшем 4 поля и 2 записи переводятся параллельно, а не друг за другом', async () => {
    const s = await scene();
    const taskId = await turkishTask(s, NOTES.slice(0, 2));
    const model = stubModel(300);

    const t0 = Date.now();
    const res = await open(s, taskId);
    const ms = Date.now() - t0;

    expect(res.status).toBe(200);
    expect(model.calls).toBe(6);
    // По очереди было бы 4 × 300 (поля) + 300 (записи) = 1500 мс.
    expect(ms).toBeLessThan(2 * 300);
    expect(res.body.task.description).toBe(`перевод: ${TR.description}`);
  });

  it('ручка пишет в журнал строку с ms, llm, task и lang', async () => {
    const s = await scene();
    const taskId = await turkishTask(s);
    stubModel();
    const info = vi.spyOn(logger, 'info');

    await open(s, taskId);

    const line = info.mock.calls.find((c) => c[1] === 'mini app: карточка открыта');
    expect(line).toBeDefined();
    expect(line![0]).toMatchObject({ llm: 7, task: taskId, lang: 'ru' });
    expect((line![0] as { ms: number }).ms).toBeGreaterThanOrEqual(0);
    expect(typeof (line![0] as { ms: number }).ms).toBe('number');
  });
});

describe('translate_task: перевод заранее', () => {
  it('после постановки дела на турецком задача заполняет кэш, и первое открытие идёт без модели', async () => {
    const s = await scene();
    const jobs = captureJobs();
    const model = stubModel();
    const taskId = await turkishTask(s);
    expect(jobs).toContainEqual({ orgId: s.orgId, taskId });

    await runTranslateJob({ orgId: s.orgId, taskId });
    const warmed = model.calls;
    expect(warmed).toBe(7);

    const res = await open(s, taskId);
    expect(res.status).toBe(200);
    expect(model.calls).toBe(warmed); // карточка модель не звала
    expect(res.body.task.title).toBe(`перевод: ${TR.title}`);
    expect(res.body.notes.map((n: { text: string }) => n.text).sort()).toEqual(NOTES.map((n) => `перевод: ${n}`).sort());
  });

  it('постановка дела не ждёт перевода: модель на 2 с, create_task отвечает быстрее секунды', async () => {
    const ownerEmail = `owner-${randomUUID()}@test.local`;
    const token = await connectClient(ownerEmail);
    const code = randomUUID();
    const pgc = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await pgc.connect();
    await pgc.query(`insert into product_invite_codes(code_hash, note, created_by) values ($1, 'test', 'test')`, [sha256(code)]);
    await pgc.end();
    const org = await callTool(token, 'create_org', { name: `Org ${randomUUID().slice(0, 6)}`, invite_code: code });
    const orgId = JSON.parse(org.body.result.content[0].text).org_id as string;
    // Исполнитель читает по-русски, дело турецкое: фоновой задаче есть что переводить.
    const assignee = `ru-${randomUUID()}@test.local`;
    await withGlobal(async (db) => {
      const { user } = await ensureUserByEmail(db, assignee, { language: 'ru', verified: true });
      await addMember(db, orgId, user.id, 'member');
    });

    const model = stubModel(2000);
    // «Воркер» в этом тесте — тот же процесс: задача стартует сразу, но создание ждать её не должно.
    let background: Promise<void> | undefined;
    setTranslateSchedulerForTests(async (p) => { background = runTranslateJob(p); });

    const t0 = Date.now();
    const made = await callTool(token, 'create_task', {
      org: orgId, title: TR.title, assignee, why: TR.why, done_criteria: TR.doneCriteria, due_date: TR.dueDate,
      description: TR.description, idempotency_key: randomUUID(),
      source: { kind: 'chat', title: 'разговор', quote: 'так и сказал' },
    });
    const ms = Date.now() - t0;

    expect(made.body.result.isError).toBeFalsy();
    expect(ms).toBeLessThan(1000);
    expect(background).toBeDefined();
    await background; // задача дошла до модели: быстрый ответ не оттого, что переводить было нечего
    expect(model.calls).toBeGreaterThan(0);
  }, 30000);

  it('ставится только после коммита: откат транзакции не оставляет задачи', async () => {
    const s = await scene();
    const jobs = captureJobs();

    await expect(inOrg(s.orgId, async (db) => {
      await createTask(db, { ...TR, assigneeUserId: s.person }, { kind: 'user', userId: s.ownerId });
      expect(jobs).toHaveLength(0); // внутри транзакции ещё не поставлено
      throw new Error('откат');
    }, s.ownerId)).rejects.toThrow('откат');
    expect(jobs).toHaveLength(0);

    await inOrg(s.orgId, (db) => createTask(db, { ...TR, assigneeUserId: s.person }, { kind: 'user', userId: s.ownerId }), s.ownerId);
    expect(jobs).toHaveLength(1);
  });

  it('правка текста дела ставит задачу, срок и приоритет — нет', async () => {
    const s = await scene();
    const taskId = await turkishTask(s, []);
    const jobs = captureJobs();
    const actor = { kind: 'user' as const, userId: s.ownerId };

    await inOrg(s.orgId, (db) => updateTask(db, taskId, { priority: 'urgent' }, actor), s.ownerId);
    await inOrg(s.orgId, (db) => updateTask(db, taskId, { dueDate: '2027-01-15' }, actor), s.ownerId);
    expect(jobs).toHaveLength(0);

    await inOrg(s.orgId, (db) => updateTask(db, taskId, { why: 'Yeni gerekçe: müşteri aradı' }, actor), s.ownerId);
    expect(jobs).toEqual([{ orgId: s.orgId, taskId }]);
  });

  it('запись реплики ставит задачу: комментарий, вопрос, ответ и просьба о сроке', async () => {
    const s = await scene();
    const taskId = await turkishTask(s, []);
    const jobs = captureJobs();
    const person = { kind: 'user' as const, userId: s.person };
    const owner = { kind: 'user' as const, userId: s.ownerId };

    await inOrg(s.orgId, (db) => addHumanComment(db, taskId, s.person, 'Kargo firmasını aradım, cevap yok'), s.ownerId);
    expect(jobs).toHaveLength(1);

    jobs.length = 0;
    await inOrg(s.orgId, (db) => transition(db, taskId, 'question', person, { text: 'Hangi müşteri için? Sipariş numarası yok' }), s.ownerId);
    expect(jobs).toHaveLength(1);

    jobs.length = 0;
    await inOrg(s.orgId, (db) => answerQuestion(db, taskId, owner, 'Ahmet Bey, sipariş 4812'), s.ownerId);
    expect(jobs).toHaveLength(1);

    jobs.length = 0;
    await inOrg(s.orgId, (db) => requestDue(db, { taskId, actor: owner, text: 'Bu iş için bir tarih söyle lütfen' }), s.ownerId);
    expect(jobs).toHaveLength(1);
  });

  it('переводит на языки исполнителя, автора и проверяющего, кроме языка источника', async () => {
    const { orgId, ownerId } = await makeOrg(await makeUser({ language: 'en' }));
    const assignee = await addPerson(orgId, 'member', { language: 'ru' });
    const reviewer = await addPerson(orgId, 'member', { language: 'vi' });
    const bystander = await addPerson(orgId, 'member', { language: 'de' }); // не участник дела — язык не берём
    const task = await inOrg(orgId, (db) => createTask(db, {
      ...TR, assigneeUserId: assignee, reviewerUserId: reviewer,
    }, { kind: 'user', userId: ownerId }), ownerId);
    void bystander;
    const prompts: string[] = [];
    setLlmForTests(async ({ system, prompt }) => {
      prompts.push(`${/на язык "(\w+)"/.exec(system ?? '')?.[1]}|${prompt}`);
      return { text: 'x', inputTokens: 1, outputTokens: 1 };
    });

    await runTranslateJob({ orgId, taskId: task.id });

    const langs = new Set(prompts.map((p) => p.split('|')[0]));
    expect(langs).toEqual(new Set(['ru', 'en', 'vi']));
    expect(prompts).toHaveLength(12); // 3 языка × 4 поля
    const cached = await inOrg(orgId, (db) => db.query(
      `select distinct lang from translations where object_id = $1`, [task.id]), ownerId);
    expect(cached.rows.map((r) => r.lang).sort()).toEqual(['en', 'ru', 'vi']);
  });

  it('дело на языке всех участников — ни одного похода к модели', async () => {
    const s = await scene();
    const task = await inOrg(s.orgId, (db) => createTask(db, {
      ...TR, title: 'Проверить заказ клиента', why: 'Клиент ждёт, заказ задержан', sourceLanguage: 'ru', assigneeUserId: s.person,
    }, { kind: 'user', userId: s.ownerId }), s.ownerId);
    const model = stubModel();

    await runTranslateJob({ orgId: s.orgId, taskId: task.id });

    expect(model.calls).toBe(0);
  });

  it('агент-автор: язык берётся у его хозяина, у агента языка нет', async () => {
    const { orgId, ownerId } = await makeOrg(await makeUser({ language: 'en' }));
    const assignee = await addPerson(orgId, 'member', { language: 'ru' });
    const agentId = await makeAgent(orgId, ownerId);
    const task = await inOrg(orgId, (db) => createTask(db, { ...TR, assigneeUserId: assignee },
      { kind: 'agent', agentId, userId: ownerId }), ownerId);
    const seen = new Set<string>();
    setLlmForTests(async ({ system }) => {
      seen.add(/на язык "(\w+)"/.exec(system ?? '')![1]!);
      return { text: 'x', inputTokens: 1, outputTokens: 1 };
    });

    await runTranslateJob({ orgId, taskId: task.id });

    expect(seen).toEqual(new Set(['ru', 'en']));
  });

  it('пауза бюджета: задача ничего не переводит и не падает', async () => {
    const s = await scene();
    const taskId = await turkishTask(s);
    await inOrg(s.orgId, (db) => db.query(`update orgs set translation_paused_at = now() where id = $1`, [s.orgId]));
    const model = stubModel();

    await expect(runTranslateJob({ orgId: s.orgId, taskId })).resolves.toBeUndefined();

    expect(model.calls).toBe(0);
  });

  it('ошибка модели: задача падает (graphile повторит), кэш не пополняется, повтор переводит только недостающее', async () => {
    const s = await scene();
    const taskId = await turkishTask(s);
    const cached = async () => (await inOrg(s.orgId, (db) => db.query(
      `select count(*)::int as n from translations t
        where t.object_id = $1 or t.object_id in (select id from task_messages where task_id = $1)`, [taskId]))).rows[0].n as number;

    // Модель лежит целиком: ничего не переведено, задача сообщает об этом исключением.
    setLlmForTests(async () => { throw new Error('модель недоступна'); });
    await expect(runTranslateJob({ orgId: s.orgId, taskId })).rejects.toThrow('не переведено 7');
    expect(await cached()).toBe(0);

    // Модель вернулась, но одна реплика ей не даётся: переведено шесть, задача снова падает.
    const calls: string[] = [];
    setLlmForTests(async ({ prompt }) => {
      calls.push(prompt);
      if (prompt.includes('Kargo')) throw new Error('429');
      return { text: `перевод: ${prompt}`, inputTokens: 1, outputTokens: 1 };
    });
    await expect(runTranslateJob({ orgId: s.orgId, taskId })).rejects.toThrow('не переведено 1');
    expect(await cached()).toBe(6);
    expect(calls).toHaveLength(7);

    // Повтор graphile: модель в порядке — зовётся только за недостающим, задача чистая.
    calls.length = 0;
    setLlmForTests(async ({ prompt }) => { calls.push(prompt); return { text: `перевод: ${prompt}`, inputTokens: 1, outputTokens: 1 }; });
    await expect(runTranslateJob({ orgId: s.orgId, taskId })).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('Kargo');
    expect(await cached()).toBe(7);
  });

  it('удалённое дело и мусорный payload — тихо, без исключения', async () => {
    const s = await scene();
    const model = stubModel();
    await expect(runTranslateJob({ orgId: s.orgId, taskId: randomUUID() })).resolves.toBeUndefined();
    await expect(runTranslateJob({ nope: 1 })).resolves.toBeUndefined();
    expect(model.calls).toBe(0);
  });
});

describe('translate_task: параллельность и границы', () => {
  it('задача переводит поля параллельно: 4 вызова по 300 мс укладываются меньше чем в 2 × 300', async () => {
    const s = await scene();
    const taskId = await turkishTask(s, []);
    const model = stubModel(300);

    const t0 = Date.now();
    await runTranslateJob({ orgId: s.orgId, taskId });
    const ms = Date.now() - t0;

    expect(model.calls).toBe(4);
    expect(ms).toBeLessThan(2 * 300);
  });

  it('одновременно к модели идёт не больше шести переводов из двадцати', async () => {
    const s = await scene();
    const taskId = await turkishTask(s, Array.from({ length: 16 }, (_, i) => `Not numarası ${i} için kontrol et`)); // 4 поля + 16 записей
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    setLlmForTests(async ({ prompt }) => {
      calls++;
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return { text: `перевод: ${prompt}`, inputTokens: 1, outputTokens: 1 };
    });

    await runTranslateJob({ orgId: s.orgId, taskId });

    expect(calls).toBe(20);
    expect(peak).toBe(6);
  });
});

describe('перевод и открытие карточки одновременно', () => {
  /** Следит из отдельного соединения: нет ли транзакции, которая стоит без дела дольше 40 мс — то есть
   *  ждёт модель (короткая транзакция между двумя запросами простаивает микросекунды). */
  async function watchIdleTransactions() {
    const watcher = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await watcher.connect();
    let worst = 0;
    let stopped = false;
    const loop = (async () => {
      while (!stopped) {
        const r = await watcher.query(
          `select count(*)::int as n from pg_stat_activity
            where datname = current_database() and pid <> pg_backend_pid()
              and state = 'idle in transaction' and now() - state_change > interval '40 milliseconds'`);
        worst = Math.max(worst, r.rows[0].n as number);
        await new Promise((r2) => setTimeout(r2, 10));
      }
    })();
    return { async stop() { stopped = true; await loop; await watcher.end(); return worst; } };
  }

  it('задача и карточка одного дела при случайных задержках модели: без взаимной блокировки, без вызовов модели в транзакции', async () => {
    const watch = await watchIdleTransactions();
    try {
      for (let i = 0; i < 8; i++) {
        const s = await scene();
        const taskId = await turkishTask(s);
        const perPrompt = new Map<string, number>();
        let calls = 0;
        setLlmForTests(async ({ prompt }) => {
          calls++;
          perPrompt.set(prompt, (perPrompt.get(prompt) ?? 0) + 1);
          await new Promise((r) => setTimeout(r, 50 + Math.random() * 400));
          return { text: `перевод: ${prompt.replace(/<\/?text>/g, '')}`, inputTokens: 1, outputTokens: 1 };
        });

        const [, res] = await Promise.all([runTranslateJob({ orgId: s.orgId, taskId }), open(s, taskId)]);

        expect(res.status).toBe(200);
        expect([TR.title, `перевод: ${TR.title}`]).toContain(res.body.task.title);
        const viewed = await inOrg(s.orgId, (db) => db.query('select 1 from task_views where user_id = $1 and task_id = $2', [s.person, taskId]));
        expect(viewed.rowCount).toBe(1);
        // Одно и то же поле могли перевести дважды (фон и карточка стартовали с пустым кэшем), но не больше.
        expect(perPrompt.size).toBe(7);
        for (const n of perPrompt.values()) expect(n).toBeLessThanOrEqual(2);
        expect(calls).toBeLessThanOrEqual(14);

        // Оба закончили — кэш полон, следующее открытие модель не зовёт.
        const again = await open(s, taskId);
        expect(again.body.task.title).toBe(`перевод: ${TR.title}`);
        expect(calls).toBeLessThanOrEqual(14);
        const after = calls;
        await open(s, taskId);
        expect(calls).toBe(after);
      }
    } finally {
      expect(await watch.stop()).toBe(0);
    }
  }, 60000);

  it('модель недоступна: карточка открывается с оригиналом, число вызовов — число попыток, отметка «открыл» записана', async () => {
    const s = await scene();
    const taskId = await turkishTask(s);
    setLlmForTests(async () => { throw new Error('модель недоступна'); });
    const info = vi.spyOn(logger, 'info');

    const res = await open(s, taskId);

    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe(TR.title);
    expect(res.body.task.description).toBe(TR.description);
    expect(res.body.task.is_translated).toBe(false);
    expect(res.body.notes.map((n: { text: string }) => n.text).sort()).toEqual([...NOTES].sort());
    const line = info.mock.calls.find((c) => c[1] === 'mini app: карточка открыта');
    expect(line![0]).toMatchObject({ llm: 7, task: taskId });
    const viewed = await inOrg(s.orgId, (db) => db.query('select 1 from task_views where user_id = $1 and task_id = $2', [s.person, taskId]));
    expect(viewed.rowCount).toBe(1);
  });
});

describe('какие записи ставят перевод', () => {
  it('правка каждого из полей title, why, done_criteria, description ставит задачу; одна дата — нет', async () => {
    const s = await scene();
    const taskId = await turkishTask(s, []);
    const jobs = captureJobs();
    const actor = { kind: 'user' as const, userId: s.ownerId };
    const patches: TaskPatch[] = [
      { title: 'Yeni başlık' }, { why: 'Yeni gerekçe' }, { doneCriteria: 'Yeni ölçüt' }, { description: 'Yeni açıklama: tabloyu aç' },
    ];

    for (const patch of patches) {
      jobs.length = 0;
      await inOrg(s.orgId, (db) => updateTask(db, taskId, patch, actor), s.ownerId);
      expect(jobs, JSON.stringify(patch)).toEqual([{ orgId: s.orgId, taskId }]);
    }

    jobs.length = 0;
    await inOrg(s.orgId, (db) => updateTask(db, taskId, { dueDate: '2027-02-01' }, actor), s.ownerId);
    expect(jobs).toHaveLength(0);
  });

  it('причина отказа и причина закрытия не ставят задачу — карточка их не показывает', async () => {
    const s = await scene();
    const person = { kind: 'user' as const, userId: s.person };
    const owner = { kind: 'user' as const, userId: s.ownerId };
    const declined = await turkishTask(s, []);
    const closed = await turkishTask(s, []);
    const jobs = captureJobs();

    await inOrg(s.orgId, (db) => transition(db, declined, 'decline', person, { text: 'Bu işi yapamam, erişimim yok' }), s.ownerId);
    const kinds = async (id: string) => (await inOrg(s.orgId, (db) => db.query('select kind from task_messages where task_id = $1', [id]), s.ownerId)).rows.map((r) => r.kind);
    expect(await kinds(declined)).toContain('decline_reason');
    expect(jobs).toHaveLength(0);

    await inOrg(s.orgId, (db) => transition(db, closed, 'close', owner, { text: 'Müşteri aradı, sorun çözüldü' }), s.ownerId);
    expect(await kinds(closed)).toContain('close_reason');
    expect(jobs).toHaveLength(0);
  });
});

describe('постановка в настоящую очередь graphile-worker', () => {
  it('jobKey tr:<дело>, очередь translate, две попытки; повторная постановка заменяет, а не множит', async () => {
    const s = await scene();
    setTranslateSchedulerForTests(undefined); // настоящий планировщик
    try {
      const sys = new pg.Client({ connectionString: process.env.DATABASE_SYSTEM_URL });
      await sys.connect();
      const rows = async (taskId: string) => (await sys.query(
        `select task_identifier, key, queue_name, max_attempts, run_at from graphile_worker.jobs where key = $1`, [`tr:${taskId}`])).rows;
      try {
        const taskId = await turkishTask(s, []);
        const first = await rows(taskId);
        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({ task_identifier: 'translate_task', key: `tr:${taskId}`, queue_name: 'translate', max_attempts: 2 });

        await new Promise((r) => setTimeout(r, 50));
        await inOrg(s.orgId, (db) => updateTask(db, taskId, { why: 'Yeni gerekçe: müşteri aradı' }, { kind: 'user', userId: s.ownerId }), s.ownerId);
        await inOrg(s.orgId, (db) => addHumanComment(db, taskId, s.person, 'Kargo firmasını aradım, cevap yok'), s.ownerId);

        const after = await rows(taskId);
        expect(after).toHaveLength(1); // правки схлопнулись в одну задачу
        // 'replace' ставит запуск заново; чужой режим (unsafe_dedupe) оставил бы первый запуск как был.
        expect(after[0].run_at.getTime()).toBeGreaterThan(first[0].run_at.getTime());
      } finally {
        await sys.end();
      }
    } finally {
      await releaseTranslateScheduler();
    }
  });
});
