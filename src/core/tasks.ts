import type { Db } from '../db/pool.js';
import { detectLanguage } from '../ai/detect-language.js';
import { enqueueTaskTranslation } from '../ai/translate-queue.js';
import { AppError } from './errors.js';
import { emit } from './events.js';
import { requireMember } from './access.js';
import { isPersonalPlace } from './personal-place.js';
import { localDate, loadUserSchedule, nextWorkingStart, zonedToUtc } from './calendar.js';
import { assertStepContext, transition } from './lifecycle.js';
import { fillSlot } from './queue.js';
import { addGroupSource } from './sources.js';
import { answerDueRequests, applyDueDate } from './due.js';
import { ensureDefaultProject, memberIds, nextProjectNumber, privateOwnerFor, resolveProject, sessionUser, type ProjectRow } from './projects.js';
import { parseDialogOrigin } from '../groups/dialog-tasks.js';
import { createProposal, proposalText, recordVetoable } from './proposals.js';
import { logger } from '../log.js';
import type { Actor, Task, WaitingInfo } from './types.js';
import { actorAgentId, actorUserId } from './types.js';

// Создание и правка задач, планов, ожиданий. Все смены статуса — через lifecycle.transition.

export interface TaskInput {
  planId?: string | null;
  /** Проект (id или название); не назвали — проект организации по умолчанию (спека projects). */
  project?: string | null;
  kind?: 'action' | 'waiting';
  title: string;
  description?: string;
  why?: string;
  doneCriteria?: string;
  assigneeUserId: string;
  dueDate?: string | null;              // 'YYYY-MM-DD' в поясе исполнителя
  activateAt?: string | null;           // ISO
  expectedResult?: { type: 'text' | 'number' | 'file' | 'photo'; required: boolean } | null;
  estimateMinutes?: number | null;
  priority?: 'normal' | 'urgent';          // в личном пространстве urgent = «важно»
  category?: 'do' | 'decide' | 'someday' | null; // вид личного дела
  autoReleaseOk?: boolean;
  release?: boolean;                    // шаг плана сразу в ready
  rationale?: string | null;
  origin?: string | null;
  links?: unknown[];
  external?: unknown;
  sourceLanguage?: string | null;
  /** Задача из переписки группы (спека group-intake, 1b): уровень «с правом вето» со своей строкой
   *  владельцу вместо «первого шага человеку»; откат — отмена задачи. */
  dialogVeto?: { summary: string };
  waiting?: { waitingFor: string; expectedAt?: string | null; nextCheckAt?: string | null; checkUserId?: string | null; onArrival?: string | null; contact?: string | null };
  /** Проверяющий обычного дела (спека task-reviewer): принимает сданное вместо автора. */
  reviewerUserId?: string | null;
}

async function currentOrg(db: Db): Promise<{ id: string; kind: 'company' | 'personal' }> {
  const r = await db.query(`select id, kind from orgs where id = current_setting('app.org_id')::uuid`);
  return r.rows[0];
}

async function orgKind(db: Db): Promise<'company' | 'personal'> {
  return (await currentOrg(db)).kind;
}

async function agentOwnerId(db: Db, agentId: string): Promise<string> {
  const r = await db.query('select owner_user_id, status from agents where id = $1', [agentId]);
  if (!r.rowCount) throw new AppError('not_found', 'Agent not found');
  if (r.rows[0].status === 'paused') throw new AppError('agent_paused', 'The agent is paused');
  return r.rows[0].owner_user_id;
}

/** Первая проверка проверки времени проверки ожидания: за 7/3/1 день до ожидаемой даты, иначе через неделю. */
export function firstCheckAt(now: Date, expectedAt: Date | null): Date {
  if (!expectedAt) return new Date(now.getTime() + 7 * 86400000);
  for (const days of [7, 3, 1]) {
    const t = new Date(expectedAt.getTime() - days * 86400000);
    if (t > now) return t;
  }
  return new Date(Math.max(now.getTime() + 86400000, expectedAt.getTime()));
}

/**
 * Кого записать проверяющим (спека task-reviewer). Проверяющий свидетельствует о чужой работе, поэтому
 * исполнителем он быть не может. Автор-человек и так принимает сам — его не пишем: это обычная
 * приёмка, а не отдельная роль. В закрытый проект проверяющий входит на тех же правах, что
 * исполнитель: иначе ему пришло бы на приёмку дело, которого он не видит.
 */
async function reviewerFor(
  db: Db, reviewerUserId: string | null,
  ctx: { assigneeUserId: string; authorUserId: string; project: ProjectRow | null; members: string[] },
): Promise<string | null> {
  if (!reviewerUserId) return null;
  const m = (await db.query(
    `select role from memberships where org_id = current_setting('app.org_id')::uuid and user_id = $1 and status = 'active'`,
    [reviewerUserId])).rows[0] as { role: string } | undefined;
  if (!m) throw new AppError('validation_failed', 'The reviewer must be an active member of the organization');
  // Гость — человек со стороны: принимать работу людей компании ему не поручают (спека task-reviewer;
  // запрет по умолчанию, решение за владельцем).
  if (m.role === 'guest') throw new AppError('validation_failed', "A guest can't be the reviewer — they are not part of the company");
  if (reviewerUserId === ctx.assigneeUserId) throw new AppError('validation_failed', "The reviewer can't be the person doing the task");
  if (reviewerUserId === ctx.authorUserId) return null;
  const p = ctx.project;
  if (p?.private && reviewerUserId !== p.owner_user_id && !ctx.members.includes(reviewerUserId)) {
    throw new AppError('validation_failed', `Project "${p.name}" is private — add the reviewer to it first`);
  }
  return reviewerUserId;
}

