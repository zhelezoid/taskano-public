import type { Db } from '../db/pool.js';
import { AppError } from '../core/errors.js';
import { emit } from '../core/events.js';
import { notify } from '../core/notify.js';
import { loadUserSchedule, workingMinutesBetween, type Schedule } from '../core/calendar.js';
import { OPEN_STATUSES, type Actor } from '../core/types.js';
import { actorAgentId, actorUserId } from '../core/types.js';
import { taskForAgent, untrusted } from '../mcp/context.js';
import { CONFIDENCE_THRESHOLD, MAYBE_DONE_STATUSES, maybeDoneNextAt } from './analyze.js';
import { dialogOrigin, parseDialogOrigin } from './dialog-tasks.js';

// Ежечасная ревизия групп routine-исполнителем (спека group-intake): быстрая модель
// разбирает группу сразу, сильная раз в час проверяет её работу по блоку `groups` в get_briefing
// и поправляет инструментами move_attachment / ask_done / cancel_task / propose_change(close_task).
// Весь текст людей (пересказы, цитаты, названия задач из переписки) — под пометкой untrusted.

const ATTACHED_LIMIT = 50;
const CREATED_LIMIT = 50;
const UNMATCHED_LIMIT = 30;
const CLOSE_LIMIT = 30;
const QUOTE_MAX = 300;
const STALE_WORKING_DAYS = 3;
// Разбор пишет время начала пачки, а коммитит после вызова модели (секунды). Подтверждаем окно с
// запасом: повтор строки в следующей сводке безвреден, потеря — нет.
export const REVIEW_OVERLAP_MS = 5 * 60000;

const WORK_STATUSES = ['ready', 'active', 'in_progress', 'blocked', 'rework', 'waiting_external'];

type Untrusted = ReturnType<typeof untrusted>;

export interface GroupsBlock {
  since: string | null;
  attached: {
    task_id: string; short_id: string; title: Untrusted; kind: string | null; summary: Untrusted; confidence: number | null;
    quote: Untrusted; attachment_id: string | null; message_id: string; group_id: string; message_at: string;
  }[];
  created: {
    task_id: string; short_id: string; title: Untrusted; why: Untrusted; done_criteria: Untrusted; rationale: Untrusted;
    status: string; assignee_user_id: string; author_agent_id: string | null; due_date: string | null; due_assumed: boolean;
    group_id: string | null; created_at: string;
  }[];
  unmatched: {
    /** origin для create_task, если в сообщении поручение без задачи. */
    message_id: string; group_id: string; origin: string; author_user_id: string; kind: string | null; summary: Untrusted;
    image: { description: Untrusted; text_on_image: Untrusted } | null; message_at: string;
  }[];
  close_candidates: {
    task_id: string; short_id: string; title: Untrusted; status: string; assignee_user_id: string;
    author_agent_id: string | null; set_by: 'agent' | 'human'; reasons: ('done_claim' | 'obsolete' | 'stale')[];
    said: Untrusted; idle_working_minutes: number | null;
  }[];
}

const iso = (d: Date | string) => new Date(d).toISOString();
const quote = (text: string | null | undefined) => untrusted(text ? text.slice(0, QUOTE_MAX) : null);

function workdayMinutes(s: Schedule): number {
  const [sh, sm] = s.start.split(':').map(Number) as [number, number];
  const [eh, em] = s.end.split(':').map(Number) as [number, number];
  return Math.max(60, eh * 60 + em - (sh * 60 + sm));
}

