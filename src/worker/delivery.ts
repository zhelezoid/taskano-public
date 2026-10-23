import type { Db } from '../db/pool.js';
import { deliverNotification } from '../bot/deliver.js';
import { isQuietTime, quietEndAfter } from '../core/calendar.js';
import { logger } from '../log.js';

// Доставка уведомлений: тихие часы откладывают, неудача — не чаще раза в 5 минут (спека telegram-bot,
// «Напоминания»; core-data-model, `notifications`/`deliveries`). Итог отправки — отметку
// «доставлено» или перенос повтора — пишет сама `deliverNotification` в своей транзакции, вместе с
// `deliveries`: здесь его не трогаем, иначе откат этой транзакции снимал бы отметку с уже ушедшего
// сообщения и следующий проход слал бы его снова.

interface DueNotification { id: string; org_id: string; user_id: string }

export async function runDelivery(db: Db, orgId: string, now: Date): Promise<void> {
  const due = (await db.query(
    `select id, org_id, user_id from notifications
      where org_id = $1 and delivered_at is null and deliver_after <= $2 and level <> 'feed'
      order by created_at`,
    [orgId, now],
  )).rows as DueNotification[];

  for (const n of due) {
    const u = (await db.query('select timezone, quiet_start, quiet_end from users where id = $1', [n.user_id])).rows[0];
    if (!u) continue;
    const quietStart = String(u.quiet_start).slice(0, 5);
    const quietEnd = String(u.quiet_end).slice(0, 5);
    if (isQuietTime(u.timezone, quietStart, quietEnd, now)) {
      await db.query('update notifications set deliver_after = $2 where id = $1', [n.id, quietEndAfter(u.timezone, quietEnd, now)]);
      continue;
    }
    // Одно сломанное уведомление не держит очередь остальных: иначе оно падало бы каждый тик
    // первым и всё, что за ним, не уходило бы никогда.
    await deliverNotification(n.org_id, n.id, now)
      .catch((e) => logger.error({ err: e, orgId, notificationId: n.id }, 'доставка: уведомление упало'));
  }
}