export async function createTask(db: Db, input: TaskInput, actor: Actor, now: Date = new Date()): Promise<Task> {
  const org = await currentOrg(db);
  const taskKind = input.kind ?? 'action';
  if (!input.title?.trim()) throw new AppError('validation_failed', 'title is required — what to do');

  await requireMember(db, input.assigneeUserId);
  let authorUserId: string;
  const agentId = actorAgentId(actor);
  if (agentId) {
    authorUserId = await agentOwnerId(db, agentId);
  } else if (actor.kind === 'user') {
    authorUserId = actor.userId;
    if (input.assigneeUserId !== actor.userId) {
      // Ставить дела другим может любой участник (спека roles-and-rights): люди договариваются
      // между собой, и запрет «только начальник» ломал ровно то, ради чего систему ставят. Гость —
      // человек со стороны, ему компания дел не раздаёт и он её людям тоже.
      const m = await requireMember(db, actor.userId);
      if (m.role === 'guest') throw new AppError('forbidden', 'A guest can only set tasks for themselves');
    }
  } else {
    throw new AppError('forbidden', 'The system does not create tasks');
  }

  // Личное — только то, что человек завёл себе сам (спека projects-stage2): автор и исполнитель
  // один человек, доска закрыта и пуста. Считаем после того, как выяснили автора.
  const personal = await isPersonalPlace(db, {
    projectId: input.project ?? null, assigneeUserId: input.assigneeUserId,
    authorUserId, authorAgentId: agentId,
  });

  const schedule = await loadUserSchedule(db, input.assigneeUserId);
  let dueDate = input.dueDate ?? null;
  if (!personal) {
    const missing: string[] = [];
    if (!input.why?.trim()) missing.push('why');
    if (!input.doneCriteria?.trim() && taskKind === 'action') missing.push('done_criteria');
    // Объяснение обязательно (спека task-context): дело выполняет тот, кто не читал
    // разговор, а иногда и не человек — его нейросеть не переспросит, а сделает плохо и уверенно.
    if (!input.description?.trim() && taskKind === 'action') missing.push('description');
    if (taskKind === 'action' && !dueDate) missing.push('due_date');
    if (taskKind === 'waiting' && !input.waiting?.waitingFor) missing.push('waiting.waiting_for');
    if (taskKind === 'waiting' && !input.waiting?.expectedAt && !input.waiting?.nextCheckAt) missing.push('waiting.expected_at или waiting.next_check_at');
    if (missing.length) throw new AppError('validation_failed', `Missing required fields: ${missing.join(', ')}`, { missing });
  }
  // Личное без даты остаётся без даты: выдуманный срок «завтра» превращал список в одну кучу на завтра.
  if (!personal && input.category) throw new AppError('validation_failed', 'category — personal space only');
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new AppError('validation_failed', 'due_date — format YYYY-MM-DD');

  let plan: { id: string; agent_id: string; status: string } | null = null;
  if (input.planId) {
    plan = (await db.query('select id, agent_id, status from plans where id = $1', [input.planId])).rows[0] ?? null;
    if (!plan) throw new AppError('not_found', 'Plan not found');
    if (agentId && plan.agent_id !== agentId) throw new AppError('forbidden', 'The plan belongs to another agent');
    if (['done', 'failed', 'stopped'].includes(plan.status)) throw new AppError('conflict', 'The plan is closed');
  }

  const activateAt = input.activateAt ? new Date(input.activateAt) : null;
  let status: Task['status'];
  if (taskKind === 'waiting') status = 'waiting';
  else if (plan && !input.release) status = 'draft';
  else status = activateAt && activateAt > now ? 'scheduled' : 'ready';

  // Лимит шагов агента одному человеку в день: сверх — draft + предложение (спека, «Лимиты»).
  // Квота — на человека (спека multi-company): она и лежит в queue_settings по user_id,
  // а считалась по агенту внутри организации, и человек в двух компаниях получал за день две
  // полных квоты. Считаем через функцию с правами владельца (миграция 018) — она видит шаги во
  // всех его компаниях, включая записанные этой же транзакцией, и отдаёт только число.
  let overLimit = false;
  if (agentId && taskKind === 'action') {
    // И порог берём по человеку, а не по этой компании: иначе компания с нетронутой настройкой
    // выдавала бы 20 шагов там, где соседняя ограничила двумя (миграция 018).
    const limitRow = await db.query('select person_daily_step_limit($1) as n', [input.assigneeUserId]);
    const limit = limitRow.rows[0].n as number;
    const today = localDate(now, schedule.tz);
    const [y, m, d] = today.split('-').map(Number) as [number, number, number];
    const dayStart = zonedToUtc(y, m, d, 0, 0, schedule.tz);
    const count = await db.query('select person_agent_steps_since($1, $2) as n', [input.assigneeUserId, dayStart]);
    if (count.rows[0].n >= limit) { overLimit = true; status = 'draft'; }
  }

  let waiting: WaitingInfo | null = null;
  if (taskKind === 'waiting' && input.waiting) {
    const expected = input.waiting.expectedAt ? new Date(input.waiting.expectedAt) : null;
    const next = input.waiting.nextCheckAt ? new Date(input.waiting.nextCheckAt) : firstCheckAt(now, expected);
    waiting = {
      waiting_for: input.waiting.waitingFor, expected_at: expected?.toISOString() ?? null, next_check_at: next.toISOString(),
      check_user_id: input.waiting.checkUserId ?? input.assigneeUserId, on_arrival: input.waiting.onArrival ?? null,
      contact: input.waiting.contact ?? null, checks_done: 0,
    };
  }

  const position = plan
    ? ((await db.query('select coalesce(max(position), 0) + 1 as p from tasks where plan_id = $1', [plan.id])).rows[0].p as number)
    : 0;

  // Дело всегда лежит в проекте (спека projects): назвали — в нём, не назвали — в проекте
  // организации по умолчанию. Закрытый проект держит и правило видимости самого дела.
  const project = input.project
    ? await resolveProject(db, input.project, sessionUser(actor))
    : await ensureDefaultProject(db, org.id);
  const members = await memberIds(db, project);
  const privateOwner = privateOwnerFor(project, input.assigneeUserId, actor, members);
  if (input.reviewerUserId && taskKind === 'waiting') {
    throw new AppError('validation_failed', "A reviewer is for an action — a waiting has its own check_person");
  }
  const reviewerUserId = await reviewerFor(db, input.reviewerUserId ?? null, {
    assigneeUserId: input.assigneeUserId, authorUserId, project, members,
  });
  // Номер внутри проекта: «NOR-001» (спека projects-stage2). Счётчик двигает сам проект,
  // поэтому параллельные вставки не получают один номер.
  const number = await nextProjectNumber(db, project.id);

  const firstForPerson = agentId && !personal
    ? !(await db.query('select 1 from tasks where author_agent_id = $1 and assignee_user_id = $2 limit 1', [agentId, input.assigneeUserId])).rowCount
    : false;

  const r = await db.query(
    `insert into tasks(org_id, plan_id, position, kind, title, description, why, done_criteria, expected_result, origin, links,
       rationale, assignee_user_id, author_agent_id, author_user_id, status, due_date, due_tz, activate_at, priority,
       estimate_minutes, auto_release_ok, source_language, external, waiting, category, project_id, private_owner_user_id,
       number, reviewer_user_id, created_at, updated_at, status_changed_at)
     values (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
       $20, $21, $22, $23, $24, $26, $27, $28, $29, $30, $25, $25, $25)
     returning *`,
    [plan?.id ?? null, position, taskKind, input.title.trim(), input.description ?? '', input.why ?? '', input.doneCriteria ?? '',
      input.expectedResult ? JSON.stringify(input.expectedResult) : null, input.origin ?? null, JSON.stringify(input.links ?? []),
      input.rationale ?? null, input.assigneeUserId, agentId, authorUserId, status, dueDate, dueDate ? schedule.tz : null,
      activateAt, input.priority ?? 'normal', input.estimateMinutes ?? null, input.autoReleaseOk ?? false,
      input.sourceLanguage ?? detectLanguage([input.title, input.why, input.doneCriteria].filter(Boolean).join('. ')), input.external ? JSON.stringify(input.external) : null, waiting ? JSON.stringify(waiting) : null, now, input.category ?? null,
      project.id, privateOwner, number, reviewerUserId],
  );
  const task = r.rows[0] as Task;
  // Дело из рабочего чата несёт своё основание источником (спека task-context): `origin` + `rationale`
  // → источник `kind = 'group'` с цитатой. Ровно это миграция 006 сделала с уже существовавшими делами.
  const fromGroup = parseDialogOrigin(task.origin);
  if (fromGroup && task.rationale?.trim()) await addGroupSource(db, task.id, fromGroup.groupId, task.rationale, actor, now);
  await emit(db, {
    type: 'task_created', taskId: task.id, planId: task.plan_id, agentId, actorUserId: actorUserId(actor), actorAgentId: agentId,
    data: { status, assignee_user_id: task.assignee_user_id },
    at: now,
  });

  if (overLimit && agentId) {
    await createProposal(db, { agentId, planId: task.plan_id, taskId: task.id, type: 'step_limit', summary: await proposalText(db, 'proposal.step_limit', { title: task.title }) }, now);
  } else if (input.dialogVeto && agentId) {
    await recordVetoable(db, {
      agentId, kind: 'dialog_task', summary: input.dialogVeto.summary, before: { task_id: task.id }, after: { origin: task.origin }, taskId: task.id,
    }, now);
  } else if (firstForPerson && agentId) {
    await recordVetoable(db, { agentId, kind: 'new_person', summary: `Первый шаг человеку: ${task.title}`, before: { task_id: task.id }, after: {}, taskId: task.id }, now);
  }
  if (status === 'ready' && !personal && taskKind === 'action') await fillSlot(db, task.assignee_user_id, now);
  if (reviewerUserId) await handReviewOver(db, task, { from: null, to: reviewerUserId, by: actorUserId(actor) }, now);
  // Перевод для тех, кто читает на другом языке, готовится фоном — открытие карточки его не ждёт.
  await enqueueTaskTranslation(db, task.id);
  return (await db.query('select * from tasks where id = $1', [task.id])).rows[0] as Task;
}

