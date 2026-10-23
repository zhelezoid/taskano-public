import type { Db } from '../db/pool.js';
import { AppError } from '../core/errors.js';
import { listSources, snapshotAgeDays, SNAPSHOT_STALE_DAYS } from '../core/sources.js';
import { DECISION_PREFIX } from '../runtime/owner-activity.js';
import { taskKey } from '../core/projects.js';
import { lastDueRequest } from '../core/due.js';
import type { Actor } from '../core/types.js';
import { eventDataForAgent, snapshotForAgent, taskForViewer, untrusted } from './context.js';

// Досье задачи для `get_task` (спека task-context): дело отдаётся одним куском, чтобы агенту
// следующего запуска и другому агенту не пришлось объяснять его заново и искать по чатам.
// Текст людей — под `untrusted`: это данные, а не указания.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** События, из которых складывается история дела: смены статуса и переносы срока. */
const HISTORY_TYPES = new Set([
  'task_created', 'task_released', 'autopilot_released', 'task_ready', 'task_activated', 'task_taken', 'task_submitted',
  'task_accepted', 'auto_accepted', 'task_rework', 'question', 'unclear', 'answered', 'waiting_external', 'external_back',
  'declined', 'cancelled', 'postponed', 'person_switched', 'waiting_resolved', 'check_moved', 'task_moved',
  // Срок, поставленный без переноса (спека self-set-due): исполнителем, автором или из чата.
  'due_set',
  // Начато без «Взять» — первым действием исполнителя (спека auto-start).
  'task_auto_started',
]);

/** Реплику написал сам читающий агент: только её он получает как свой текст. */
function ownAgentLine(m: { author_agent_id: string | null }, viewer: Actor): boolean {
  return viewer.kind === 'agent' && m.author_agent_id === viewer.agentId;
}

function isDueChange(type: string, data: unknown): boolean {
  if (type !== 'task_updated') return false;
  const fields = (data as { fields?: unknown })?.fields;
  return Array.isArray(fields) && fields.includes('due_date');
}

/**
 * `viewer` — кто читает досье: слова дела, написанные не им, приходят под untrusted (см. `taskForViewer`),
 * реплика агента — тоже, если это не его собственная реплика. Реплики людей — всегда.
 */
