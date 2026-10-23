import { withOrgBackground, withSystem } from '../db/pool.js';
import { logger } from '../log.js';
import { getBotApi } from '../bot/deliver.js';
import { checkGroupAdmins } from '../groups/link.js';
import { removeMediaFile } from '../groups/media.js';
import { scheduleGroupAnalyze } from '../groups/schedule.js';

// Ежедневная уборка (спека core-data-model: «хранить 14 дней»; не требуется хранить
// служебные heartbeat дольше недели). `taskano_system` обходит RLS — годится для удаления по
// возрасту без чтения содержимого организаций.

const IDEMPOTENCY_TTL_MS = 14 * 86400000;
const HEARTBEAT_TTL_MS = 7 * 86400000;
const STALE_PENDING_MS = 3600000;
// Состояния входа через Google живут 10 минут; удаляются сутки спустя (спека google-login).
const GOOGLE_STATE_KEEP_MS = 86400000;

export async function runCleanup(now: Date = new Date()): Promise<void> {
  // Рабочие группы — первыми: удаление по сроку хранения (30 дней) не должно зависеть от прочей уборки.
  await cleanupGroupData(now);
  await checkGroupAdmins(getBotApi(), now);
  await requeueStaleGroups(now);
  await withSystem((db) => db.query('delete from idempotency_keys where created_at < $1', [new Date(now.getTime() - IDEMPOTENCY_TTL_MS)]));
  // Брошенные входы OAuth: сессия входа живёт 30 минут (provider.ts), удаляются только истёкшие. Её
  // состояния Google уходят с ней каскадом; удаление по их собственному сроку — на случай, если сессия
  // когда-нибудь станет жить дольше суток.
  await withSystem(async (db) => {
    await db.query('delete from oauth_google_states where expires_at < $1', [new Date(now.getTime() - GOOGLE_STATE_KEEP_MS)]);
    await db.query('delete from oauth_pending where expires_at < $1', [now]);
  });
  // admin_audit для роли app — только insert/select (migrate.ts); удаляет служебная роль.
  await withSystem((db) => db.query(
    `delete from admin_audit where action = 'worker_heartbeat' and at < $1`, [new Date(now.getTime() - HEARTBEAT_TTL_MS)],
  ));
}

/**
 * Рабочие группы (спека group-intake, «Хранение и удаление»): непривязанные к задачам сообщения и
 * изображения старше 30 дней — строка и файл; сообщения обезличенных людей — сразу. Привязанное живёт
 * с задачей (удалили задачу — вложение ушло каскадом, изображение стало непривязанным и уйдёт здесь).
 * withSystem — только перечень организаций; удаление — под withOrg каждой (RLS).
 */
export async function cleanupGroupData(now: Date): Promise<void> {
  const orgIds = (await withSystem((db) => db.query(
    `select org_id from group_messages union select org_id from media`))).rows.map((r) => r.org_id as string);
  for (const orgId of orgIds) {
    const paths = await withOrgBackground(orgId, async (db) => {
      await db.query(
        `delete from group_messages gm using users u where u.id = gm.author_user_id and u.anonymized_at is not null`);
      const media = await db.query(
        `delete from media m where m.expires_at < $1 and not exists (select 1 from task_attachments a where a.media_id = m.id)
         returning path`, [now]);
      await db.query(
        `delete from group_messages gm where gm.expires_at < $1 and gm.task_id is null
            and not exists (select 1 from task_attachments a where a.message_id = gm.id)`, [now]);
      return media.rows.map((r) => r.path as string);
    });
    // Файлы — после коммита: откат транзакции не должен оставить строку без файла.
    for (const p of paths) {
      try { await removeMediaFile(p); } catch (e) { logger.warn({ err: e, path: p }, 'cleanup: файл изображения не удалён'); }
    }
  }
}

/** Разбор, который не случился (пауза бюджета снята, worker был недоступен), — поставить снова. */
async function requeueStaleGroups(now: Date): Promise<void> {
  const orgIds = (await withSystem((db) => db.query(
    `select distinct org_id from group_messages where analyzed_at is null and analysis_status in ('pending','failed')`))).rows
    .map((r) => r.org_id as string);
  for (const orgId of orgIds) {
    const groups = await withOrgBackground(orgId, (db) => db.query(
      `select distinct gm.group_id from group_messages gm join group_chats g on g.id = gm.group_id
        where g.status = 'active' and gm.analyzed_at is null and gm.analysis_status in ('pending','failed') and gm.created_at < $1`,
      [new Date(now.getTime() - STALE_PENDING_MS)]));
    for (const g of groups.rows) {
      try { await scheduleGroupAnalyze({ orgId, groupId: g.group_id as string }, now); } catch (e) {
        logger.warn({ err: e, orgId }, 'cleanup: не удалось поставить разбор группы');
      }
    }
  }
}