export async function createPlan(db: Db, agentId: string, goal: string, actor: Actor): Promise<{ id: string }> {
  if (!goal?.trim()) throw new AppError('validation_failed', 'A plan goal is required');
  await agentOwnerId(db, agentId);
  const r = await db.query(
    `insert into plans(org_id, agent_id, goal) values (current_setting('app.org_id')::uuid, $1, $2) returning id`, [agentId, goal.trim()]);
  await emit(db, { type: 'plan_created', agentId, planId: r.rows[0].id, actorUserId: actorUserId(actor), actorAgentId: agentId, data: { goal } });
  return r.rows[0];
}

export async function releaseStep(db: Db, taskId: string, actor: Actor, now: Date = new Date()): Promise<Task> {
  const t = await requireAuthorOrManager(db, taskId, actor);
  // Отложенный выпуск (activate_at в будущем) минует transition — правило полноты проверяем здесь же.
  if (t.activate_at && new Date(t.activate_at) > now) {
    if ((await orgKind(db)) !== 'personal') assertStepContext(t);
    await db.query(`update tasks set status = 'scheduled', version = version + 1, updated_at = $2 where id = $1 and status = 'draft'`, [taskId, now]);
    return (await db.query('select * from tasks where id = $1', [taskId])).rows[0];
  }
  return transition(db, taskId, 'release', actor, { now });
}

