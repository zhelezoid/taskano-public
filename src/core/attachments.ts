import type { Db } from '../db/pool.js';
import { cleanImage, storeImage, type CleanImage } from '../groups/media.js';
import { canComment } from './comments.js';
import { AppError } from './errors.js';
import { emit } from './events.js';
import { notify } from './notify.js';
import { autoStart } from './queue.js';
import type { Task } from './types.js';

// Фото и скриншоты к делу от самого человека — из лички бота и из Mini App (спека task-photos).
// Хранилище то же, что у фото рабочих групп (src/groups/media.ts): очистка, дедупликация по sha256,
// привязанное к делу не удаляется. Права — как у реплики: кому можно писать по делу, тому и прикреплять.

/** Не больше стольких фото к одному делу от одного человека за сутки (спека, «Контракт»). */
export const PHOTO_DAILY_LIMIT = 30;
/** Не больше стольких фото от одного человека за сутки по всем делам организации (ревью 07.10). */
export const PHOTO_DAILY_PERSON_LIMIT = 200;
/** Потолок хранилища фото организации: том media делит диск с базой и другими сервисами. */
export const ORG_MEDIA_BYTES_LIMIT = 5 * 1024 ** 3;

/** Окно склейки уведомлений: альбом из десяти фото — одно сообщение второй стороне, а не десять. */
const NOTIFY_WINDOW_MS = 10 * 60_000;

export const CLOSED_STATUSES = ['done', 'cancelled', 'declined', 'resolved'];

export interface AttachedImage {
  id: string;
  /** false — то же изображение уже было у дела: повтор не ошибка и не дубль. */
  added: boolean;
  task: Task;
  /** Сколько фото у дела теперь — приложение показывает число, не перечитывая карточку. */
  photos: number;
}

/**
 * Прикрепить изображение к делу (внутри withOrg). Отказы: дела нет — `not_found`; дело закрыто —
 * `validation_failed` с `{ closed: true }`; писать по делу нельзя — `forbidden`; предел — `limit_exceeded`.
 * Не картинка, чужой формат или больше 50 Мп — `UnsupportedImageError` из `cleanImage`.
 */
