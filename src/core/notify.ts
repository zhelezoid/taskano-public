import type { Db } from '../db/pool.js';

// Ядро только записывает, что доставить. Доставка (тихие часы, склейка, лимиты Telegram) — worker.
export type NotificationLevel = 'work' | 'feed' | 'glance' | 'decision';

export interface NotificationInput {
  userId: string;
  kind: string;
  level: NotificationLevel;
  taskId?: string | null;
  payload?: Record<string, unknown>;
  dedupeKey?: string | null;
  deliverAfter?: Date | null;
  /** Время события, а не записи — там, где по нему потом считают окна (защита от дублей task_now). */
  createdAt?: Date | null;
}

export async function notify(db: Db, n: NotificationInput): Promise<void> {
  // Лента не доставляется сообщением (спека telegram-bot): её читают через /feed и дайджест.
  const delivered = n.level === 'feed' ? new Date() : null;
  await db.query(
    `insert into notifications(org_id, user_id, kind, level, task_id, payload, dedupe_key, deliver_after, delivered_at, created_at)
     values (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6, coalesce($7, now()), $8, coalesce($9, now()))
     on conflict (org_id, dedupe_key) where dedupe_key is not null do nothing`,
    [n.userId, n.kind, n.level, n.taskId ?? null, n.payload ?? {}, n.dedupeKey ?? null, n.deliverAfter ?? null, delivered, n.createdAt ?? null],
  );
}