/**
 * Автор дела: агент, который его ведёт, или человек, который его поставил (спека roles-and-rights).
 *
 * Оба остаются в силе одновременно: `adopt_task` даёт агенту ведение, но не отнимает дело у
 * человека — `author_user_id` не меняется, и проверка смотрит на него независимо от агента.
 *
 * Роль здесь не помогает. Авторство — право свидетельствовать о чужой работе (принять результат,
 * вернуть на доработку), а такого права владельцу компании никто не давал: иначе в «Итогах»
 * появится запись, что человек сдал работу, которую он не сдавал.
 */
export async function requireAuthor(db: Db, taskId: string, actor: Actor): Promise<Task> {
  const t = (await db.query('select * from tasks where id = $1', [taskId])).rows[0] as Task | undefined;
  if (!t) throw new AppError('not_found', 'Task not found');
  if (actor.kind === 'system') return t;
  const agentId = actorAgentId(actor);
  if (agentId) {
    // Помеченное «рабочее» личное дело агент только читает в сводке (спека owner-feedback):
    // не создаёт, не закрывает, не переносит — пометка не даёт права им командовать.
    if (t.shared_org_id) throw new AppError('forbidden', "A personal item of its owner — an agent only reads it in the briefing");
    if (t.author_agent_id !== agentId) throw new AppError('forbidden', 'The task was set by another author');
    return t;
  }
  if (t.author_user_id === actor.userId) return t;
  throw new AppError('forbidden', 'Only the author of the task can do this');
}

/**
 * Принять, вернуть на доработку, закрыть несданное: проверяющий, если он назван, иначе автор
 * (спека task-reviewer). Назвали проверяющего — значит, свидетельствовать о работе поручили ему, и
 * автор этого права больше не имеет: иначе приёмка шла бы мимо того, ради кого его назначили.
 */
export async function requireReviewer(db: Db, taskId: string, actor: Actor): Promise<Task> {
  const t = (await db.query('select * from tasks where id = $1', [taskId])).rows[0] as Task | undefined;
  if (!t) throw new AppError('not_found', 'Task not found');
  if (!t.reviewer_user_id || actor.kind === 'system') return requireAuthor(db, taskId, actor);
  if (actor.kind === 'user' && !actorAgentId(actor) && actor.userId === t.reviewer_user_id) return t;
  throw new AppError('forbidden', 'This task has a reviewer — only they accept the result or send it back');
}

/**
 * Распорядиться делом: автор или владелец с админом (спека roles-and-rights).
 *
 * Переписать, перенести срок, отменить, переназначить, сменить проект — это управление компанией,
 * и владелец в своей компании хозяин. От свидетельства о работе отличается тем, что не утверждает
 * ничего о человеке: дело меняется, а не объявляется сделанным.
 */
export async function requireAuthorOrManager(db: Db, taskId: string, actor: Actor): Promise<Task> {
  try {
    return await requireAuthor(db, taskId, actor);
  } catch (e) {
    if (!(e instanceof AppError) || e.code !== 'forbidden' || actor.kind !== 'user') throw e;
    const t = (await db.query('select * from tasks where id = $1', [taskId])).rows[0] as Task;
    const m = await db.query(
      `select role from memberships where org_id = current_setting('app.org_id')::uuid and user_id = $1 and status = 'active'`,
      [actor.userId]);
    if (!['owner', 'admin'].includes(m.rows[0]?.role)) throw e;
    return t;
  }
}

export interface TaskPatch {
  title?: string; description?: string; why?: string; doneCriteria?: string; dueDate?: string | null; rationale?: string;
  expectedResult?: TaskInput['expectedResult']; estimateMinutes?: number; priority?: 'normal' | 'urgent'; autoReleaseOk?: boolean;
  category?: 'do' | 'decide' | 'someday' | null;
}