export async function attachImage(
  db: Db, input: {
    taskId: string; userId: string; image: Buffer | CleanImage; now: Date; fileUniqueId?: string | null;
    /** Фото — часть другого действия (бот: результат сдачи, фото к вопросу): начинать ли дело, решает само
     *  это действие, а не вложение (спека auto-start). */
    withoutStart?: boolean;
  },
): Promise<AttachedImage> {
  const { taskId, userId, now } = input;
  const task = (await db.query('select * from tasks where id = $1', [taskId])).rows[0] as Task | undefined;
  if (!task) throw new AppError('not_found', 'Task not found');
  if (CLOSED_STATUSES.includes(task.status)) {
    throw new AppError('validation_failed', 'This task is closed — no photos can be attached to it', { closed: true });
  }

  // Членство и право — как у реплики (core/comments.ts): каналов два, правило одно.
  const member = await db.query(
    `select 1 from memberships where org_id = current_setting('app.org_id')::uuid and user_id = $1 and status = 'active'`,
    [userId]);
  if (!member.rowCount || !(await canComment(db, task, userId))) {
    throw new AppError('forbidden', 'Only a person involved in this task or the owner of the organization can attach photos');
  }

  // Пределы считаются под замком человека: иначе параллельные загрузки видят один и тот же счёт и
  // проходят все разом (ревью 07.10).
  await db.query(`select pg_advisory_xact_lock(hashtext('task_photo:' || $1::text))`, [userId]);
  const used = (await db.query(
    `select count(*)::int as n from task_attachments
      where task_id = $1 and author_user_id = $2 and created_at > $3::timestamptz - interval '24 hours'`,
    [taskId, userId, now],
  )).rows[0].n as number;
  if (used >= PHOTO_DAILY_LIMIT) {
    throw new AppError('limit_exceeded', `No more than ${PHOTO_DAILY_LIMIT} photos a day on one task`, { limit: PHOTO_DAILY_LIMIT });
  }

  const perPerson = (await db.query(
    `select count(*)::int as n from task_attachments
      where author_user_id = $1 and created_at > $2::timestamptz - interval '24 hours'`,
    [userId, now])).rows[0].n as number;
  if (perPerson >= PHOTO_DAILY_PERSON_LIMIT) {
    throw new AppError('limit_exceeded', `No more than ${PHOTO_DAILY_PERSON_LIMIT} photos a day`, { limit: PHOTO_DAILY_PERSON_LIMIT });
  }
  const bytes = (await db.query('select coalesce(sum(bytes), 0)::bigint as n from media')).rows[0].n as string;
  if (Number(bytes) >= ORG_MEDIA_BYTES_LIMIT) {
    throw new AppError('limit_exceeded', 'The photo storage of this organization is full', { storage: true });
  }

  // Разбор лучше делать до транзакции (вызывающие так и делают): тогда соединение базы не ждёт очереди
  // декодера. Сырые байты — путь тестов и редких вызовов.
  const img = Buffer.isBuffer(input.image) ? await cleanImage(input.image) : input.image;
  // Фото исполнителя к неначатому делу начинает его (спека auto-start). До записи вложения: оно
  // ссылается на строку дела, а замок человека должен браться раньше замков строки — как у «Взять».
  // Повтор того же фото — тоже действие человека по делу. Фото к сдаче или к вопросу дело в работу не
  // берёт: сдача ставит начало сама и в работу перед собой не переводит, вопрос не начинает вовсе, а
  // взятие между фото и самим действием ещё и сдвигало бы версию, по которой оно идёт.
  const started = input.withoutStart ? null : await autoStart(db, taskId, { kind: 'user', userId }, 'attachment', now);
  const mediaId = await storeImage(db, task.org_id, img, { fileUniqueId: input.fileUniqueId ?? null, sourceMessageId: null, now });
  const inserted = await db.query(
    `insert into task_attachments(org_id, task_id, media_id, source, author_user_id, created_at)
     values (current_setting('app.org_id')::uuid, $1, $2, 'person', $3, $4)
     on conflict (task_id, media_id) do nothing
     returning id`,
    [taskId, mediaId, userId, now],
  );
  const added = !!inserted.rowCount;
  const id = added
    ? inserted.rows[0].id as string
    : (await db.query('select id from task_attachments where task_id = $1 and media_id = $2', [taskId, mediaId])).rows[0].id as string;

  if (added) {
    await emit(db, { type: 'attachment_added', taskId, actorUserId: userId, data: { by_user_id: userId, attachment_id: id }, at: now });
    // Вторая сторона — как у реплики: исполнитель → тому, кто примет работу (проверяющему, а без него
    // постановщику-человеку, спека task-reviewer), остальные → исполнителю. Агент-постановщик
    // уведомлений не получает: он видит событие в сводке.
    const isAssignee = userId === task.assignee_user_id;
    const target = isAssignee
      ? (task.reviewer_user_id ?? (task.author_agent_id ? null : task.author_user_id))
      : task.assignee_user_id;
    // Окно скользящее: альбом, пришедший на стыке десятиминуток, иначе дал бы два сообщения. Ключ
    // дедупликации держит параллельные фото одного альбома, которые проверку проходят одновременно.
    const recent = target && target !== userId ? await db.query(
      `select 1 from notifications
        where task_id = $1 and user_id = $2 and kind = 'task_photo' and payload->>'by_user_id' = $3::text
          and created_at > $4::timestamptz - make_interval(secs => $5)`,
      [taskId, target, userId, now, NOTIFY_WINDOW_MS / 1000]) : null;
    if (target && target !== userId && !recent?.rowCount) {
      await notify(db, {
        userId: target, kind: 'task_photo', level: 'work', taskId, payload: { by_user_id: userId }, createdAt: now,
        dedupeKey: `task_photo:${taskId}:${userId}:${Math.floor(now.getTime() / NOTIFY_WINDOW_MS)}`,
      });
    }
  }

  const photos = (await db.query('select count(*)::int as n from task_attachments where task_id = $1', [taskId])).rows[0].n as number;
  return { id, added, task: started ?? task, photos };
}
