import type { Db } from '../db/pool.js';
import { enqueueTaskTranslation } from '../ai/translate-queue.js';
import { AppError } from './errors.js';
import { emit } from './events.js';
import { messageLanguage } from './message-language.js';
import { notify } from './notify.js';
import { autoStart } from './queue.js';
import type { Task } from './types.js';

// Реплика человека к делу (спека task-comments): свободный комментарий, который не блокирует
// задачу и не двигает её статус. Агент разбирает такие реплики в ежечасной сводке.

/** Не больше стольких реплик к одной задаче в сутки от одного человека (спека, «Контракт»). */
export const COMMENT_DAILY_LIMIT = 20;

/**
 * Предел длины реплики. Реплика уходит агенту дважды — блоком `comments` и событием, — поэтому
 * вставленная в поле Mini App простыня на сто тысяч знаков раздувает сводку и стоит денег.
 */
export const COMMENT_MAX_LENGTH = 2000;

export interface AddedComment {
  task: Task;
  /** Реплика владельца к задаче агента — указание (`owner_instruction`), а не разговор. */
  kind: 'comment' | 'owner_instruction';
}

/**
 * Добавить реплику человека к задаче (бот и Mini App). Писать могут исполнитель, постановщик-человек
 * и владелец организации — остальным `forbidden`. Статус задачи реплика не меняет — кроме первой
 * реплики исполнителя к неначатому делу: она начинает его (`autoStart`, спека auto-start).
 */
// Время реплики — часы базы (`now()`), как у событий: «отвечена ли реплика» сравнивает их между собой,
// и одни часы на обе записи исключают расхождение приложения с базой.
/**
 * Кто может дописать к делу: исполнитель, постановщик-человек, тот, кого назначили проверить
 * ожидание, проверяющий результата (спека task-reviewer) и владелец организации — то есть все, кому
 * бот и так показывает карточку. Отдельная функция, чтобы кнопка в боте не звала писать того, кому
 * потом откажут.
 */
export async function canComment(db: Db, task: Task, userId: string): Promise<boolean> {
  if (userId === task.assignee_user_id) return true;
  if (!task.author_agent_id && userId === task.author_user_id) return true;
  if (task.waiting?.check_user_id === userId) return true;
  if (task.reviewer_user_id === userId) return true;
  const owner = (await db.query(`select owner_user_id from orgs where id = current_setting('app.org_id')::uuid`)).rows[0]?.owner_user_id as string | undefined;
  return !!owner && userId === owner;
}

export async function addHumanComment(
  db: Db, taskId: string, userId: string, text: string, at?: Date,
): Promise<AddedComment> {
  const body = text.trim();
  if (!body) throw new AppError('validation_failed', 'A comment needs text');
  if (body.length > COMMENT_MAX_LENGTH) {
    throw new AppError('validation_failed', `A comment is longer than ${COMMENT_MAX_LENGTH} characters — say the gist, the details go into the task`, { length: body.length });
  }

  const task = (await db.query('select * from tasks where id = $1', [taskId])).rows[0] as Task | undefined;
  if (!task) throw new AppError('not_found', 'Task not found');

  // Закрытому делу писать некому: агент его уже не ведёт, исполнителю оно не показывается. Приложение
  // поле реплики у таких дел и не рисует (спека completed-list) — правило держим в ядре, иначе запрет
  // существует только в интерфейсе, а через API запись всё равно уходит в ленту закрытого дела.
  const CLOSED = ['done', 'cancelled', 'declined', 'resolved'];
  if (CLOSED.includes(task.status)) {
    throw new AppError('validation_failed', 'This task is closed — reopen it first if there is something to add');
  }

  // Членство проверяем здесь, а не в поиске задачи: каналов два (бот и Mini App), правило должно
  // быть одно. Приглашённый ещё не действует в организации и в её дела не пишет.
  const member = await db.query(
    `select 1 from memberships where org_id = current_setting('app.org_id')::uuid and user_id = $1 and status = 'active'`,
    [userId]);
  if (!member.rowCount) throw new AppError('forbidden', 'Only an active member of the organization can write here');

  const owner = (await db.query(`select owner_user_id from orgs where id = current_setting('app.org_id')::uuid`)).rows[0]?.owner_user_id as string | undefined;
  const isOwner = !!owner && userId === owner;
  const isAssignee = userId === task.assignee_user_id;
  if (!(await canComment(db, task, userId))) {
    throw new AppError('forbidden', 'Only a person involved in this task or the owner of the organization can write here');
  }

  const used = (await db.query(
    `select count(*)::int as n from task_messages
      where task_id = $1 and author_user_id = $2 and kind in ('comment','owner_instruction')
        and created_at > now() - interval '24 hours'`,
    [taskId, userId],
  )).rows[0].n as number;
  if (used >= COMMENT_DAILY_LIMIT) {
    throw new AppError('limit_exceeded', `No more than ${COMMENT_DAILY_LIMIT} comments a day on one task`, { limit: COMMENT_DAILY_LIMIT });
  }

  // Реплика исполнителя к неначатому делу начинает его (спека auto-start). До записи реплики: та
  // ссылается на строку дела, а замок человека должен браться раньше замков строки — как у «Взять».
  const started = await autoStart(db, taskId, { kind: 'user', userId }, 'comment', at ?? new Date());

  // Владелец пишет задаче своего агента — это указание, а не реплика (спека, «Агент видит»).
  const kind = isOwner && task.author_agent_id ? 'owner_instruction' : 'comment';
  // Время реплики — то, которое назвал вызывающий (в бою это «сейчас»): окна сводок считаются по
  // нему же, и реплика, записанная временем базы, из окна выпадает.
  await db.query(
    `insert into task_messages(org_id, task_id, author_user_id, kind, text, source_language, created_at)
     values (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, coalesce($6, now()))`,
    [taskId, userId, kind, body, await messageLanguage(db, body, userId), at ?? null],
  );
  // Реплику читают на других языках — перевод готовится фоном, пока её не открыли (спека translation-prefetch).
  await enqueueTaskTranslation(db, taskId);
  await emit(db, { type: 'comment', taskId, actorUserId: userId, data: { text: body, kind }, at });

  // Вторая сторона-человек узнаёт уведомлением; у агента уведомлений нет — он читает сводку.
  if (task.reviewer_user_id) {
    // С проверяющим разговор о работе идёт между тем, кто делает, и тем, кто принимает (спека
    // task-reviewer). Постановщику — только итог: переписку он видит, открыв дело, а не звонком
    // на каждую реплику двух других.
    for (const target of new Set([task.assignee_user_id, task.reviewer_user_id])) {
      if (target !== userId) await notify(db, { userId: target, kind: 'task_comment', level: 'work', taskId: task.id });
    }
  } else if (!task.author_agent_id) {
    const target = isAssignee ? task.author_user_id : task.assignee_user_id;
    if (target && target !== userId) await notify(db, { userId: target, kind: 'task_comment', level: 'work', taskId: task.id });
  } else if (kind === 'owner_instruction' && task.assignee_user_id && task.assignee_user_id !== userId) {
    // Указание владельца в деле агента читает агент, но и исполнитель должен узнать сразу: иначе
    // владелец пишет человеку, а тот видит это, только когда сам откроет приложение (30.09).
    await notify(db, { userId: task.assignee_user_id, kind: 'task_comment', level: 'work', taskId: task.id });
  }
  return { task: started ?? task, kind };
}