export async function updateTask(db: Db, taskId: string, patch: TaskPatch, actor: Actor, now: Date = new Date()): Promise<Task> {
  // Срок без прочих полей от человека — одна дорога для всех (спека self-set-due): исполнитель,
  // автор, owner/admin ставят его через `setDueDate` — с событием `due_set` и сбросом «срок
  // предположен». Агент идёт старым путём: у него вето владельца на сдвиг дальше недели.
  const others = Object.entries(patch).filter(([k, v]) => k !== 'dueDate' && v !== undefined).map(([k]) => k);
  const assignee = actor.kind === 'user'
    && Boolean((await db.query('select 1 from tasks where id = $1 and assignee_user_id = $2', [taskId, actor.userId])).rowCount);
  if (actor.kind === 'user' && patch.dueDate && !others.length) {
    // Чужой человек получает тот же отказ, что и при любой правке, а не «не найдено» ядра срока.
    const before = assignee ? null : await requireAuthorOrManager(db, taskId, actor);
    const { task, changed } = await applyDueDate(db, { taskId, date: patch.dueDate, actor, source: 'mcp', now });
    // Владелец или админ сдвинул срок чужого дела — автор и исполнитель узнают, как при любой его правке.
    if (changed && before) await noteManagerChange(db, before, actor);
    return task;
  }
  let t: Task;
  try {
    t = await requireAuthorOrManager(db, taskId, actor);
  } catch (e) {
    // Исполнитель ставит срок своего дела — и только его: остальные поля по-прежнему у
    // автора и owner/admin.
    if (e instanceof AppError && e.code === 'forbidden' && assignee && patch.dueDate) {
      throw new AppError('forbidden', `The person doing the task sets only its due date — not ${others.join(', ')}`);
    }
    throw e;
  }
  if (['done', 'declined', 'cancelled', 'resolved'].includes(t.status)) throw new AppError('conflict', 'The task is closed');
  if (patch.priority === 'urgent' && t.priority !== 'urgent' && ['ready', 'draft'].includes(t.status) && actorAgentId(actor)) {
    // Срочность, вытесняющая «Сейчас», — только с согласия владельца (уровень 3).
    const holder = await db.query(`select 1 from tasks where assignee_user_id = $1 and id <> $2 and status in ('active','in_progress')`, [t.assignee_user_id, t.id]);
    if (holder.rowCount) {
      await createProposal(db, { agentId: actorAgentId(actor)!, planId: t.plan_id, taskId: t.id, type: 'preempt', summary: await proposalText(db, 'proposal.preempt', { title: t.title }) }, now);
      delete patch.priority;
    }
  }
  const cols: Record<string, unknown> = {
    title: patch.title, description: patch.description, why: patch.why, done_criteria: patch.doneCriteria, rationale: patch.rationale,
    expected_result: patch.expectedResult === undefined ? undefined : JSON.stringify(patch.expectedResult),
    estimate_minutes: patch.estimateMinutes, priority: patch.priority, auto_release_ok: patch.autoReleaseOk,
    category: patch.category,
  };
  const personal = (await orgKind(db)) === 'personal';
  if (patch.category !== undefined && patch.category !== null && !personal) throw new AppError('validation_failed', 'category — personal space only');
  // Контекст можно уточнить, но не вычистить: иначе шаг, уже прошедший проверку полноты, теряет смысл
  // по дороге к человеку — при отложенном выпуске между постановкой и сроком (спека task-context).
  if (!personal && t.requires_context) {
    for (const [field, value] of [['why', patch.why], ['done_criteria', patch.doneCriteria]] as const) {
      if (value !== undefined && !String(value ?? '').trim()) {
        throw new AppError('validation_failed', `${field} cannot be emptied — a person reads it to understand the step`);
      }
    }
    // Объяснение — на тех же правах: отказать при постановке и позволить стереть потом
    // значит не иметь правила вовсе. Проверяется по факту, а не по флагу: у дела, заведённого до
    // прежнего решения, объяснения нет — и требовать его задним числом не за что.
    if (patch.description !== undefined && String(patch.description ?? '').trim() === '' && t.description?.trim()) {
      throw new AppError('validation_failed', 'description cannot be emptied — it is how the person knows what to do');
    }
  }
  if (patch.dueDate === null) {
    // Снять срок можно только у личного дела: в организации шаг без срока не бывает.
    if (!personal) throw new AppError('validation_failed', 'A due date is required for an organization task');
    cols.due_date = null;
    cols.due_tz = null;
  } else if (patch.dueDate !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(patch.dueDate)) throw new AppError('validation_failed', 'due_date — format YYYY-MM-DD');
    const schedule = await loadUserSchedule(db, t.assignee_user_id);
    const base = t.due_date ?? localDate(now, schedule.tz);
    const shiftDays = (Date.parse(patch.dueDate) - Date.parse(base)) / 86400000;
    cols.due_date = patch.dueDate;
    cols.due_tz = schedule.tz;
    // Срок назвали явно — он больше не предположен разбором чата (спека self-set-due).
    cols.due_assumed = false;
    if (actorAgentId(actor) && shiftDays > 7) {
      await recordVetoable(db, {
        agentId: actorAgentId(actor)!, kind: 'reschedule', summary: `Срок перенесён дальше недели: ${t.title} → ${patch.dueDate}`,
        before: { task_id: t.id, status: t.status, due_date: base, activate_at: t.activate_at }, after: { due_date: patch.dueDate }, taskId: t.id,
      }, now);
    }
  }
  const entries = Object.entries(cols).filter(([, v]) => v !== undefined);
  if (entries.length) {
    const sets = entries.map(([k], i) => `${k} = $${i + 2}`);
    await db.query(
      `update tasks set ${sets.join(', ')}, updated_at = $${entries.length + 2}, version = version + 1 where id = $1`,
      [t.id, ...entries.map(([, v]) => v), now],
    );
    // Изменение текста сбрасывает кэш переводов: ключ кэша — хэш исходного текста, старые строки просто не совпадут.
    await emit(db, { type: 'task_updated', taskId: t.id, actorUserId: actorUserId(actor), actorAgentId: actorAgentId(actor), data: { fields: entries.map(([k]) => k) } });
    if (!['draft', 'scheduled'].includes(t.status)) {
      const { notify } = await import('./notify.js');
      await notify(db, { userId: t.assignee_user_id, kind: 'task_updated', level: 'work', taskId: t.id, dedupeKey: `upd:${t.id}:${t.version + 1}` });
    }
    await noteManagerChange(db, t, actor);
    // Правка текста — новый хэш в кэше переводов: готовим перевод заново (срок и приоритет текста не меняют).
    if (['title', 'description', 'why', 'done_criteria'].some((f) => entries.some(([k]) => k === f))) await enqueueTaskTranslation(db, t.id);
  }
  // Исполнитель, он же автор, назвал срок — это тоже ответ на просьбу владельца.
  if (cols.due_date && actor.kind === 'user' && actor.userId === t.assignee_user_id) await answerDueRequests(db, t.id, now);
  return (await db.query('select * from tasks where id = $1', [t.id])).rows[0] as Task;
}

