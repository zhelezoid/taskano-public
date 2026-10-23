import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserFromGetMe } from 'grammy/types';
import { closePools, withGlobal, withOrgBackground } from '../src/db/pool.js';
import { createBot } from '../src/bot/bot.js';
import { createTask } from '../src/core/tasks.js';
import { notify } from '../src/core/notify.js';
import { runDelivery } from '../src/worker/delivery.js';
import { tickOrg } from '../src/worker/tick.js';
import { addPerson, inOrg, makeAgent, makeOrg, minutes, MON_10 } from './helpers.js';

// Уведомление, созданное в той же транзакции тика, что и доставка (напоминания таймеров): доставка
// читает его своим соединением и не видит. Раньше это помечалось доставленным — и напоминания о
// сроках не дошли ни до кого с запуска (29.09). Смысл один: такое уведомление не теряется. Доставка
// внутри незакрытой транзакции его откладывает; а тик доставляет после коммита — и оно уходит в том
// же тике (аудит архитектуры: доставка вынесена из общей транзакции тика).

afterAll(closePools);

const BOT_INFO = {
  id: 1, is_bot: true, first_name: 'Taskano', username: 'Taskano_bot', can_join_groups: true,
  can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: true,
} as UserFromGetMe;

let texts: string[];

beforeEach(() => {
  texts = [];
  const bot = createBot({ token: 'test-token', botInfo: BOT_INFO });
  bot.api.config.use(async (_prev, method, payload) => {
    const p = payload as { chat_id?: number; text?: string };
    if (method === 'sendMessage') {
      texts.push(String(p.text ?? ''));
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: p.chat_id, type: 'private' }, text: p.text } } as any;
    }
    return { ok: true, result: true } as any;
  });
});

describe('доставка уведомления из той же транзакции тика', () => {
  it('не теряется: в своём тике откладывается, в следующем уходит', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const tg = 700_000_000 + Math.floor(Math.random() * 1_000_000);
    await withGlobal((db) => db.query(
      'insert into telegram_links(telegram_user_id, user_id, chat_id) values ($1, $2, $1)', [tg, person]));
    const task = await inOrg(orgId, (db) => createTask(db, {
      title: 'сверить остатки', why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31',
      description: 'как делать: открыть таблицу', assigneeUserId: person,
    }, { kind: 'user', userId: ownerId }, MON_10));
    // Рабочее время человека: в тихие часы доставка откладывается по другой причине.
    const now = MON_10;

    // Как в tickOrg: создать и доставить в одной незакрытой транзакции.
    await withOrgBackground(orgId, async (db) => {
      await notify(db, { userId: person, kind: 'task_updated', level: 'work', taskId: task.id, dedupeKey: `same-tick:${task.id}`, deliverAfter: now });
      await runDelivery(db, orgId, now);
    });
    const after1 = await inOrg(orgId, (db) => db.query(
      `select delivered_at from notifications where dedupe_key = $1`, [`same-tick:${task.id}`]));
    expect(after1.rows[0].delivered_at).toBeNull();
    expect(texts.some((x) => x.includes('сверить остатки'))).toBe(false);

    // Следующий тик — строка закоммичена, уходит.
    await withOrgBackground(orgId, (db) => runDelivery(db, orgId, new Date(now.getTime() + 60_000)));
    const after2 = await inOrg(orgId, (db) => db.query(
      `select delivered_at from notifications where dedupe_key = $1`, [`same-tick:${task.id}`]));
    expect(after2.rows[0].delivered_at).not.toBeNull();
    expect(texts.some((x) => x.includes('сверить остатки'))).toBe(true);
  });

  it('tickOrg: напоминание, поставленное таймером, уходит в том же тике', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agent = await makeAgent(orgId, ownerId);
    const tg = 700_000_000 + Math.floor(Math.random() * 1_000_000);
    await withGlobal((db) => db.query(
      'insert into telegram_links(telegram_user_id, user_id, chat_id) values ($1, $2, $1)', [tg, person]));
    const task = await inOrg(orgId, (db) => createTask(db, {
      title: 'разложить накладные', why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31',
      description: 'как делать: открыть папку', assigneeUserId: person,
    }, { kind: 'agent', agentId: agent, userId: ownerId }, MON_10));
    expect(task.status).toBe('active');

    // 2 р.ч. без «Взять» — таймер ставит напоминание в транзакции тика, доставка идёт после коммита.
    await tickOrg(orgId, minutes(MON_10, 125));
    const r = await inOrg(orgId, (db) => db.query(
      `select delivered_at from notifications where kind = 'reminder' and task_id = $1`, [task.id]));
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].delivered_at).not.toBeNull();
    expect(texts.some((x) => x.includes('разложить накладные'))).toBe(true);
  });
});
