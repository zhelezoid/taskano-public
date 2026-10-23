import type { Db } from '../db/pool.js';
import { enqueueTaskTranslation } from '../ai/translate-queue.js';
import { AppError } from './errors.js';
import { emit } from './events.js';
import { notify } from './notify.js';
import { messageLanguage } from './message-language.js';
import { isPersonalPlace } from './personal-place.js';
import { loadUserSchedule, localDate, localDatePlusDays } from './calendar.js';
import type { Actor, Task } from './types.js';
import { actorAgentId, actorUserId } from './types.js';

// Срок называет исполнитель (спека self-set-due). Срок, названный самим человеком, —
// его обязательство; спущенный сверху — чужое. Поэтому поставить срок может и тот, кто дело делает,
// а владелец может попросить его об этом — и просьба, и ответ остаются в деле.
//
// Перенос (`postpone` в lifecycle.ts) — другое действие: он уводит дело в «Отложено». Срок статус не
// трогает никогда.

export type DueSource = 'app' | 'bot' | 'mcp' | 'group';

/** Откуда пришёл срок из рабочего чата — событие несёт это целиком. */
export interface DueFromGroup { group_id: string; message_id: string; sent_at: string }

export interface SetDueInput {
  taskId: string;
  /** 'YYYY-MM-DD' в поясе исполнителя. */
  date: string;
  actor: Actor;
  source?: DueSource;
  /** Версия карточки: передали — правка по устаревшей карточке отбивается, как у остальных действий. */
  version?: number;
  group?: DueFromGroup;
  now?: Date;
  /**
   * Момент, когда срок назван: просьбы, созданные позже, этим ответом не гасятся. По умолчанию — `now`;
   * у срока из чата — время сообщения, а не разбора: просьба, заданная после сообщения, им не отвечена.
   */
  namedAt?: Date;
}

/** Дальше этого срок не ставится: двухлетний срок — не срок, а «когда-нибудь». */
const MAX_DUE_DAYS = 2 * 366;