/**
 * Дело изменилось не рукой его хозяина (спека roles-and-rights): владелец или админ распорядился
 * чужим делом. Право у него есть, но узнавать об этом случайно человек не должен — иначе он
 * приходит к сроку, которого не ставил, с формулировкой, которой не писал.
 */
export async function noteManagerChange(db: Db, t: Task, actor: Actor): Promise<void> {
  if (actor.kind !== 'user' || t.author_user_id === actor.userId) return;
  const { notify } = await import('./notify.js');
  for (const userId of new Set([t.author_user_id, t.assignee_user_id])) {
    if (userId === actor.userId) continue;
    await notify(db, {
      userId, kind: 'task_changed_by_manager', level: 'work', taskId: t.id,
      dedupeKey: `mgr:${t.id}:${t.version + 1}:${userId}`,
    });
  }
}

/**
 * Назначить, сменить или снять проверяющего (спека task-reviewer). Право — как у любой правки дела:
 * автор и owner/admin, но только человек: назвал агент проверяющего при постановке — снять его и
 * принять самому он не может. `null` снимает — приёмка возвращается автору. `intoProject` — проект,
 * куда дело переносят тем же вызовом: состав сверяется с ним, а не с тем, откуда дело уходит.
 */
export async function setReviewer(
  db: Db, taskId: string, reviewerUserId: string | null, actor: Actor, now: Date = new Date(), intoProject?: string,
): Promise<Task> {
  const t = await requireAuthorOrManager(db, taskId, actor);
  if (actorAgentId(actor)) throw new AppError('forbidden', "Changing the reviewer is a person's decision");
  if (['done', 'declined', 'cancelled', 'resolved'].includes(t.status)) throw new AppError('conflict', 'The task is closed');
  if (t.kind === 'waiting') throw new AppError('validation_failed', "A reviewer is for an action — a waiting has its own check_person");
  // Владелец или админ, назвавший проверяющим себя, обошёл бы правило «чужую работу принимает автор»:
  // роль даёт право распоряжаться делом, а не свидетельствовать о нём (спека roles-and-rights).
  const by = actorUserId(actor);
  if (reviewerUserId && reviewerUserId === by && by !== t.author_user_id) {
    throw new AppError('forbidden', "You can't name yourself the reviewer of a task someone else set");
  }
  const project = intoProject
    ? await resolveProject(db, intoProject, sessionUser(actor))
    : t.project_id
      ? ((await db.query('select * from projects where id = $1', [t.project_id])).rows[0] as ProjectRow | undefined) ?? null
      : null;
  const reviewer = await reviewerFor(db, reviewerUserId, {
    assigneeUserId: t.assignee_user_id, authorUserId: t.author_user_id, project,
    members: project ? await memberIds(db, project) : [],
  });
  if (reviewer === t.reviewer_user_id) return t;
  await db.query('update tasks set reviewer_user_id = $2, version = version + 1, updated_at = $3 where id = $1', [t.id, reviewer, now]);
  await emit(db, {
    type: 'task_updated', taskId: t.id, actorUserId: by, actorAgentId: actorAgentId(actor), data: { fields: ['reviewer_user_id'] },
    // Время передачи — часы вызывающего: от него таймер молчания проверяющего (worker/timers) считает новому сутки.
    at: now,
  });
  await noteManagerChange(db, t, actor);
  await handReviewOver(db, t, { from: t.reviewer_user_id, to: reviewer, by }, now);
  return (await db.query('select * from tasks where id = $1', [t.id])).rows[0] as Task;
}

