import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserFromGetMe } from 'grammy/types';
import { closePools, withGlobal, withOrgBackground } from '../src/db/pool.js';
import { createBot } from '../src/bot/bot.js';
import { createTask } from '../src/core/tasks.js';
import { notify } from '../src/core/notify.js';
import { runDelivery } from '../src/worker/delivery.js';
import { runAiBudget } from '../src/worker/budget.js';
import { tickOrg } from '../src/worker/tick.js';
import { addPerson, inOrg, makeAgent, makeOrg, minutes, MON_10 } from './helpers.js';

// Сообщение уходит в Telegram ровно один раз, даже если тик потом падает (аудит архитектуры, CRIT).
// Раньше отметку «доставлено» ставила транзакция тика, а само сообщение и строку `deliveries` —
// своя транзакция доставки: исключение позже в тике откатывало отметку, и следующий тик слал снова.

vi.mock('../src/worker/budget.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/worker/budget.js')>();
  return { ...orig, runAiBudget: vi.fn(orig.runAiBudget) };
});

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

const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу' };

async function linkTelegram(userId: string): Promise<void> {
  const tg = 710_000_000 + Math.floor(Math.random() * 1_000_000);
  await withGlobal((db) => db.query('insert into telegram_links(telegram_user_id, user_id, chat_id) values ($1, $2, $1)', [tg, userId]));
}

/** Уведомление о деле, уже закоммиченное до тика: доставка обязана его видеть. */
async function committedNotification(title: string) {
  const { orgId, ownerId } = await makeOrg();
  const person = await addPerson(orgId);
  await linkTelegram(person);
  const task = await inOrg(orgId, (db) => createTask(db, { ...base, title, assigneeUserId: person }, { kind: 'user', userId: ownerId }, MON_10));
  const key = `once:${task.id}`;
  await inOrg(orgId, (db) => notify(db, { userId: person, kind: 'task_updated', level: 'work', taskId: task.id, dedupeKey: key, deliverAfter: MON_10 }));
  return { orgId, key };
}

describe('доставка не повторяется после отката тика', () => {
  it('доставка, затем исключение в той же транзакции — отметка остаётся, второй проход не шлёт', async () => {
    const title = 'сверить кассу';
    const { orgId, key } = await committedNotification(title);

    await expect(withOrgBackground(orgId, async (db) => {
      await runDelivery(db, orgId, MON_10);
      throw new Error('упало после доставки');
    })).rejects.toThrow('упало после доставки');

    const row = (await inOrg(orgId, (db) => db.query('select delivered_at from notifications where dedupe_key = $1', [key]))).rows[0];
    expect(row.delivered_at).not.toBeNull();

    await withOrgBackground(orgId, (db) => runDelivery(db, orgId, minutes(MON_10, 1)));
    expect(texts.filter((x) => x.includes(title))).toHaveLength(1);
  });

  it('tickOrg: задача после доставки падает — за два тика ровно одно сообщение', async () => {
    const title = 'пересчитать склад';
    const { orgId, key } = await committedNotification(title);
    vi.mocked(runAiBudget).mockRejectedValueOnce(new Error('бюджет упал'));

    await tickOrg(orgId, MON_10);
    await tickOrg(orgId, minutes(MON_10, 1));

    expect(texts.filter((x) => x.includes(title))).toHaveLength(1);
    const deliveries = (await inOrg(orgId, (db) => db.query(
      `select d.status from deliveries d join notifications n on n.id = d.notification_id where n.dedupe_key = $1`, [key]))).rows;
    expect(deliveries).toEqual([{ status: 'sent' }]);
  });

  it('tickOrg: упавшая задача не откатывает сделанное другими задачами тика', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agent = await makeAgent(orgId, ownerId);
    const t = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'ack', assigneeUserId: person }, { kind: 'agent', agentId: agent, userId: ownerId }, MON_10));
    expect(t.status).toBe('active');
    vi.mocked(runAiBudget).mockRejectedValueOnce(new Error('бюджет упал'));

    // Напоминание «нет нажатия на Сейчас» ставят таймеры — раньше бюджета в том же тике.
    await tickOrg(orgId, minutes(MON_10, 125));
    const r = await inOrg(orgId, (db) => db.query(`select 1 from notifications where kind = 'reminder' and task_id = $1`, [t.id]));
    expect(r.rowCount).toBe(1);
  });
});