async function loadCloseCandidates(db: Db, now: Date): Promise<GroupsBlock['close_candidates']> {
  const byTask = new Map<string, { reasons: Set<'done_claim' | 'obsolete' | 'stale'>; said: string | null; idle: number | null }>();
  const entry = (id: string) => {
    let e = byTask.get(id);
    if (!e) { e = { reasons: new Set(), said: null, idle: null }; byTask.set(id, e); }
    return e;
  };

  // «Сделано» в группе без подтверждения исполнителя и «не нужно/отменили» — по уверенным суждениям разбора.
  const said = await db.query(
    `select distinct on (t.id, m.kind) t.id, m.kind, m.summary
       from group_messages m join tasks t on t.id = m.task_id
      where m.kind in ('done_claim','obsolete') and m.confidence >= $1 and t.status = any($2)
        and (m.kind = 'obsolete' or (t.status = any($3) and m.sent_at > coalesce(t.submitted_at, '-infinity'::timestamptz)))
      order by t.id, m.kind, m.sent_at desc`,
    [CONFIDENCE_THRESHOLD, OPEN_STATUSES, WORK_STATUSES]);
  for (const r of said.rows) {
    const e = entry(r.id);
    e.reasons.add(r.kind);
    e.said ??= r.summary;
  }

  // Без событий дольше max(3 рабочих дня, 2 × оценка) — среди задач, связанных с группами.
  const idle = await db.query(
    `select t.id, t.assignee_user_id, t.estimate_minutes,
            greatest(t.created_at, t.status_changed_at, coalesce((select max(e.at) from events e where e.task_id = t.id), t.created_at)) as last_at
       from tasks t
      where t.kind = 'action' and t.status = any($1)
        and (t.origin like 'group:%' or exists (select 1 from group_messages m where m.task_id = t.id))
      order by last_at limit 200`,
    [WORK_STATUSES]);
  const schedules = new Map<string, Schedule>();
  for (const r of idle.rows) {
    let s = schedules.get(r.assignee_user_id);
    if (!s) { s = await loadUserSchedule(db, r.assignee_user_id); schedules.set(r.assignee_user_id, s); }
    const minutes = workingMinutesBetween(s, new Date(r.last_at), now);
    const limit = Math.max(STALE_WORKING_DAYS * workdayMinutes(s), 2 * (r.estimate_minutes ?? 0));
    if (minutes <= limit) continue;
    const e = entry(r.id);
    e.reasons.add('stale');
    e.idle = minutes;
  }
  if (!byTask.size) return [];

  const tasks = await db.query(
    `select id, short_id::text, title, status, assignee_user_id, author_agent_id from tasks where id = any($1::uuid[])`, [[...byTask.keys()]]);
  const rank = (id: string) => (byTask.get(id)!.reasons.has('stale') && byTask.get(id)!.reasons.size === 1 ? 1 : 0);
  return tasks.rows
    .sort((a, b) => rank(a.id) - rank(b.id) || (byTask.get(b.id)!.idle ?? 0) - (byTask.get(a.id)!.idle ?? 0))
    .slice(0, CLOSE_LIMIT)
    .map((t) => {
      const e = byTask.get(t.id)!;
      return {
        task_id: t.id, short_id: t.short_id, title: untrusted(t.title), status: t.status, assignee_user_id: t.assignee_user_id,
        author_agent_id: t.author_agent_id, set_by: t.author_agent_id ? 'agent' as const : 'human' as const,
        reasons: [...e.reasons], said: untrusted(e.said), idle_working_minutes: e.idle,
      };
    });
}

/**
 * Блок `groups` для get_briefing: что появилось с прошлого ack_briefing (attached, created, unmatched)
 * и что пора проверить на закрытие (close_candidates — текущее состояние). null — у организации нет групп.
 * Запоминает границу окна; ack_briefing с тем же курсором её подтверждает.
 */