/**
 * Сменился тот, кто принимает дело (спека task-reviewer). Прежнему проверяющему его недоставленное
 * «сдано» гасим — решать уже не ему (тем же способом гасит чужие уведомления перенос, core/routing).
 * Несданное — новому проверяющему строкой в ленту, чтобы назначение не было сюрпризом при сдаче.
 * Сданное — новому на приёмку, иначе оно повисает; без проверяющего — автору, и отсчёт автоприёмки
 * идёт с этой минуты: иначе ближайший тик принял бы дело, которого автор ещё не видел. Своё дело без
 * проверяющего принимать некому — оно закрывается, как по правилу «своё сдал — сделано».
 * `by` — кто делает изменение: себе не пишем.
 */
export async function handReviewOver(
  db: Db, t: Task, change: { from: string | null; to: string | null; by: string | null }, now: Date = new Date(),
): Promise<void> {
  const { notify } = await import('./notify.js');
  if (change.from) {
    await db.query(
      `update notifications set delivered_at = coalesce(delivered_at, $3)
        where task_id = $1 and user_id = $2 and kind = 'task_submitted' and delivered_at is null`,
      [t.id, change.from, now]);
  }
  if (t.status !== 'submitted') {
    if (change.to && change.to !== change.by) {
      await notify(db, { userId: change.to, kind: 'task_reviewer_assigned', level: 'feed', taskId: t.id });
    }
    return;
  }
  if (change.to) {
    if (change.to !== change.by) await notify(db, { userId: change.to, kind: 'task_submitted', level: 'work', taskId: t.id });
    return;
  }
  if (!t.author_agent_id && t.author_user_id === t.assignee_user_id) {
    await transition(db, t.id, 'accept', { kind: 'system' }, { now });
    return;
  }
  await db.query('update tasks set submitted_at = $2 where id = $1', [t.id, now]);
  if (!t.author_agent_id && t.author_user_id !== change.by) {
    await notify(db, { userId: t.author_user_id, kind: 'task_submitted', level: 'work', taskId: t.id });
  }
}

export async function cancelTask(db: Db, taskId: string, actor: Actor, reason: string | null, now: Date = new Date()): Promise<Task> {
  const t = await requireAuthorOrManager(db, taskId, actor);
  const updated = await transition(db, taskId, 'cancel', actor, { now, text: reason ?? undefined });
  await noteManagerChange(db, t, actor);
  if (actorAgentId(actor) && !['draft'].includes(t.status)) {
    await recordVetoable(db, {
      agentId: actorAgentId(actor)!, kind: 'cancel', summary: `Шаг отменён: ${t.title}`,
      before: { task_id: t.id, status: t.status === 'active' || t.status === 'in_progress' ? 'ready' : t.status, due_date: t.due_date, activate_at: t.activate_at },
      after: { status: 'cancelled' }, taskId: t.id,
    }, now);
  }
  return updated;
}

export async function reorderSteps(db: Db, planId: string, orderedTaskIds: string[], actor: Actor, now: Date = new Date()): Promise<void> {
  const agentId = actorAgentId(actor);
  const plan = (await db.query('select agent_id from plans where id = $1', [planId])).rows[0];
  if (!plan) throw new AppError('not_found', 'Plan not found');
  if (agentId && plan.agent_id !== agentId) throw new AppError('forbidden', 'The plan belongs to another agent');
  const cur = await db.query('select id, position from tasks where plan_id = $1 and id = any($2::uuid[])', [planId, orderedTaskIds]);
  if (cur.rowCount !== orderedTaskIds.length) throw new AppError('validation_failed', 'All tasks must belong to the plan');
  const positions = cur.rows.map((r) => r.position as number).sort((a, b) => a - b);
  for (let i = 0; i < orderedTaskIds.length; i++) {
    await db.query('update tasks set position = $2, version = version + 1, updated_at = $3 where id = $1', [orderedTaskIds[i], positions[i], now]);
  }
  if (agentId) {
    await recordVetoable(db, { agentId, kind: 'reorder', summary: 'Порядок шагов плана изменён', before: { positions: cur.rows }, after: { order: orderedTaskIds } }, now);
  }
}

// ---------------------------------------------------------------- ожидания

/**
 * Кто распоряжается ожиданием (спека roles-and-rights): автор, тот, на ком оно висит и кто по нему
 * отчитывается, и владелец с админом. Проверяющий здесь не посторонний: именно ему приходит
 * напоминание «пора проверить», и кнопка «ничего не изменилось» двигает дату из его рук.
 */
async function requireWaitingKeeper(db: Db, taskId: string, actor: Actor): Promise<Task> {
  const t = (await db.query('select * from tasks where id = $1', [taskId])).rows[0] as Task | undefined;
  if (!t) throw new AppError('not_found', 'Task not found');
  if (actor.kind === 'system') return t;
  const userId = actorUserId(actor);
  const checker = (t.waiting as { check_user_id?: string | null } | null)?.check_user_id ?? null;
  if (userId && (userId === t.assignee_user_id || userId === checker)) return t;
  return requireAuthorOrManager(db, taskId, actor);
}


export async function resolveWaiting(db: Db, taskId: string, actor: Actor, now: Date = new Date()): Promise<Task> {
  const t = await requireWaitingKeeper(db, taskId, actor);
  if (t.kind === 'waiting') return transition(db, taskId, 'resolve_waiting', actor, { now });
  return transition(db, taskId, 'external_back', actor, { now });
}

