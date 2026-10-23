import type { Db } from '../db/pool.js';
import { AppError } from './errors.js';
import type { Actor } from './types.js';
import { actorAgentId, actorUserId } from './types.js';

// Источники дела (спека task-context): откуда дело взялось и что агент прочитал снаружи.
// Сервер сам никуда не ходит — слепок приносит агент своим коннектором, сервер его хранит.

export type SourceKind = 'chat' | 'group' | 'external' | 'task';

/** Цитата-основание: слова людей, не пересказ переписки. Длиннее — обрезается с многоточием. */
export const QUOTE_LIMIT = 500;
/** Слепок — выжимка, а не копия страницы. */
export const SUMMARY_LIMIT = 1000;
/** Слепок старше этого — повод агенту сходить и освежить (решает он, сервер ничего не делает сам). */
/** Больше источников на одно дело не бывает: досье остаётся обозримым, поток вызовов не раздувает ответ. */
export const SOURCE_LIMIT = 50;

export const SNAPSHOT_STALE_DAYS = 7;

export interface Snapshot {
  status?: string;
  summary?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface SourceInput {
  taskId: string;
  kind: SourceKind;
  title: string;
  url?: string | null;
  system?: string | null;
  externalId?: string | null;
  quote?: string | null;
  snapshot?: Snapshot | null;
  /** Когда это было снаружи; не назвали — время слепка, если он есть. У сообщения чата — время сообщения. */
  capturedAt?: Date | null;
}

export interface SourceRow {
  id: string;
  task_id: string;
  kind: SourceKind;
  title: string;
  url: string | null;
  system: string | null;
  external_id: string | null;
  quote: string | null;
  snapshot: Snapshot | null;
  captured_at: Date | null;
  created_at: Date;
}

export function trimQuote(quote: string): string {
  return quote.length <= QUOTE_LIMIT ? quote : `${quote.slice(0, QUOTE_LIMIT - 1)}…`;
}

/** Слепок пишет агент: копию страницы вместо выжимки не берём — она съест контекст следующего запуска. */
function checkSnapshot(snapshot: Snapshot | null | undefined): void {
  if (!snapshot) return;
  if (typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new AppError('validation_failed', 'snapshot must be an object: {status, summary, updated_at}');
  const summary = snapshot.summary;
  if (summary !== undefined && typeof summary !== 'string') throw new AppError('validation_failed', 'snapshot.summary must be a string');
  if (typeof summary === 'string' && summary.length > SUMMARY_LIMIT) {
    throw new AppError('validation_failed', `snapshot.summary is longer than ${SUMMARY_LIMIT} characters — it is a summary, not a copy`, { length: summary.length });
  }
}

/** Возраст слепка в днях — по нему агент решает, идти ли смотреть заново. */
export function snapshotAgeDays(capturedAt: Date | string | null, now: Date = new Date()): number | null {
  if (!capturedAt) return null;
  return Math.floor((now.getTime() - new Date(capturedAt).getTime()) / 86400000);
}

/**
 * Источник из рабочего чата пишет только сервер (спека self-set-due): по нему видно, откуда взялся
 * срок, и подложенный со стороны `group`/`telegram` выдавал бы чужие слова за сообщение из чата.
 */
export function assertNotServerSource(kind: string, system: string | null | undefined): void {
  if (kind === 'group' || system?.trim().toLowerCase() === 'telegram') {
    throw new AppError('validation_failed', 'A source from a Telegram work chat is written by the server itself — use kind "chat" or "external"');
  }
}

/**
 * Добавить источник. Идемпотентно: тот же объект внешней системы `(system, external_id)` у того же
 * дела или тот же адрес у того же дела `(task, url)` обновляет строку, а не заводит вторую. Один
 * объект может быть источником нескольких дел (одно сообщение чата называет сроки двум делам) —
 * строка у каждого своя и на другое дело не переезжает (миграция 024).
 */
export async function addSource(db: Db, input: SourceInput, actor: Actor, now: Date = new Date()): Promise<{ id: string; created: boolean }> {
  const t = await db.query('select id from tasks where id = $1', [input.taskId]);
  if (!t.rowCount) throw new AppError('not_found', 'Task not found');
  if (!input.title?.trim()) throw new AppError('validation_failed', 'title is required — how a person names this source');
  // У источника-дела `external_id` — это id задачи Taskano, своей системы у него нет; у остальных
  // система и идентификатор в ней имеют смысл только вместе.
  if (input.kind !== 'task' && Boolean(input.system) !== Boolean(input.externalId)) {
    throw new AppError('validation_failed', 'system and external_id go together — the object in the external system');
  }
  checkSnapshot(input.snapshot);
  // Лимит считаем только для новой строки: повтор того же источника — обновление, он ничего не добавляет.
  const known = await db.query(
    `select count(*)::int as n,
        count(*) filter (where ($2::text is not null and system = $2 and external_id = $3)
          or ($4::text is not null and url = $4))::int as same
      from task_sources where task_id = $1`,
    [input.taskId, input.system ?? null, input.externalId ?? null, input.url ?? null]);
  const { n, same } = known.rows[0] as { n: number; same: number };
  if (!same && n >= SOURCE_LIMIT) {
    throw new AppError('limit_exceeded', `No more than ${SOURCE_LIMIT} sources per task — keep the dossier readable`);
  }

  const values = [
    input.taskId, input.kind, input.title.trim(), input.url ?? null, input.system ?? null, input.externalId ?? null,
    input.quote ? trimQuote(input.quote) : null, input.snapshot ? JSON.stringify(input.snapshot) : null,
    input.capturedAt ?? (input.snapshot ? now : null), actorAgentId(actor), actorUserId(actor), now,
  ];
  const insert = `insert into task_sources(org_id, task_id, kind, title, url, system, external_id, quote, snapshot,
      captured_at, captured_by_agent_id, captured_by_user_id, created_at)
    values (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`;
  const update = `do update set kind = excluded.kind, title = excluded.title,
      url = coalesce(excluded.url, task_sources.url), quote = coalesce(excluded.quote, task_sources.quote),
      snapshot = coalesce(excluded.snapshot, task_sources.snapshot),
      captured_at = coalesce(excluded.captured_at, task_sources.captured_at),
      captured_by_agent_id = excluded.captured_by_agent_id, captured_by_user_id = excluded.captured_by_user_id
    returning id, (xmax = 0) as created`;

  if (input.system && input.externalId) {
    const r = await db.query(
      `${insert} on conflict (org_id, task_id, system, external_id) where system is not null and external_id is not null ${update}`, values);
    return r.rows[0] as { id: string; created: boolean };
  }
  if (input.url) {
    const r = await db.query(`${insert} on conflict (org_id, task_id, url) where url is not null ${update}`, values);
    return r.rows[0] as { id: string; created: boolean };
  }
  const r = await db.query(`${insert} returning id, true as created`, values);
  return r.rows[0] as { id: string; created: boolean };
}

export async function listSources(db: Db, taskId: string): Promise<SourceRow[]> {
  const r = await db.query(
    `select id, task_id, kind, title, url, system, external_id, quote, snapshot, captured_at, created_at
       from task_sources where task_id = $1 order by created_at, id limit ${SOURCE_LIMIT}`, [taskId]);
  return r.rows as SourceRow[];
}

/**
 * Источник дела из рабочего чата: `origin = group:<group_id>:<message_id>`, `rationale` — слова людей
 * группы. Ставится при создании задачи, чтобы новые дела несли то же основание, что и перенесённые
 * миграцией 006 (она делает ровно это для уже существовавших).
 */
export async function addGroupSource(
  db: Db, taskId: string, groupId: string, quote: string, actor: Actor, now: Date = new Date(), message?: GroupSourceMessage,
): Promise<void> {
  const g = (await db.query('select title, telegram_chat_id::text as chat_id from group_chats where id = $1', [groupId])).rows[0];
  const title = (g?.title as string | undefined)?.trim() || 'Telegram';
  if (!message) {
    await addSource(db, { taskId, kind: 'group', title, quote }, actor, now);
    return;
  }
  // Источник срока из чата пишется полностью (спека self-set-due): какое сообщение, когда
  // и кем написано. Без этого «срок поставлен из чата» нельзя проверить — цитата без времени и
  // автора ничего не доказывает. Сообщение Telegram адресуется парой «чат : сообщение».
  await addSource(db, {
    taskId, kind: 'group', title, quote, system: 'telegram', externalId: `${g?.chat_id ?? groupId}:${message.messageId}`,
    capturedAt: message.sentAt,
    snapshot: {
      group_id: groupId, message_id: message.messageId, author_user_id: message.authorUserId,
      sent_at: message.sentAt.toISOString(), ...(message.dueDate ? { due_date: message.dueDate } : {}),
    },
  }, actor, now);
}

/** Сообщение рабочего чата, из которого взят факт о деле. */
export interface GroupSourceMessage {
  /** id сообщения в Telegram. */
  messageId: string;
  sentAt: Date;
  authorUserId: string;
  /** Срок, названный в сообщении, — если источник записан ради него. */
  dueDate?: string | null;
}