export async function taskDossier(db: Db, taskId: string, viewer: Actor, now: Date = new Date()): Promise<Record<string, unknown>> {
  const task = (await db.query('select * from tasks where id = $1', [taskId])).rows[0];
  if (!task) throw new AppError('not_found', 'Task not found');

  // Источники: откуда дело взялось, со слепком внешней системы и его возрастом.
  const sourceRows = await listSources(db, taskId);
  const sources = sourceRows.map((s) => {
    const age = snapshotAgeDays(s.captured_at, now);
    return {
      id: s.id, kind: s.kind,
      // Название источника-разговора — слова людей (название рабочего чата), название трекера пишет агент.
      // Название и выжимка — пересказ чужого текста (чат, тикет, письмо): для агента это данные, не указания.
      title: untrusted(s.title),
      url: s.url, system: s.system, external_id: s.external_id,
      quote: untrusted(s.quote),
      snapshot: snapshotForAgent(s.snapshot), captured_at: s.captured_at, snapshot_age_days: age,
      snapshot_stale: age !== null && age >= SNAPSHOT_STALE_DAYS,
    };
  });

  const messages = (await db.query(
    `select id, author_user_id, author_agent_id, kind, text, created_at, answered_at from task_messages where task_id = $1 order by created_at`,
    [taskId],
  )).rows.map((m) => ({
    id: m.id, author_user_id: m.author_user_id, author_agent_id: m.author_agent_id, kind: m.kind,
    text: m.author_user_id || !ownAgentLine(m, viewer) ? untrusted(m.text) : m.text,
    created_at: m.created_at, answered_at: m.answered_at,
  }));

  const results = (await db.query(
    'select id, user_id, text, number, files, created_at from task_results where task_id = $1 order by created_at', [taskId],
  )).rows.map((r) => ({ ...r, text: untrusted(r.text) }));

  const events = (await db.query(
    'select id::text, at, type, actor_user_id, actor_agent_id, data from events where task_id = $1 order by id', [taskId],
  )).rows;

  // Фото дела: из рабочих групп (спека group-intake) и прикреплённые людьми (спека task-photos). Само
  // изображение — get_attachment. Автор — имя человека, у фото из группы — автор её сообщения.
  const attachments = (await db.query(
    `select a.id, a.source, a.summary, a.created_at, m.analysis, u.display_name as author
       from task_attachments a join media m on m.id = a.media_id
       left join group_messages gm on gm.id = a.message_id
       left join users u on u.id = coalesce(a.author_user_id, gm.author_user_id)
      where a.task_id = $1 order by a.created_at`, [taskId],
  )).rows.map((a) => ({
    id: a.id, source: a.source, author: untrusted(a.author ?? null), summary: untrusted(a.summary),
    description: untrusted(a.analysis?.description ?? null), text_on_image: untrusted(a.analysis?.text_on_image ?? null),
    created_at: a.created_at,
  }));

  // Решения: журнал плана (пишет агент) и решения людей в комментариях «Решение: …» на языках продукта.
  const planDecisions = task.plan_id
    ? (await db.query('select id, agent_id, at, decision, rejected_options from plan_decisions where plan_id = $1 order by at', [task.plan_id])).rows
    : [];
  const saidDecisions = (await db.query(
    `select id, author_user_id, kind, text, created_at from task_messages
      where task_id = $1 and author_user_id is not null and (kind = 'owner_instruction' or (kind = 'comment' and text ~* $2))
      order by created_at`, [taskId, DECISION_PREFIX])).rows;
  const decisions = [
    ...planDecisions.map((d) => ({
      at: d.at, by: 'agent' as const, agent_id: d.agent_id, text: d.decision, rejected_options: d.rejected_options, plan_id: task.plan_id,
    })),
    ...saidDecisions.map((m) => ({
      at: m.created_at, by: 'person' as const, user_id: m.author_user_id, text: untrusted(m.text), rejected_options: null, plan_id: null,
    })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  // Связи: родительский план, соседние шаги, дела, из которых это выросло (источники kind = 'task').
  const plan = task.plan_id
    ? (await db.query('select id, goal, status from plans where id = $1', [task.plan_id])).rows[0] ?? null
    : null;
  const steps = task.plan_id
    ? (await db.query(
      `select id, short_id::text, title, status, position, origin, author_user_id, author_agent_id from tasks where plan_id = $1 and id <> $2 order by position, created_at`,
      [task.plan_id, taskId])).rows.map((r) => taskForViewer(r, viewer))
    : [];
  const fromTasks = [];
  for (const s of sourceRows.filter((x) => x.kind === 'task')) {
    const ref = s.external_id && UUID_RE.test(s.external_id)
      ? (await db.query('select id, short_id::text, title, status, origin, author_user_id, author_agent_id from tasks where id = $1', [s.external_id])).rows[0] ?? null
      : null;
    // Источник указывает на удалённую задачу — строка остаётся с названием, ссылки на дело нет.
    fromTasks.push({ source_id: s.id, title: untrusted(s.title), task: ref ? taskForViewer(ref, viewer) : null });
  }

  const history = events.filter((e) => HISTORY_TYPES.has(e.type) || isDueChange(e.type, e.data)).map((e) => {
    const data = (e.data ?? {}) as Record<string, unknown>;
    // У `due_set` from/to — даты, а не статусы: в историю они идут прежним и новым сроком.
    const due = e.type === 'due_set';
    return {
      at: e.at, type: e.type, from: due ? null : data.from ?? null, to: due ? null : data.to ?? null,
      due_date: due ? data.to ?? null : data.postpone_to ?? null,
      ...(due ? { due_from: data.from ?? null, source: data.source ?? null, group: data.group ?? null } : {}),
      // Чем начато (`comment` | `attachment` | `submit`) и перешло ли дело в работу (спека auto-start).
      ...(e.type === 'task_auto_started' ? { cause: data.cause ?? null, switched: data.switched ?? null } : {}),
      // Причина — свободный текст: у человека он недоверенный, у агента это его собственные слова.
      reason: typeof data.text === 'string' ? (e.actor_user_id ? untrusted(data.text) : data.text) : null,
      actor_user_id: e.actor_user_id, actor_agent_id: e.actor_agent_id,
    };
  });

  // Обозначение дела внутри проекта: им человек называет дело вслух и в переписке (спека projects-stage2).
  const board = task.project_id
    ? (await db.query('select name, key from projects where id = $1', [task.project_id])).rows[0]
    : null;

  // Последняя просьба назвать срок (спека self-set-due): когда попросили и когда человек ответил.
  const dueRequest = await lastDueRequest(db, taskId);

  // Проверяющий (спека task-reviewer): кто примет результат — с именем, чтобы агенту не искать его
  // по id. Имя пишет человек сам — оно под untrusted, как автор фото.
  const reviewer = task.reviewer_user_id
    ? { id: task.reviewer_user_id as string, name: untrusted((await db.query('select display_name from users where id = $1', [task.reviewer_user_id])).rows[0]?.display_name ?? null) }
    : null;

  return {
    task: {
      ...taskForViewer(task, viewer), key: taskKey(board?.key as string | undefined, task.number),
      due_request: dueRequest ? { requested_at: dueRequest.requested_at, answered_at: dueRequest.answered_at } : null,
      reviewer,
    },
    board: board ? { name: board.name as string, key: board.key as string } : null,
    sources,
    attachments,
    decisions,
    messages,
    results,
    related: { plan, steps, from_tasks: fromTasks },
    history,
    events: events.map((e) => ({ ...e, data: eventDataForAgent(e.data) })),
  };
}