/**
 * Превратить дело в ожидание: «жду другого — проверить тогда-то». Так разбирается список, где строка
 * оказалась не действием, а ожиданием чужого хода (раньше — `personal_update(waiting_for)`).
 * Права те же, что у правки дела: распоряжается им автор, владелец или админ.
 */
export async function turnIntoWaiting(
  db: Db, taskId: string, actor: Actor,
  input: { waitingFor: string; expectedAt?: string | null; nextCheckAt?: string | null }, now: Date = new Date(),
): Promise<Task> {
  const t = await requireAuthorOrManager(db, taskId, actor);
  // Ожиданием становится дело, до которого ещё не дошли руки: взятое в работу сначала отпускают,
  // закрытое не меняют вовсе. Проверяющий результата у ожидания не живёт (спека task-reviewer):
  // принимать там нечего — снимаем.
  if (!['ready', 'scheduled'].includes(t.status)) throw new AppError('conflict', 'The task is already closed or waiting');
  const expected = input.expectedAt ? new Date(input.expectedAt) : null;
  const next = input.nextCheckAt ? new Date(input.nextCheckAt) : new Date(now.getTime() + 2 * 86400000);
  const waiting: WaitingInfo = {
    waiting_for: input.waitingFor, expected_at: expected?.toISOString() ?? null, next_check_at: next.toISOString(),
    check_user_id: t.assignee_user_id, on_arrival: null, contact: null, checks_done: 0,
  };
  await db.query(
    `update tasks set kind = 'waiting', status = 'waiting', waiting = $2, due_date = null, due_tz = null, reviewer_user_id = null,
       version = version + 1, updated_at = $3, status_changed_at = $3 where id = $1`,
    [taskId, JSON.stringify(waiting), now],
  );
  await emit(db, {
    type: 'task_updated', taskId, actorUserId: actorUserId(actor), actorAgentId: actorAgentId(actor), data: { fields: ['waiting'] },
  });
  return (await db.query('select * from tasks where id = $1', [taskId])).rows[0] as Task;
}

export async function setCheckDate(db: Db, taskId: string, at: Date, actor: Actor, now: Date = new Date()): Promise<Task> {
  await requireWaitingKeeper(db, taskId, actor);
  const t = (await db.query('select * from tasks where id = $1 for update', [taskId])).rows[0] as Task | undefined;
  if (!t || !t.waiting) throw new AppError('not_found', 'Waiting not found');
  const w = { ...t.waiting, next_check_at: at.toISOString() };
  await db.query('update tasks set waiting = $2, version = version + 1, updated_at = $3 where id = $1', [taskId, JSON.stringify(w), now]);
  await emit(db, { type: 'check_moved', taskId, actorUserId: actorUserId(actor), actorAgentId: actorAgentId(actor), data: { next_check_at: w.next_check_at } });
  return (await db.query('select * from tasks where id = $1', [taskId])).rows[0] as Task;
}

/** Следующая автоматическая проверка ожидания после «Без изменений». */
export function nextCheckAfter(now: Date, expectedAt: Date | null): Date {
  if (!expectedAt) return new Date(now.getTime() + 7 * 86400000);
  const left = expectedAt.getTime() - now.getTime();
  if (left > 7 * 86400000) return new Date(expectedAt.getTime() - 7 * 86400000);
  if (left > 3 * 86400000) return new Date(expectedAt.getTime() - 3 * 86400000);
  if (left > 1 * 86400000) return new Date(expectedAt.getTime() - 1 * 86400000);
  return new Date(now.getTime() + 86400000);
}

export async function noChangeWaiting(db: Db, taskId: string, actor: Actor, now: Date = new Date()): Promise<Task> {
  const t = (await db.query('select * from tasks where id = $1', [taskId])).rows[0] as Task | undefined;
  if (!t?.waiting) throw new AppError('not_found', 'Waiting not found');
  const expected = t.waiting.expected_at ? new Date(t.waiting.expected_at) : null;
  return setCheckDate(db, taskId, nextCheckAfter(now, expected), actor, now);
}

export async function logDecision(db: Db, planId: string, agentId: string, decision: string, rejected: string | null, triggerEventId?: string | null): Promise<void> {
  await db.query(
    `insert into plan_decisions(org_id, plan_id, agent_id, decision, rejected_options, trigger_event_id)
     values (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5)`,
    [planId, agentId, decision, rejected, triggerEventId ?? null],
  );
}

export async function activateScheduled(db: Db, now: Date = new Date()): Promise<number> {
  const r = await db.query(`select id, assignee_user_id from tasks where status = 'scheduled' and activate_at <= $1`, [now]);
  for (const row of r.rows) {
    const schedule = await loadUserSchedule(db, row.assignee_user_id);
    if (nextWorkingStart(schedule, now).getTime() !== now.getTime()) continue;   // выходной — подождать рабочего времени
    try {
      await transition(db, row.id, 'schedule_activate', { kind: 'system' }, { now });
    } catch (e) {
      // Одна задача не выпускается (например, у неё вычистили контекст) — остальные всё равно выходят
      // к людям, как и весь остальной тик организации. Задача остаётся в scheduled до следующего раза.
      if (!(e instanceof AppError)) throw e;
      logger.warn({ task: row.id, code: e.code, msg: 'scheduled task not released' });
    }
  }
  return r.rowCount ?? 0;
}