export async function groupsBriefing(db: Db, now: Date, cursor: string): Promise<GroupsBlock | null> {
  const any = await db.query('select 1 from group_chats limit 1');
  if (!any.rowCount) return null;
  const state = (await db.query('select acked_until from group_review_state')).rows[0];
  const since: Date | null = state?.acked_until ?? null;
  const window = [since, now];

  const attached = await db.query(
    `select m.id as message_id, m.group_id, m.kind, m.text, m.sent_at, t.id as task_id, t.short_id::text, t.title,
            a.id as attachment_id, coalesce(a.confidence, m.confidence) as confidence, coalesce(nullif(a.summary, ''), m.summary) as summary
       from group_messages m
       left join task_attachments a on a.message_id = m.id
       join tasks t on t.id = coalesce(a.task_id, m.task_id)
      where m.analyzed_at > coalesce($1::timestamptz, '-infinity'::timestamptz) and m.analyzed_at <= $2
        and t.origin is distinct from ('group:' || m.group_id || ':' || m.telegram_message_id)
      order by m.sent_at desc limit ${ATTACHED_LIMIT}`, window);

  const created = await db.query(
    `select id, short_id::text, title, why, done_criteria, rationale, status, assignee_user_id, author_agent_id,
            to_char(due_date, 'YYYY-MM-DD') as due_date, due_assumed, origin, created_at
       from tasks
      where origin like 'group:%' and created_at > coalesce($1::timestamptz, '-infinity'::timestamptz) and created_at <= $2
      order by created_at desc limit ${CREATED_LIMIT}`, window);

  const unmatched = await db.query(
    `select m.id, m.group_id, m.telegram_message_id::text, m.author_user_id, m.kind, m.summary, m.text, m.sent_at, m.media_id, md.analysis
       from group_messages m left join media md on md.id = m.media_id
      where m.analysis_status = 'done' and m.task_id is null
        and not exists (select 1 from task_attachments a where a.message_id = m.id)
        and m.analyzed_at > coalesce($1::timestamptz, '-infinity'::timestamptz) and m.analyzed_at <= $2
      order by m.sent_at desc limit ${UNMATCHED_LIMIT}`, window);

  await db.query(
    `insert into group_review_state(org_id, pending_until, pending_cursor, updated_at)
     values (current_setting('app.org_id')::uuid, $1, $2, $3)
     on conflict (org_id) do update set pending_until = excluded.pending_until, pending_cursor = excluded.pending_cursor, updated_at = excluded.updated_at`,
    [new Date(now.getTime() - REVIEW_OVERLAP_MS), cursor, now]);

  return {
    since: since ? iso(since) : null,
    attached: attached.rows.map((r) => ({
      task_id: r.task_id, short_id: r.short_id, title: untrusted(r.title), kind: r.kind, summary: untrusted(r.summary ?? ''),
      confidence: r.confidence, quote: quote(r.text), attachment_id: r.attachment_id, message_id: r.message_id, group_id: r.group_id,
      message_at: iso(r.sent_at),
    })),
    created: created.rows.map(taskForAgent).map((r) => ({
      task_id: r.id, short_id: r.short_id, title: r.title, why: r.why, done_criteria: r.done_criteria,
      rationale: r.rationale, status: r.status, assignee_user_id: r.assignee_user_id, author_agent_id: r.author_agent_id,
      due_date: r.due_date, due_assumed: r.due_assumed, group_id: parseDialogOrigin(r.origin)?.groupId ?? null, created_at: iso(r.created_at),
    })),
    unmatched: unmatched.rows.map((r) => ({
      message_id: r.id, group_id: r.group_id, origin: dialogOrigin(r.group_id, r.telegram_message_id),
      author_user_id: r.author_user_id, kind: r.kind,
      summary: r.summary ? untrusted(r.summary) : quote(r.text),
      image: r.media_id ? { description: untrusted(r.analysis?.description ?? null), text_on_image: untrusted(r.analysis?.text_on_image ?? null) } : null,
      message_at: iso(r.sent_at),
    })),
    close_candidates: await loadCloseCandidates(db, now),
  };
}

/** ack_briefing: сводка с этим курсором разобрана — сдвинуть окно блока groups (только вперёд). */
export async function ackGroupsReview(db: Db, cursor: string): Promise<void> {
  await db.query(
    `update group_review_state
        set acked_until = greatest(coalesce(acked_until, '-infinity'::timestamptz), pending_until), updated_at = now()
      where pending_cursor = $1 and pending_until is not null`, [cursor]);
}

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Перенести вложение к другой открытой задаче или отвязать (task = null) — поправка неверной привязки.
 * Отвязанное фото снова живёт по правилу 30 дней. Событие attachment_moved — агентам обеих задач.
 */
