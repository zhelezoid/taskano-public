import type { Message } from 'grammy/types';
import { withGlobal, withOrg } from '../db/pool.js';
import { logger } from '../log.js';
import { MAX_TELEGRAM_FILE_BYTES, MEDIA_TTL_MS } from './media.js';
import { GROUP_ANALYZE_DELAY_MS, scheduleGroupAnalyze } from './schedule.js';

// Приём сообщений из рабочих групп (спека group-intake, «Приём сообщений»). Webhook только
// записывает: ни скачивания файлов, ни вызова модели — это фоновый разбор (analyze.ts).
// Сообщение человека, не являющегося активным участником организации группы, не сохраняется вовсе.

export interface GroupTarget { orgId: string; groupId: string }

/** Организация и группа по chat_id — только если группа привязана и приём не на паузе. */
export async function activeGroup(chatId: number): Promise<GroupTarget | null> {
  const link = await withGlobal((db) => db.query('select org_id from group_links where telegram_chat_id = $1', [chatId]));
  const orgId = link.rows[0]?.org_id as string | undefined;
  if (!orgId) return null;
  const g = await withOrg(orgId, (db) => db.query(`select id, status from group_chats where telegram_chat_id = $1`, [chatId]));
  if (!g.rowCount || g.rows[0].status !== 'active') return null;
  return { orgId, groupId: g.rows[0].id as string };
}

/** Taskano-человек за Telegram-аккаунтом — только если он активный участник этой организации. */
async function orgMemberByTelegram(orgId: string, telegramUserId: number): Promise<string | null> {
  const r = await withGlobal((db) => db.query(
    `select tl.user_id from telegram_links tl
       join memberships m on m.user_id = tl.user_id and m.org_id = $2 and m.status = 'active'
       join users u on u.id = tl.user_id and u.anonymized_at is null
      where tl.telegram_user_id = $1`,
    [telegramUserId, orgId],
  ));
  return (r.rows[0]?.user_id as string | undefined) ?? null;
}

/** Самый большой PhotoSize или документ-изображение до 20 МБ; остальное — без изображения. */
export function imageOf(msg: Message): { fileId: string; fileUniqueId: string } | null {
  if (msg.photo?.length) {
    const largest = [...msg.photo].sort((a, b) => a.width * a.height - b.width * b.height).at(-1)!;
    return { fileId: largest.file_id, fileUniqueId: largest.file_unique_id };
  }
  const doc = msg.document;
  if (doc && doc.mime_type?.startsWith('image/') && (doc.file_size ?? 0) <= MAX_TELEGRAM_FILE_BYTES) {
    return { fileId: doc.file_id, fileUniqueId: doc.file_unique_id };
  }
  return null;
}

/**
 * `message` / `edited_message` из группы. Возвращает true, если сообщение сохранено (для тестов).
 * Правка: обновляет текст; если сообщение ещё не привязано к задаче — снова в разбор.
 */
export async function ingestGroupMessage(msg: Message, opts: { edited: boolean; now?: Date }): Promise<boolean> {
  const from = msg.from;
  if (!from || from.is_bot) return false;
  const target = await activeGroup(msg.chat.id);
  if (!target) return false;
  const authorUserId = await orgMemberByTelegram(target.orgId, from.id);
  if (!authorUserId) return false;

  const text = msg.text ?? msg.caption ?? '';
  const image = imageOf(msg);
  if (!text.trim() && !image) return false;   // служебные сообщения, стикеры, голосовые — не этап 1

  const now = opts.now ?? new Date();
  const sentAt = new Date(msg.date * 1000);
  const saved = await withOrg(target.orgId, async (db) => {
    if (opts.edited) {
      const upd = await db.query(
        `update group_messages
            set text = $3, edited_at = $4,
                analysis_status = case when task_id is null then 'pending' else analysis_status end,
                analyzed_at = case when task_id is null then null else analyzed_at end
          where group_id = $1 and telegram_message_id = $2 and author_user_id = $5
          returning id`,
        [target.groupId, msg.message_id, text, now, authorUserId],
      );
      if (upd.rowCount) return true;
    }
    const r = await db.query(
      `insert into group_messages(org_id, group_id, telegram_message_id, author_user_id, text, reply_to, thread_id,
                                  media_group_id, photo_file_id, photo_file_unique_id, sent_at, edited_at, expires_at)
       values (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (org_id, group_id, telegram_message_id) do nothing`,
      [target.groupId, msg.message_id, authorUserId, text, msg.reply_to_message?.message_id ?? null,
        msg.message_thread_id ?? null, msg.media_group_id ?? null, image?.fileId ?? null, image?.fileUniqueId ?? null,
        sentAt, opts.edited ? now : null, new Date(now.getTime() + MEDIA_TTL_MS)],
    );
    return !!r.rowCount;
  });
  if (!saved) return false;

  try {
    await scheduleGroupAnalyze({ orgId: target.orgId, groupId: target.groupId }, new Date(now.getTime() + GROUP_ANALYZE_DELAY_MS));
  } catch (e) {
    // Сообщение уже сохранено: разбор подхватит следующее сообщение или ежедневная проверка.
    logger.error({ err: e, groupId: target.groupId }, 'group intake: не удалось поставить разбор');
  }
  return true;
}