/** Дела, которым срок уже не нужен. Ожиданию тоже: у него дата проверки, а не срок. */
const CLOSED = ['done', 'cancelled', 'declined', 'resolved'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

async function isManager(db: Db, userId: string): Promise<boolean> {
  const m = await db.query(
    `select role from memberships where org_id = current_setting('app.org_id')::uuid and user_id = $1 and status = 'active'`,
    [userId]);
  return ['owner', 'admin'].includes(m.rows[0]?.role);
}

/**
 * Может ли действующее лицо поставить срок делу: исполнитель, автор (человек или агент, который его
 * ведёт) и owner/admin. Агент — только своему делу: помеченное «рабочее» личное он лишь читает.
 */
export async function mayManageDue(db: Db, t: Task, actor: Actor): Promise<boolean> {
  const agentId = actorAgentId(actor);
  if (agentId) return t.author_agent_id === agentId && !t.shared_org_id;
  const userId = actorUserId(actor);
  if (!userId) return false;
  if (userId === t.assignee_user_id || userId === t.author_user_id) return true;
  return isManager(db, userId);
}

/** Почему делу нельзя поставить срок; null — можно. */
function dueBlocker(t: Task): string | null {
  if (CLOSED.includes(t.status)) return 'The task is closed — a due date means nothing for it';
  if (t.kind === 'waiting' || t.status === 'waiting_external') return 'A waiting has a date to check, not a due date';
  return null;
}

/** Показывать ли смотрящему календарь срока: дело ещё ждёт срока, и ставить его он вправе. */
export async function maySetDue(db: Db, t: Task, actor: Actor): Promise<boolean> {
  return !dueBlocker(t) && mayManageDue(db, t, actor);
}

/**
 * Погасить открытые просьбы назвать срок: срок назвал исполнитель. Ответом считается любая установка
 * срока им самим — календарём, в боте, из чата. Гасятся только просьбы не младше
 * момента, когда срок назван (`namedAt`): ответ не может опередить вопрос.
 */
export async function answerDueRequests(db: Db, taskId: string, now: Date = new Date(), namedAt: Date = now): Promise<number> {
  const r = await db.query(
    `update task_messages set answered_at = $2
      where task_id = $1 and kind = 'due_request' and answered_at is null and created_at <= $3`,
    [taskId, now, namedAt]);
  return r.rowCount ?? 0;
}

/**
 * Поставить срок делу. Статус не трогается (срок — не перенос), `activate_at` отложенного дела тоже.
 * Тот же срок — ничего не происходит: ни события, ни уведомления, — но просьбу назвать срок такой
 * ответ исполнителя всё равно гасит: он назвал дату, пусть и ту же.
 */
export async function setDueDate(db: Db, input: SetDueInput): Promise<Task> {
  return (await applyDueDate(db, input)).task;
}

/** То же, что `setDueDate`, и признак, изменился ли срок (разбору группы нужно знать, о чём сказать). */
export async function applyDueDate(db: Db, input: SetDueInput): Promise<{ task: Task; changed: boolean }> {
  const now = input.now ?? new Date();
  const namedAt = input.namedAt ?? now;
  const t = (await db.query('select * from tasks where id = $1 for update', [input.taskId])).rows[0] as Task | undefined;
  // Чужое дело — «не найдено», как у остальных ручек: отказ «нет прав» подтверждал бы, что оно есть.
  if (!t || !(await mayManageDue(db, t, input.actor))) throw new AppError('not_found', 'Task not found');
  if (input.version !== undefined && input.version !== t.version) {
    throw new AppError('stale_version', 'The card is out of date', { version: t.version });
  }
  const blocker = dueBlocker(t);
  if (blocker) throw new AppError('validation_failed', blocker, { status: t.status });

  if (!isCalendarDate(input.date)) throw new AppError('validation_failed', 'date — format YYYY-MM-DD');
  const schedule = await loadUserSchedule(db, t.assignee_user_id);
  const today = localDate(now, schedule.tz);
  if (input.date < today) throw new AppError('validation_failed', 'The date is in the past — pick today or later', { today });
  if (input.date > localDatePlusDays(schedule, now, MAX_DUE_DAYS)) {
    throw new AppError('validation_failed', 'The date is more than two years away');
  }

  const byUser = actorUserId(input.actor);
  const byAgent = actorAgentId(input.actor);
  const byAssignee = !byAgent && byUser === t.assignee_user_id;
  if (t.due_date === input.date) {
    if (byAssignee) await answerDueRequests(db, t.id, now, namedAt);
    return { task: t, changed: false };
  }

  const updated = (await db.query(
    `update tasks set due_date = $2, due_tz = $3, due_assumed = false, reminded_count = 0, updated_at = $4, version = version + 1
      where id = $1 returning *`,
    [t.id, input.date, schedule.tz, now],
  )).rows[0] as Task;

  await emit(db, {
    type: 'due_set', taskId: t.id, actorUserId: byAgent ? null : byUser, actorAgentId: byAgent,
    data: {
      from: t.due_date, to: input.date, ...(byAgent ? { by_agent_id: byAgent } : { by_user_id: byUser }),
      source: input.source ?? 'mcp', ...(input.group ? { group: input.group } : {}),
    },
    at: now,
  });

  if (byAssignee) {
    await answerDueRequests(db, t.id, now, namedAt);
    // Автор-человек — он же хозяин агента у дела, которое ведёт агент (`author_user_id`): тому, кто
    // просил или поставил, важно знать, какой срок человек назвал сам.
    if (t.author_user_id !== t.assignee_user_id) await notifyDueSet(db, t, input.date, now);
  } else if (byUser !== t.assignee_user_id && !['draft', 'scheduled'].includes(t.status)) {
    // Как при правке срока автором (`updateTask`): исполнитель приходит к сроку, которого не ставил,
    // только если ему об этом не сказали.
    await notify(db, { userId: t.assignee_user_id, kind: 'task_updated', level: 'work', taskId: t.id, dedupeKey: `upd:${t.id}:${updated.version}` });
  }
  return { task: updated, changed: true };
}

/**
 * «{имя}: срок — {дата}» автору — одно сообщение в день на дело. Человек, который перебирает даты в
 * календаре, иначе засыпал бы автора сообщениями; пока сообщение не ушло, в нём последний срок.
 */
async function notifyDueSet(db: Db, t: Task, to: string, now: Date): Promise<void> {
  const { tz } = await loadUserSchedule(db, t.author_user_id);
  const key = `due_set:${t.id}:${localDate(now, tz)}`;
  const payload = { from: t.due_date, to };
  await notify(db, { userId: t.author_user_id, kind: 'due_set', level: 'work', taskId: t.id, payload, dedupeKey: key });
  await db.query(
    `update notifications set payload = jsonb_set(payload, '{to}', to_jsonb($2::text))
      where org_id = current_setting('app.org_id')::uuid and dedupe_key = $1 and delivered_at is null`,
    [key, to]);
}

export interface DueRequest {
  id: string;
  task_id: string;
  requested_at: Date;
  answered_at: Date | null;
  author_user_id: string | null;
  author_agent_id: string | null;
}

/** Последняя просьба назвать срок по делу — открытая или уже отвеченная. */
export async function lastDueRequest(db: Db, taskId: string): Promise<DueRequest | null> {
  const r = await db.query(
    `select id, task_id, created_at as requested_at, answered_at, author_user_id, author_agent_id from task_messages
      where task_id = $1 and kind = 'due_request' order by created_at desc, id desc limit 1`, [taskId]);
  return (r.rows[0] as DueRequest) ?? null;
}

/** Открытая просьба и кто просил — именем человека или агента (карточка приложения и уведомления). */
export async function openDueRequest(
  db: Db, taskId: string,
): Promise<(DueRequest & { by_name: string; text: string; source_language: string | null }) | null> {
  const r = await db.query(
    `select m.id, m.task_id, m.created_at as requested_at, m.answered_at, m.author_user_id, m.author_agent_id,
            coalesce(a.name, u.display_name, '') as by_name, m.text, m.source_language
       from task_messages m
       left join users u on u.id = m.author_user_id
       left join agents a on a.id = m.author_agent_id
      where m.task_id = $1 and m.kind = 'due_request' and m.answered_at is null
      order by m.created_at desc, m.id desc limit 1`, [taskId]);
  return (r.rows[0] as DueRequest & { by_name: string; text: string; source_language: string | null }) ?? null;
}

/** Можно ли просить срок: дело открыто, у него есть исполнитель, отличный от просящего, и это не личное. */
export async function mayRequestDue(db: Db, t: Task, actor: Actor): Promise<boolean> {
  if (dueBlocker(t)) return false;
  const agentId = actorAgentId(actor);
  const userId = actorUserId(actor);
  if (agentId) {
    if (t.author_agent_id !== agentId || t.shared_org_id) return false;
  } else {
    if (!userId || userId === t.assignee_user_id) return false;
    if (userId !== t.author_user_id && !(await isManager(db, userId))) return false;
  }
  return !(await isPersonalPlace(db, {
    projectId: t.project_id, assigneeUserId: t.assignee_user_id, authorUserId: t.author_user_id, authorAgentId: t.author_agent_id,
  }));
}

export interface RequestDueInput {
  taskId: string;
  actor: Actor;
  /** Зачем нужен срок — исполнитель прочтёт это вместе с просьбой. */
  text?: string | null;
  now?: Date;
}

/**
 * Попросить исполнителя назвать срок. Просить может автор (человек или агент, который
 * ведёт дело) и owner/admin. Открытая просьба уже есть — возвращается она же: вторая напомнила бы
 * человеку о том же дважды и сбила бы отсчёт эскалации.
 */
export async function requestDue(db: Db, input: RequestDueInput): Promise<DueRequest & { created: boolean }> {
  const now = input.now ?? new Date();
  const t = (await db.query('select * from tasks where id = $1 for update', [input.taskId])).rows[0] as Task | undefined;
  if (!t || !(await mayManageDue(db, t, input.actor))) throw new AppError('not_found', 'Task not found');
  const blocker = dueBlocker(t);
  if (blocker) throw new AppError('validation_failed', blocker, { status: t.status });
  const userId = actorUserId(input.actor);
  const agentId = actorAgentId(input.actor);
  if (!agentId && userId === t.assignee_user_id) {
    throw new AppError('validation_failed', 'This is your own task — set its due date yourself');
  }
  if (!(await mayRequestDue(db, t, input.actor))) {
    // Сюда доходят двое: личное дело (просить некого) и тот, кто дело видит, но не распоряжается им.
    const personal = await isPersonalPlace(db, {
      projectId: t.project_id, assigneeUserId: t.assignee_user_id, authorUserId: t.author_user_id, authorAgentId: t.author_agent_id,
    });
    if (personal) throw new AppError('validation_failed', 'A personal item has nobody to ask — it is yours');
    throw new AppError('forbidden', 'Only the author of the task, or the owner or an admin, asks for a due date');
  }

  const open = await openDueRequest(db, t.id);
  if (open) {
    const { by_name: _n, text: _t, source_language: _l, ...req } = open;
    return { ...req, created: false };
  }

  const text = (input.text ?? '').trim().slice(0, 2000);
  const byUser = agentId ? null : userId;
  const r = await db.query(
    `insert into task_messages(org_id, task_id, author_user_id, author_agent_id, kind, text, source_language, created_at)
     values (current_setting('app.org_id')::uuid, $1, $2, $3, 'due_request', $4, $5, $6)
     returning id, task_id, created_at as requested_at, answered_at, author_user_id, author_agent_id`,
    [t.id, byUser, agentId, text, text ? await messageLanguage(db, text, byUser) : null, now],
  );
  const req = r.rows[0] as DueRequest;
  // Слова просившего (зачем нужен срок) тоже переводятся фоном; пустая просьба переводить нечего.
  if (text) await enqueueTaskTranslation(db, t.id);
  await emit(db, {
    type: 'due_requested', taskId: t.id, actorUserId: byUser, actorAgentId: agentId,
    data: { request_id: req.id, ...(text ? { text } : {}) }, at: now,
  });
  await notify(db, {
    userId: t.assignee_user_id, kind: 'due_request', level: 'work', taskId: t.id,
    payload: { request_id: req.id }, dedupeKey: `due_request:${req.id}`, createdAt: now,
  });
  return { ...req, created: true };
}