export async function moveAttachment(db: Db, attachmentId: string, taskId: string | null, actor: Actor): Promise<{ attachment_id: string | null; task_id: string | null }> {
  if (!UUID.test(attachmentId)) throw new AppError('not_found', 'Attachment not found');
  // Вложение дела трогает тот, кому видно само дело (аудит 07.10): правило закрытых досок — на tasks.
  const a = (await db.query(
    `select a.id, a.task_id, a.media_id, a.message_id from task_attachments a left join tasks t on t.id = a.task_id
      where a.id = $1 and (a.task_id is null or t.id is not null) for update of a`, [attachmentId])).rows[0];
  if (!a) throw new AppError('not_found', 'Attachment not found');
  if (taskId !== null) {
    const t = UUID.test(taskId) ? (await db.query('select id, status from tasks where id = $1', [taskId])).rows[0] : undefined;
    if (!t) throw new AppError('not_found', 'Task not found');
    if (!OPEN_STATUSES.includes(t.status)) throw new AppError('conflict', 'The task is closed — an attachment can be moved only to an open task', { status: t.status });
    if (t.id === a.task_id) return { attachment_id: a.id, task_id: a.task_id };
  }

  let resultId: string | null = a.id;
  if (taskId === null) {
    await db.query('delete from task_attachments where id = $1', [a.id]);
    resultId = null;
  } else {
    // То же фото у задачи уже есть — перенос сливается с ним.
    const same = await db.query('select id from task_attachments where task_id = $1 and media_id = $2', [taskId, a.media_id]);
    if (same.rowCount) {
      await db.query('delete from task_attachments where id = $1', [a.id]);
      resultId = same.rows[0].id;
    } else {
      await db.query('update task_attachments set task_id = $2 where id = $1', [a.id, taskId]);
    }
  }
  if (a.message_id) {
    await db.query('update group_messages set task_id = $3 where id = $1 and task_id = $2', [a.message_id, a.task_id, taskId]);
  }
  const data = { attachment_id: a.id, media_id: a.media_id, from_task_id: a.task_id, to_task_id: taskId };
  const who = { actorUserId: actorUserId(actor), actorAgentId: actorAgentId(actor) };
  await emit(db, { type: 'attachment_moved', taskId: a.task_id, ...who, data });
  if (taskId) await emit(db, { type: 'attachment_moved', taskId, ...who, data });
  return { attachment_id: resultId, task_id: taskId };
}

/**
 * «Похоже, готово — отметить?» исполнителю по просьбе агента — тот же maybe_done и тот же лимит:
 * не чаще раза в 4 рабочих часа по задаче. Лимит — не ошибка: ответ с временем, когда можно снова.
 */
export async function askDone(db: Db, taskId: string, now: Date = new Date()): Promise<{ sent: true } | { sent: false; reason: 'too_soon'; next_at: string }> {
  const t = UUID.test(taskId) ? (await db.query('select id, status, assignee_user_id from tasks where id = $1', [taskId])).rows[0] : undefined;
  if (!t) throw new AppError('not_found', 'Task not found');
  if (!MAYBE_DONE_STATUSES.includes(t.status)) {
    throw new AppError('conflict', 'You can ask only about a task in progress (active, in_progress, rework)', { status: t.status });
  }
  const next = await maybeDoneNextAt(db, t);
  if (next && next > now) return { sent: false, reason: 'too_soon', next_at: next.toISOString() };
  // «Да» кладёт в результат пересказ из группы — последний уверенный «сделано», если он был.
  const claim = await db.query(
    `select summary from group_messages where task_id = $1 and kind = 'done_claim' and confidence >= $2 order by sent_at desc limit 1`,
    [t.id, CONFIDENCE_THRESHOLD]);
  await notify(db, {
    userId: t.assignee_user_id, kind: 'maybe_done', level: 'work', taskId: t.id,
    payload: { summary: claim.rows[0]?.summary ?? '', source: 'agent' },
  });
  return { sent: true };
}
