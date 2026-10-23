import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../../db/pool.js';
import { AppError } from '../../core/errors.js';
import {
  createPlan, createTask, cancelTask, releaseStep, requireAuthor, requireReviewer, setCheckDate, setReviewer, turnIntoWaiting, updateTask, logDecision,
} from '../../core/tasks.js';
import { answerQuestion, canTransition, hasOpenQuestion, transition } from '../../core/lifecycle.js';
import { requestDue } from '../../core/due.js';
import { actingUserId, actorHasRole } from '../../core/access.js';
import { addSource, type SourceKind } from '../../core/sources.js';
import { addHumanComment } from '../../core/comments.js';
import { createProposal, proposalText } from '../../core/proposals.js';
import { emit } from '../../core/events.js';
import { notify } from '../../core/notify.js';
import { withIdempotency } from '../../core/idempotency.js';
import { isPersonalPlace } from '../../core/personal-place.js';
import { loadUserSchedule, zonedToUtc } from '../../core/calendar.js';
import { setTaskShare } from '../../core/sharing.js';
import { resolvePersonRef } from '../../core/people.js';
import { ownBoardId, resolveProject, setTaskProject, taskKey } from '../../core/projects.js';
import { taskLink } from '../../runtime/attention.js';
import { dialogTaskLine, parseDialogOrigin } from '../../groups/dialog-tasks.js';
import type { Actor, Task } from '../../core/types.js';
import { actorAgentId, actorUserId } from '../../core/types.js';
import { type CallerCtx, inToolCtx, involvedSql, involvementFilter, proposalForAgent, resolveOrg, taskForViewer, runTool, untrusted, withDryRun } from '../context.js';
import { taskDossier } from '../dossier.js';
import { ORG, AGENT } from './orientation.js';
import { myTask } from './worker.js';

// Группа «Планы и задачи» — основной набор инструментов постановщика (спека mcp-and-oauth).

// Чужое дело человек называет его id — ключ и слово ищутся только среди своих (comment_task).
const UUID_RE = /^[0-9a-f-]{36}$/i;

// Связи шага — формат, который понимает карточка бота (src/bot/cards.ts linkLines).
const LINK = z.union([
  z.object({ type: z.literal('previous_result'), text: z.string().min(1), task_id: z.string().optional() }),
  z.object({ type: z.literal('url').optional(), url: z.string().url(), title: z.string().optional() }),
]).describe('previous_result {text} — what came out of the previous step; url {url, title} — a link');
const EXTERNAL = z.object({ system: z.string().optional(), id: z.string().optional(), url: z.string().url().optional() })
  .describe('Where the task lives outside (Linear, CRM): system, id, url');

const EXPECTED_RESULT = z.object({ type: z.enum(['text', 'number', 'file', 'photo']), required: z.boolean() });
const PRIORITY = z.enum(['normal', 'urgent']).describe('In the personal space urgent means "important" (the star).');
const CATEGORY = z.enum(['do', 'decide', 'someday']).describe(
  'For the personal space only: do — to do, decide — to decide (a choice, a fork), someday — postponed/on ice. '
  + "Waiting for others is not a category — it is kind: 'waiting'.");
// Пометка «рабочее» (спека owner-feedback): единственный мост из личного пространства к агентам.
const SHARE_WITH = z.string().nullable().optional().describe(
  'For a personal item: the name of your company — an item about the business. Mark it, and the agents will see '
  + 'when it is closed. null — remove the mark. Without the mark a personal item stays invisible to every agent.');
/** Ожидание внешнего события (слияние create_waiting): дело, в котором никто ничего не делает. */
const WAITING_FIELDS = {
  waiting_for: z.string().optional().describe("Who or what we are waiting for — goes with kind: 'waiting'"),
  expected_at: z.string().optional().describe('When it is expected (ISO) — the server counts the checks back from it'),
  next_check_at: z.string().optional().describe(
    'When to check it: an ISO time, or YYYY-MM-DD — then the start of that working day for the person. '
    + 'Neither date given — in two days'),
  check_person: z.string().optional().describe(
    'Who checks it. For a waiting — who checks whether it arrived, if not the person it is on. For an action — the reviewer: '
    + 'the handed-in result goes to them to accept or send back instead of the author, who then gets only the outcome. '
    + 'Not the person doing it'),
  on_arrival: z.string().optional().describe('What to do once it arrives'),
  contact: z.string().optional().describe('Whom to ask about it'),
};
const WAITING_KEYS = Object.keys(WAITING_FIELDS) as (keyof typeof WAITING_FIELDS)[];
/**
 * Откуда дело взялось (спека task-context). Требование владельца: «задачи должны
 * содержать контекст». Источник кладётся тем же вызовом, что и дело: отдельный шаг забывается, а
 * человек получает голое название и переспрашивает, из чего оно выросло.
 */
const SOURCE = z.object({
  kind: z.enum(['chat', 'group', 'external', 'task']).default('chat'),
  title: z.string().min(1).describe('How a person names this source: "the conversation on 21 September", "Linear EXT-142"'),
  quote: z.string().optional().describe('The words it grew out of — the person\'s own, not your retelling (≤ 500 characters)'),
  url: z.string().optional(),
  system: z.string().optional(),
  external_id: z.string().optional(),
});

const CREATE_TASK_FIELDS = {
  title: z.string().min(1),
  description: z.string().optional().describe(
    'How this is done — written for someone who did not read your conversation and may not know the company. '
    + 'Where to look, who to talk to, what has already been tried, what a good result looks like and what means it '
    + 'went wrong. Required for a task of an organization: the person will not ask you, and if they hand it to their '
    + 'own AI, it will not ask either — it will simply do it badly. No passwords or keys here: say where the access '
    + 'is kept, not what it is.'),
  why: z.string().optional(), done_criteria: z.string().optional(),
  assignee: z.string().min(1), due_date: z.string().optional(), expected_result: EXPECTED_RESULT.optional(),
  estimate_minutes: z.number().int().positive().optional(), priority: PRIORITY.optional(), rationale: z.string().optional(),
  origin: z.string().optional(), links: z.array(LINK).optional(), activate_at: z.string().optional(), external: EXTERNAL.optional(),
  category: CATEGORY.optional(),
  project: z.string().optional().describe(
    'The project this item belongs to (id or name); without it the item goes into the default project'),
  idempotency_key: z.string().min(1), dry_run: z.boolean().optional(),
  source: SOURCE.optional().describe(
    'Where this item came from. Required for an item of an organization: without it the person sees a bare title '
    + 'and has to ask what it grew out of. From a conversation — kind: "chat" with the quote it is based on.'),
};

/**
 * Когда проверять ожидание. Полное время — как назвали; одна дата — начало рабочего дня человека в
 * его поясе: «проверить в понедельник» значит утром понедельника, а не в полночь по Гринвичу.
 */
async function checkAt(db: Db, userId: string, at: string): Promise<Date> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(at)) {
    const parsed = new Date(at);
    if (Number.isNaN(parsed.getTime())) throw new AppError('validation_failed', `next_check_at — an ISO time or YYYY-MM-DD, not "${at}"`);
    return parsed;
  }
  const schedule = await loadUserSchedule(db, userId);
  const [y, m, d] = at.split('-').map(Number) as [number, number, number];
  const [hh, mm] = schedule.start.split(':').map(Number) as [number, number];
  return zonedToUtc(y, m, d, hh, mm, schedule.tz);
}

/** Компания, на которую ставится пометка «рабочее»: только своя (resolveOrg ищет среди действующих членств). */
async function shareOrgId(caller: CallerCtx, ref: string | null | undefined): Promise<string | null> {
  return ref == null ? null : resolveOrg(caller.userId, ref);
}

/** Источник дела из поля `source`: тот же путь, что у `add_source`, без отдельного вызова. */
async function attachSource(db: Db, taskId: string, src: z.infer<typeof SOURCE>, actor: Actor): Promise<void> {
  await addSource(db, {
    taskId, kind: src.kind as SourceKind, title: src.title, url: src.url ?? null,
    system: src.system ?? null, externalId: src.external_id ?? null, quote: src.quote ?? null, snapshot: null,
  }, actor);
}

// Возобновление плана раньше было нечем сделать: пауза ставилась, а обратно — никак, и снятый с
// паузы план приходилось заводить заново вместе со всеми шагами.
async function setPlanStatus(db: Db, planId: string, agentId: string, status: 'paused' | 'done' | 'active', actor: Actor): Promise<{ id: string; status: string }> {
  const r = await db.query('select agent_id from plans where id = $1', [planId]);
  if (!r.rowCount) throw new AppError('not_found', 'Plan not found');
  if (r.rows[0].agent_id !== agentId) throw new AppError('forbidden', 'The plan belongs to another agent');
  await db.query(`update plans set status = $2, closed_at = case when $2 = 'done' then now() else closed_at end where id = $1`, [planId, status]);
  const eventType = status === 'done' ? 'plan_done' : status === 'active' ? 'plan_resumed' : 'plan_paused';
  await emit(db, {
    type: eventType, planId, agentId,
    actorUserId: actorUserId(actor), actorAgentId: actorAgentId(actor),
  });
  return { id: planId, status };
}

/** Реплика агента к задаче: запись в ленту, статус не меняется. Человек сюда не попадает — его
 *  реплика идёт через `addHumanComment` (проверка причастности и суточный лимит), см. `comment_task`.
 *  Экспортируется — тесты проверяют им ответ агента на реплику человека. */
export async function addComment(db: Db, taskId: string, actor: Actor, text: string): Promise<Task> {
  const t = (await db.query('select * from tasks where id = $1', [taskId])).rows[0] as Task | undefined;
  if (!t) throw new AppError('not_found', 'Task not found');
  // Помеченное «рабочее» личное дело агент только читает (спека owner-feedback) — писать в него нельзя.
  if (t.shared_org_id && actorAgentId(actor)) {
    throw new AppError('forbidden', "A personal item of its owner — an agent only reads it in the briefing");
  }
  await db.query(
    `insert into task_messages(org_id, task_id, author_user_id, author_agent_id, kind, text)
     values (current_setting('app.org_id')::uuid, $1, $2, $3, 'comment', $4)`,
    [taskId, actor.kind === 'user' ? actor.userId : null, actorAgentId(actor), text],
  );
  await emit(db, { type: 'comment', taskId, actorUserId: actorUserId(actor), actorAgentId: actorAgentId(actor), data: { text } });
  const caller = actorUserId(actor);
  const target = caller === t.assignee_user_id ? t.author_user_id : t.assignee_user_id;
  if (target && target !== caller) await notify(db, { userId: target, kind: 'task_comment', level: 'work', taskId: t.id });
  return t;
}

export function registerTaskTools(server: McpServer, caller: CallerCtx): void {
  server.registerTool('create_plan', {
    description: "Create an agent's plan: a goal plus an empty list of steps, which are added to it one by one. "
      + 'A plan belongs to an agent — agent is required.',
    inputSchema: { org: ORG, agent: AGENT, goal: z.string().min(1) },
    annotations: { title: 'Create a plan', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'create_plan' }, async (ctx) => {
    if (!ctx.agent) throw new AppError('validation_failed', 'agent is required — a plan belongs to an agent');
    return createPlan(ctx.db, ctx.agent.id, args.goal, ctx.actor);
  })));

  // Одна ручка на изменение плана вместо четырёх (pause_plan, complete_plan, fail_plan и правка
  // цели): все они меняли одно и то же — состояние плана, — и три из них не звал никто, ни скилл,
  // ни спека, ни тест. Смысл действия задаётся полем, а не именем инструмента.
  server.registerTool('update_plan', {
    description: 'Change a plan: its goal, its status, or both. A new goal and status "failed" go to the '
      + "agent's owner as a proposal (the \"only with consent\" level) — the owner decides whether the "
      + 'direction changes or the plan is written off. "paused" and "done" apply immediately. '
      + 'Nothing passed — nothing happens.',
    inputSchema: {
      org: ORG, agent: AGENT, plan: z.string().min(1),
      goal: z.string().optional(),
      status: z.enum(['paused', 'active', 'done', 'failed']).optional(),
      /** Причина обязательна для «failed»: владелец читает её, решая, списывать ли план. */
      summary: z.string().optional(),
      rationale: z.string().optional(),
    },
    annotations: { title: 'Change a plan', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'update_plan' }, async (ctx) => {
    if (!ctx.agent) throw new AppError('validation_failed', 'agent is required');
    const results: unknown[] = [];
    if (args.status === 'failed') {
      if (!args.summary?.trim()) throw new AppError('validation_failed', 'summary is required to write a plan off: the owner reads it before deciding');
      results.push(await createProposal(ctx.db, {
        agentId: ctx.agent.id, planId: args.plan, type: 'plan_failed', summary: args.summary, rationale: args.rationale ?? null,
      }));
    } else if (args.status) {
      results.push(await setPlanStatus(ctx.db, args.plan, ctx.agent.id, args.status, ctx.actor));
    }
    if (args.goal?.trim()) {
      results.push(await createProposal(ctx.db, {
        agentId: ctx.agent.id, planId: args.plan, type: 'goal_change',
        summary: await proposalText(ctx.db, 'proposal.goal_change', { goal: args.goal }), payload: { goal: args.goal }, rationale: args.rationale ?? null,
      }));
    }
    return results.length === 1 ? results[0] : { ok: true, changes: results.length };
  })));

  server.registerTool('add_step', {
    description: 'Add a step to a plan. It lands in draft; `release: true` puts it into the queue right away. '
      + 'For a step of an organization description, why, done_criteria, due_date (for an action step) and source are required; '
      + 'in the personal space of a person title is enough. idempotency_key is required either way: the same key returns the '
      + 'step already created instead of a second one. `dry_run: true` — check and return the future object without writing it.',
    inputSchema: { org: ORG, agent: AGENT, plan: z.string().min(1), release: z.boolean().optional(), auto_release_ok: z.boolean().optional(), ...CREATE_TASK_FIELDS },
    annotations: { title: 'Add a step to a plan', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'add_step' }, (ctx) => {
    const actorKey = ctx.agent?.id ?? ctx.userId;
    return withDryRun(ctx.db, args.dry_run, () => withIdempotency(ctx.db, actorKey, args.idempotency_key, args, async () => {
      // Дело компании без источника не ставится: человек, получивший голое название,
      // переспрашивает, из чего оно выросло, — а к следующему запуску агента этого уже никто не
      // помнит. Личное пространство живёт по своим правилам: там дело пишет себе сам хозяин.
      // Проект может прийти именем — разрешаем его до проверки, иначе личная доска, названная
      // по имени, считалась бы рабочей и требовала источника.
      const assignee = await resolvePersonRef(ctx.db, args.assignee);
      const place = args.project ? await resolveProject(ctx.db, args.project, ctx.userId) : null;
      const personalSpace = await isPersonalPlace(ctx.db, {
        projectId: place?.id ?? null, assigneeUserId: assignee,
        authorUserId: ctx.agent ? null : ctx.userId, authorAgentId: ctx.agent?.id ?? null,
      });
      if (!personalSpace && !args.source) {
        throw new AppError('validation_failed',
          'source is required: where this item came from, with the quote it is based on', { missing: ['source'] });
      }
      const assigneeUserId = assignee;
      const step = await createTask(ctx.db, {
        planId: args.plan, project: args.project ?? null, title: args.title, description: args.description, why: args.why, doneCriteria: args.done_criteria,
        assigneeUserId, dueDate: args.due_date ?? null, activateAt: args.activate_at ?? null, expectedResult: args.expected_result ?? null,
        estimateMinutes: args.estimate_minutes ?? null, priority: args.priority, autoReleaseOk: args.auto_release_ok,
        release: args.release, rationale: args.rationale ?? null, origin: args.origin ?? null, links: args.links, external: args.external,
      }, ctx.actor);
      // Источник обязателен и у шага плана, но прикладывался только у разового дела: шаг требовал
      // `source`, молча его терял, и человек получал дело без ответа на вопрос «откуда это взялось»
      // (спека task-context).
      if (args.source) await attachSource(ctx.db, step.id, args.source, ctx.actor);
      return step;
    }));
  })));

  server.registerTool('release_step', {
    description: 'Release a step of a plan from draft into the queue (or to scheduled, if activate_at has not come yet). '
      + 'why and done_criteria must be filled in: the person who gets the step has not seen the conversation it came from.',
    inputSchema: { org: ORG, agent: AGENT, task: z.string().min(1) },
    annotations: { title: 'Release a step into the queue', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'release_step' }, (ctx) => releaseStep(ctx.db, args.task, ctx.actor).then((t) => taskForViewer(t, ctx.actor)))));

  server.registerTool('create_task', {
    description: 'A one-off task without a plan — from an agent or from a person. In an organization description, why, '
      + 'done_criteria, due_date and source are required; in the personal space (org: "personal") title is enough — the due '
      + 'date only if it is a real one (no deadline — no date), while category and priority (urgent = the star "important") '
      + 'sort the list, and share_with marks an item as being about the business of that company. '
      + "kind: 'waiting' records a waiting instead of an action: nobody does anything, we are waiting for waiting_for, and "
      + 'the server reminds you to check it at next_check_at. The source given here is attached to the task. '
      + 'idempotency_key is required: the same key returns the task already created instead of a second '
      + 'one. `dry_run: true` — check and return the future object without writing it.',
    inputSchema: {
      org: ORG.describe('Organization: id or name, or "personal" — the personal space of the person. Can be omitted if you have a single company'),
      agent: AGENT,
      kind: z.enum(['action', 'waiting']).optional().describe(
        "action (default) — somebody does something; waiting — we are waiting for an external event"),
      plan: z.string().optional().describe("The plan a waiting belongs to; an action step is added to a plan as a step, not here"),
      share_with: SHARE_WITH,
      ...WAITING_FIELDS,
      ...CREATE_TASK_FIELDS,
      // Личное дело человек записывает себе: спрашивать, на кого оно, там нечего.
      assignee: z.string().min(1).optional().describe('Who does it. In the personal space it is the person themselves'),
    },
    annotations: { title: 'Record a task or a waiting', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'create_task' }, (ctx) => {
    const actorKey = ctx.agent?.id ?? ctx.userId;
    const waitingKind = args.kind === 'waiting';
    return withDryRun(ctx.db, args.dry_run, () => withIdempotency(ctx.db, actorKey, args.idempotency_key, args, async () => {
      // Поля ожидания и действия не смешиваются: «жду бухгалтера» и «позвони бухгалтеру» — разные дела.
      // check_person у дела действия — проверяющий результата (спека task-reviewer), остальные поля — только ожиданию.
      if (!waitingKind && WAITING_KEYS.some((k) => k !== 'check_person' && args[k] !== undefined)) {
        throw new AppError('validation_failed', "waiting_for, expected_at, next_check_at, on_arrival and contact go with kind: 'waiting'");
      }
      if (waitingKind && !args.waiting_for?.trim()) {
        throw new AppError('validation_failed', "kind: 'waiting' needs waiting_for — who or what we are waiting for", { missing: ['waiting_for'] });
      }
      if (args.plan && !waitingKind) throw new AppError('validation_failed', 'plan — for a waiting; a step with an action is added by add_step');
      // Личное дело человек записывает себе: там спрашивать, на кого оно, нечего.
      if (!args.assignee && args.org !== 'personal') {
        throw new AppError('validation_failed', 'assignee is required — who does it', { missing: ['assignee'] });
      }
      // Дело компании без источника не ставится: человек, получивший голое название,
      // переспрашивает, из чего оно выросло, — а к следующему запуску агента этого уже никто не
      // помнит. Личное пространство живёт по своим правилам: там дело пишет себе сам хозяин.
      // Проект может прийти именем — разрешаем его до проверки, иначе личная доска, названная
      // по имени, считалась бы рабочей и требовала источника.
      const assignee = args.assignee ? await resolvePersonRef(ctx.db, args.assignee) : ctx.userId;
      // «Личное» — закрытая доска человека (спека projects-stage2): назвали пространство личным,
      // проект не назвали — дело ложится туда, иначе оно попало бы в общий проект компании.
      const project = args.project ?? (args.org === 'personal' ? await ownBoardId(ctx.db, ctx.userId) : null);
      const place = project ? await resolveProject(ctx.db, project, ctx.userId) : null;
      const personalSpace = await isPersonalPlace(ctx.db, {
        projectId: place?.id ?? null, assigneeUserId: assignee,
        authorUserId: ctx.agent ? null : ctx.userId, authorAgentId: ctx.agent?.id ?? null,
      });
      // Ожидание живёт без источника: в нём нечего делать, и основание у него одно — сам факт ожидания.
      if (!personalSpace && !args.source && !waitingKind) {
        throw new AppError('validation_failed',
          'source is required: where this item came from, with the quote it is based on', { missing: ['source'] });
      }
      // Без проекта дело молча ложилось на доску по умолчанию, хотя по смыслу оно доска склада или доставки:
      // где общих досок несколько, выбор за тем, кто ставит, — отказ с их перечнем, а не тихая общая.
      if (!place && !personalSpace) {
        const boards = (await ctx.db.query(
          `select name, key from projects where org_id = current_setting('app.org_id')::uuid
            and not private and status = 'active' order by created_at, id`)).rows as { name: string; key: string | null }[];
        if (boards.length > 1) {
          throw new AppError('validation_failed',
            `project is required: this organization has several boards — ${boards.map((b) => b.key ? `${b.name} (${b.key})` : b.name).join(', ')}`,
            { missing: ['project'], projects: boards.map((b) => b.name) });
        }
      }
      const assigneeUserId = assignee;
      // Задача агента из переписки группы (origin group:…) — тоже с правом вето владельца (спека group-intake).
      const fromGroup = ctx.agent ? parseDialogOrigin(args.origin) : null;
      const dialogVeto = fromGroup && ctx.agent
        ? { summary: await dialogTaskLine(ctx.db, 'group.task_created_line', ctx.agent.id, assigneeUserId, args.title, fromGroup.groupId) }
        : undefined;
      // Своё дело человек проверяет сам, в своём рабочем дне; срока у ожидания нет — есть дата проверки.
      const nextCheck = args.next_check_at ? (await checkAt(ctx.db, assigneeUserId, args.next_check_at)).toISOString() : null;
      const waiting = waitingKind
        ? {
          waitingFor: args.waiting_for!, expectedAt: args.expected_at ?? null,
          nextCheckAt: nextCheck ?? (personalSpace && !args.expected_at ? new Date(Date.now() + 2 * 86400000).toISOString() : null),
          checkUserId: args.check_person ? await resolvePersonRef(ctx.db, args.check_person) : null,
          onArrival: args.on_arrival ?? null, contact: args.contact ?? null,
        }
        : undefined;
      const task = await createTask(ctx.db, {
        planId: args.plan ?? null, project, kind: args.kind ?? 'action', waiting,
        title: args.title, description: args.description, why: args.why, doneCriteria: args.done_criteria, assigneeUserId,
        dueDate: waitingKind ? null : (args.due_date ?? null), activateAt: args.activate_at ?? null, expectedResult: args.expected_result ?? null,
        estimateMinutes: args.estimate_minutes ?? null, priority: args.priority, rationale: args.rationale ?? null,
        origin: args.origin ?? null, links: args.links, external: args.external,
        category: waitingKind ? null : (args.category ?? null), dialogVeto,
        reviewerUserId: !waitingKind && args.check_person ? await resolvePersonRef(ctx.db, args.check_person) : null,
      }, ctx.actor);
      // Источник ложится тем же вызовом: дело и то, из чего оно выросло, не расходятся во времени.
      if (args.source) await attachSource(ctx.db, task.id, args.source, ctx.actor);
      // Пометка «рабочее» ставится отдельно от полей дела: она про видимость, не про содержание.
      const saved = args.share_with !== undefined
        ? await setTaskShare(ctx.db, task.id, ctx.userId, await shareOrgId(caller, args.share_with))
        : task;
      // Человеку дело называют ключом доски, как в приложении, и ссылкой с этим же ключом.
      const key = await taskKeyOf(ctx.db, saved);
      return { ...saved, key, link: taskLink(saved.short_id, key) };
    }));
  })));

  server.registerTool('update_task', {
    description: 'Change a task. Its author — and the owner or an admin of the organization; the person doing it can set its '
      + 'due_date and nothing else. A closed task is not changed '
      + '(project is the exception: a finished item can still be filed into another project); '
      + 'why, done_criteria and description of a step of an organization can be refined, but not emptied. '
      + 'project moves the item into another project — its history goes with it. '
      + 'In the personal space (org: "personal") this is how an item is sorted out: category, priority (urgent = the star '
      + '"important"), due_date (null — remove it), share_with. waiting_for turns the item into a waiting ("waiting for the '
      + "accountant's reply — check on Monday\"); next_check_at on its own moves the date of the next check of a waiting. "
      + 'It changes only the record in Taskano: nobody outside is contacted — waiting_for is a note of who we wait for, not a message to them.',
    inputSchema: {
      org: ORG.describe('Organization: id or name, or "personal" — the personal space of the person. Can be omitted if you have a single company'),
      agent: AGENT, task: z.string().min(1), title: z.string().optional(), description: z.string().optional(),
      why: z.string().optional(), done_criteria: z.string().optional(), rationale: z.string().optional(),
      due_date: z.string().nullable().optional().describe('YYYY-MM-DD; null — remove the due date (personal space only)'),
      expected_result: EXPECTED_RESULT.optional(), estimate_minutes: z.number().int().positive().optional(),
      priority: PRIORITY.optional(), auto_release_ok: z.boolean().optional(), category: CATEGORY.nullable().optional(),
      waiting_for: z.string().optional().describe('Who or what we are waiting for — the task becomes a waiting'),
      expected_at: z.string().optional().describe('When the thing waited for is expected (ISO) — with waiting_for'),
      next_check_at: z.string().optional().describe(
        'When to check the waiting: an ISO time, or YYYY-MM-DD — then the start of that working day for the person'),
      share_with: SHARE_WITH,
      check_person: z.string().nullable().optional().describe(
        'The reviewer of an action: the handed-in result goes to them to accept or send back instead of the author. '
        + 'Not the person doing it. Empty string or null — remove the reviewer, and the author accepts again'),
      project: z.string().min(1).optional().describe(
        'Move the item into another project (id or name). The history of the item — events, sources, messages — goes with it, '
        + 'and it gets a new key in the new project (the old key keeps finding it). Into a closed project items are put by '
        + 'the people on it, and only their own.'),
    },
    annotations: { title: 'Change a task or sort it out', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'update_task' }, async (ctx) => {
    // Пометка «рабочее» ставится и снимается отдельно от остальных полей: она про видимость, не про содержание.
    let result: Task | null = args.share_with === undefined
      ? null
      : await setTaskShare(ctx.db, args.task, ctx.userId, await shareOrgId(caller, args.share_with));
    if (args.waiting_for !== undefined) {
      const at = args.next_check_at ? await checkAt(ctx.db, ctx.userId, args.next_check_at) : null;
      result = await turnIntoWaiting(ctx.db, args.task, ctx.actor, {
        waitingFor: args.waiting_for, expectedAt: args.expected_at ?? null, nextCheckAt: at?.toISOString() ?? null,
      });
    } else if (args.next_check_at !== undefined) {
      result = await setCheckDate(ctx.db, args.task, await checkAt(ctx.db, ctx.userId, args.next_check_at), ctx.actor);
    } else if (args.expected_at !== undefined) {
      throw new AppError('validation_failed', 'expected_at goes with waiting_for — it is what makes the task a waiting');
    }
    const patch = {
      title: args.title, description: args.description, why: args.why, doneCriteria: args.done_criteria, dueDate: args.due_date,
      rationale: args.rationale, expectedResult: args.expected_result, estimateMinutes: args.estimate_minutes,
      priority: args.priority, autoReleaseOk: args.auto_release_ok, category: args.category,
    };
    // Ничего, кроме пометки, ожидания и проекта, не назвали — второй правкой дело не трогаем.
    if (Object.values(patch).some((v) => v !== undefined)) result = await updateTask(ctx.db, args.task, patch, ctx.actor);
    else if (!result && args.project === undefined && args.check_person === undefined) result = await updateTask(ctx.db, args.task, patch, ctx.actor);
    // Проверяющий — до переноса, но сверяется с составом проекта, куда дело едет: перенос сам
    // проверяет проверяющего (setTaskProject), и прежний, которого в новом составе нет, валил бы его,
    // хотя этим же вызовом его меняют на того, кто там есть.
    if (args.check_person !== undefined) {
      const ref = args.check_person?.trim();
      result = await setReviewer(ctx.db, args.task, ref ? await resolvePersonRef(ctx.db, ref) : null, ctx.actor, new Date(), args.project);
    }
    // Проект — отдельная функция ядра (номер дела, права на закрытый проект), но для звавшего это
    // такое же поле дела, как срок (слияние `set_task_project`, спека connector-surface). Идёт
    // последним: у закрытого дела остальные поля не меняются, и отказ приходит до переноса, а не
    // после него. Состояние и так цело — вызов идёт одной транзакцией, — но делать переезд, который
    // тут же откатится, незачем (ревью слияний).
    if (args.project !== undefined) result = await setTaskProject(ctx.db, args.task, args.project, ctx.actor);
    return taskForViewer(result!, ctx.actor);
  })));

  // Просьба назвать срок (спека self-set-due): срок, названный самим человеком, — его
  // обязательство, и владелец хочет видеть, кто когда попросил и кто когда ответил.
  server.registerTool('request_due', {
    description: 'Ask the person doing a task to name its due date themselves. The request is recorded on the task and reaches '
      + 'the person in Telegram with a button to the date picker; any due date they set afterwards answers it. No answer '
      + 'within 1 working day of theirs — one reminder to them; within 2 — one message to whoever asked (for an agent: the '
      + 'due_request_ignored event and a message to its owner). An open request already on the task is returned as it is. '
      + 'The author of the task, the agent leading it, or the owner or an admin; not for a personal item.',
    inputSchema: {
      org: ORG, agent: AGENT, task: z.string().min(1),
      text: z.string().max(2000).optional().describe('Why the date is needed — the person reads it with the request'),
      idempotency_key: z.string().min(1),
    },
    annotations: { title: 'Ask for a due date', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'request_due' }, (ctx) => {
    const actorKey = ctx.agent?.id ?? ctx.userId;
    return withIdempotency(ctx.db, actorKey, args.idempotency_key, args, async () => {
      const r = await requestDue(ctx.db, { taskId: args.task, actor: ctx.actor, text: args.text ?? null });
      return { request: r.id, task: r.task_id, requested_at: r.requested_at, answered_at: r.answered_at, created: r.created };
    });
  })));

  server.registerTool('cancel_task', {
    description: 'Cancel a task. Its author — and the owner or an admin of the organization. From an agent it comes with a veto (the owner can undo it within 24 h); '
      + 'a task set by a person is not cancelled by an agent: the agent proposes closing it to the owner instead.',
    inputSchema: { org: ORG, agent: AGENT, task: z.string().min(1), reason: z.string().optional() },
    annotations: { title: 'Cancel a task', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'cancel_task' }, (ctx) => cancelTask(ctx.db, args.task, ctx.actor, args.reason ?? null).then((t) => taskForViewer(t, ctx.actor)))));

  server.registerTool('adopt_task', {
    description: 'Take a task that a person set (it has no agent author) under your lead: you become its author and can then '
      + 'update it and lead it as your own. Only for an open task of your organization with no agent author, set by the '
      + "agent's owner — or any such task if the agent's owner is the owner or an admin; a personal item of its owner cannot be adopted.",
    inputSchema: { org: ORG, agent: AGENT, task: z.string().min(1) },
    annotations: { title: 'Take a task under your lead', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'adopt_task' }, async (ctx) => {
    if (!ctx.agent) throw new AppError('forbidden', 'Only an agent can adopt a task');
    const t = (await ctx.db.query('select * from tasks where id = $1 for update', [args.task])).rows[0] as Task | undefined;
    if (!t) throw new AppError('not_found', 'Task not found');
    if (t.shared_org_id) throw new AppError('forbidden', "A personal item of its owner — an agent only reads it in the briefing");
    if (t.author_agent_id) throw new AppError('conflict', 'The task already has an agent author');
    if (['done', 'cancelled', 'resolved'].includes(t.status)) throw new AppError('conflict', 'The task is already closed');
    // Усыновление делает агента автором: он принимает работу, отменяет, переписывает. Поэтому агент
    // берёт только то, что его хозяин поставил сам, — или любое дело, если хозяин агента — владелец
    // или админ. Иначе агент рядового забирал бы дела начальника и распоряжался ими.
    const agentOwner = await actingUserId(ctx.db, ctx.actor);
    if (t.author_user_id !== agentOwner && !(await actorHasRole(ctx.db, ctx.actor, ['owner', 'admin']))) {
      throw new AppError('forbidden', "An agent adopts only a task its owner set, or any task if its owner is the owner or an admin of the organization");
    }
    const r = await ctx.db.query(
      'update tasks set author_agent_id = $2, version = version + 1, updated_at = now() where id = $1 returning *',
      [args.task, ctx.agent.id]);
    await emit(ctx.db, { type: 'task_updated', taskId: args.task, actorAgentId: ctx.agent.id, data: { fields: ['author_agent_id'] } });
    return taskForViewer(r.rows[0], ctx.actor);
  })));

  server.registerTool('get_task', {
    description: 'The dossier of a task in one piece: fields (why, done_criteria, expected_result, rationale), sources it came from '
      + '(with the snapshot of the external system and its age in days), attachments (photos from work groups and photos people attached, with source and author), '
      + 'decisions, messages, results, related (the plan, the neighbouring steps, the tasks it grew out of) and history '
      + '(status changes and due-date moves with the reason). '
      + "People's text is marked untrusted.",
    inputSchema: { org: ORG, agent: AGENT, task: z.string().min(1) },
    annotations: { title: 'The dossier of a task', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: false, tool: 'get_task' }, async (ctx) => {
    // Участник и гость — только причастное дело; чужое — «нет такого», как в боте.
    if (!/^[0-9a-f-]{36}$/i.test(args.task)) throw new AppError('validation_failed', 'task — the id or the key of a task (NOR-012)');
    const only = await involvementFilter(ctx);
    if (only) {
      const mine = await ctx.db.query(`select 1 from tasks t where t.id = $1 and ${involvedSql('t', '$2', '$3')}`, [args.task, only.userId, only.agentId]);
      if (!mine.rowCount) throw new AppError('not_found', 'Task not found');
    }
    return taskDossier(ctx.db, args.task, ctx.actor);
  })));

  server.registerTool('review_result', {
    description: 'Judge the work that was handed in: verdict "accept" (the default) closes the task — submitted → done; '
      + '"rework" sends it back with text saying what to fix — submitted → rework. '
      + 'Before judging, look at every photo of the task yourself: a screenshot is often the result itself. '
      + 'A task that is done but was never handed in is closed with verdict "accept" and evidence — what shows it is done; '
      + 'the person doing it is told, with the evidence. Only a person closes it this way, never an agent on its own: '
      + 'propose it to the author and close it on their yes. '
      + 'Only the author — not the owner of the company: nobody judges a person\'s work for them. '
      + 'A task with a reviewer (check_person) is judged by the reviewer only — not by the author and not by an agent.',
    inputSchema: {
      org: ORG, agent: AGENT, task: z.string().min(1),
      verdict: z.enum(['accept', 'rework']).optional().describe('accept (default) — the work is done; rework — it comes back'),
      text: z.string().optional().describe('What is wrong and what to fix — for verdict "rework"'),
      evidence: z.string().optional().describe('For a task not handed in: what shows the work is done (a fact anyone can check) — closes it as done'),
    },
    annotations: { title: 'Accept the result or send it back', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'review_result' }, async (ctx) => {
    // С проверяющим судит только он (спека task-reviewer); агенту — подсказка, кому это отдать.
    const cur = await requireReviewer(ctx.db, args.task, ctx.actor).catch(async (e: unknown) => {
      if (!(e instanceof AppError) || e.code !== 'forbidden' || !ctx.agent) throw e;
      const t = (await ctx.db.query('select reviewer_user_id from tasks where id = $1', [args.task])).rows[0];
      if (t?.reviewer_user_id) throw new AppError('forbidden', 'This task is accepted by the reviewer — tell the reviewer it is waiting for them');
      throw e;
    });
    // Доказательство — только для несданного: у сданного оно бы молча пропало, а вызвавший решил бы,
    // что исполнитель его увидел.
    if (args.evidence !== undefined && (cur.status === 'submitted' || args.verdict === 'rework')) {
      throw new AppError('validation_failed', 'evidence is for a task that was not handed in — a handed-in result is accepted as it is, or sent back with text');
    }
    if (args.verdict === 'rework') return taskForViewer(await transition(ctx.db, args.task, 'rework', ctx.actor, { text: args.text }), ctx.actor);
    if (args.text !== undefined) throw new AppError('validation_failed', 'text is what comes back with verdict "rework" — an accepted result needs no note');
    // Не сдано, но сделано: закрывает человек — с доказательством, не агент сам.
    if (canTransition(cur.status, 'close')) {
      if (ctx.agent) throw new AppError('forbidden', 'A task not handed in is closed by a person: propose it to the author with the evidence, and they close it');
      if (!args.evidence?.trim()) throw new AppError('validation_failed', 'The task was not handed in — pass evidence: what shows the work is done');
      return taskForViewer(await transition(ctx.db, args.task, 'close', ctx.actor, { text: args.evidence }), ctx.actor);
    }
    return taskForViewer(await transition(ctx.db, args.task, 'accept', ctx.actor), ctx.actor);
  })));

  server.registerTool('answer_question', {
    description: 'Answer a question or an "Unclear" on a task. If the task is blocked right now, the answer lifts the block; '
      + 'a question asked on a task still in the queue is answered without changing its status; '
      + 'with no open question the text is recorded as a comment. '
      + 'Only the author of the task answers; from an agent — only on the tasks of that agent.',
    inputSchema: { org: ORG, agent: AGENT, task: z.string().min(1), text: z.string().min(1) },
    annotations: { title: 'Answer a question on a task', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'answer_question' }, async (ctx) => {
    // Отвечает тот, кому задан вопрос: автор дела, а от имени агента — только по делам этого агента.
    // Раньше ответить мог любой участник, и гость снимал блок с чужого дела своим «ответом».
    const cur = await requireAuthor(ctx.db, args.task, ctx.actor);
    // Вопрос по делу из очереди статуса не меняет — и ответ на него тоже, но закрыть его обязан:
    // иначе он висит без ответа и уходит в эскалацию (спека step-lifecycle-and-queue, «Таймеры»).
    if (cur.status === 'blocked' || await hasOpenQuestion(ctx.db, args.task)) {
      return taskForViewer(await answerQuestion(ctx.db, args.task, ctx.actor, args.text), ctx.actor);
    }
    // Вопроса нет — это реплика, и у человека она идёт тем же путём, что `comment_task`: причастность,
    // длина и суточный лимит одни на все каналы.
    if (!ctx.agent) return taskForViewer((await addHumanComment(ctx.db, cur.id, ctx.userId, args.text)).task, ctx.actor);
    return taskForViewer(await addComment(ctx.db, args.task, ctx.actor, args.text), ctx.actor);
  })));

  server.registerTool('comment_task', {
    description: 'Say something on a task without stopping it: a note on a task you are doing (what you found, what changed) '
      + 'or a comment on a task you set or lead. It goes into the feed, the other side — the author or the person doing it — is '
      + 'notified, and the status does not change. A person writes only on a task they are part of — doing it, its author, '
      + 'checking it, or the owner of the organization. A personal item of its owner an agent only reads.',
    inputSchema: {
      org: ORG, agent: AGENT,
      task: z.string().min(1).describe('The task: its id, or — among your own tasks — its key (NOR-001) or a word from its title'),
      text: z.string().min(1),
    },
    annotations: { title: 'Leave a note on a task', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'comment_task' }, async (ctx) => {
    // Человек пишет тем же путём, что из бота и приложения (проверка отношения к делу, лимиты на
    // сутки и длину, указание владельца агенту): второй копии правил у человека быть не должно.
    // Раньше путь выбирался по тому, нашлось ли дело среди своих, и чужое уходило в ветку агента —
    // без лимита и без проверки, кто пишет (ревью слияний, HIGH).
    if (!ctx.agent) {
      const mine = await myTask(ctx.db, args.task, ctx.userId).catch(() => null);
      // Ключ и слово ищутся только среди своих дел: чужое дело человек называет его id.
      if (!mine && !UUID_RE.test(args.task.trim())) throw new AppError('not_found', `"${args.task}" is not among your tasks`);
      const taskId = mine?.id ?? args.task.trim();
      const added = await addHumanComment(ctx.db, taskId, ctx.userId, args.text);
      return { ok: true, task: taskId, status: added.task.status, text: untrusted(args.text) };
    }
    const t = await addComment(ctx.db, args.task, ctx.actor, args.text);
    return { ok: true, task: t.id, status: t.status, text: untrusted(args.text) };
  })));

  server.registerTool('propose_change', {
    description: 'Propose a change to the owner of the agent (the "only with consent" level). From an agent only.',
    inputSchema: {
      org: ORG, agent: AGENT,
      type: z.enum(['goal_change', 'preempt', 'plan_failed', 'step_limit', 'money', 'promise', 'new_direction', 'close_task', 'other'])
        .describe('close_task — close a task set by a person (task is required); the owner accepting the proposal cancels that task'),
      summary: z.string().min(1), payload: z.record(z.string(), z.unknown()).optional(),
      plan: z.string().optional(), task: z.string().optional(), rationale: z.string().optional(),
    },
    annotations: { title: 'Propose a change to the owner', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'propose_change' }, async (ctx) => {
    if (!ctx.agent) throw new AppError('forbidden', 'Only an agent can create a proposal');
    if (args.type === 'close_task') {
      const t = args.task && /^[0-9a-f-]{36}$/i.test(args.task)
        ? (await ctx.db.query('select author_agent_id, shared_org_id from tasks where id = $1', [args.task])).rows[0] : undefined;
      if (!t) throw new AppError('validation_failed', 'close_task — task is required: the task proposed for closing');
      // Помеченное «рабочее» личное дело закрывает только его владелец (спека owner-feedback).
      if (t.shared_org_id) throw new AppError('forbidden', "A personal item of its owner — an agent only reads it in the briefing");
      // Предложение закрыть — только для задачи, поставленной человеком; задачу агента закрывает её агент (cancel_task).
      if (t.author_agent_id) throw new AppError('validation_failed', 'close_task — only for a task set by a human; an agent cancels its own task itself (cancel_task)');
    }
    return createProposal(ctx.db, {
      agentId: ctx.agent.id, planId: args.plan ?? null, taskId: args.task ?? null, type: args.type,
      summary: args.summary, payload: args.payload, rationale: args.rationale ?? null,
    });
  })));

  server.registerTool('list_proposals', {
    description: 'A list of proposals with filters by status and by plan. From an agent — only its own proposals.',
    inputSchema: {
      org: ORG, agent: AGENT, status: z.enum(['pending', 'accepted', 'rejected', 'expired', 'changed']).optional(), plan: z.string().optional(),
    },
    annotations: { title: 'List proposals', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: false, tool: 'list_proposals' }, async (ctx) => {
    // Без агента — предложения всей организации: это пульт владельца и админа (ревью 07.10).
    if (!ctx.agent && !(await actorHasRole(ctx.db, ctx.actor, ['owner', 'admin']))) {
      throw new AppError('forbidden', 'Only an owner or admin sees the proposals of the whole organization');
    }
    const where: string[] = [];
    const params: unknown[] = [];
    if (ctx.agent) { params.push(ctx.agent.id); where.push(`agent_id = $${params.length}`); }
    if (args.status) { params.push(args.status); where.push(`status = $${params.length}`); }
    if (args.plan) { params.push(args.plan); where.push(`plan_id = $${params.length}`); }
    const sql = `select id, short_id, agent_id, plan_id, task_id, type, summary, status, expires_at, created_at
      from proposals ${where.length ? `where ${where.join(' and ')}` : ''} order by created_at desc limit 200`;
    return { proposals: (await ctx.db.query(sql, params)).rows.map(proposalForAgent) };
  })));

  server.registerTool('log_decision', {
    description: "Record a decision of a plan in the log (the system's memory beats a person's memory). Only an agent writes there.",
    inputSchema: {
      org: ORG, agent: AGENT, plan: z.string().min(1), decision: z.string().min(1),
      rejected_options: z.string().optional(), trigger_event_id: z.string().optional(),
    },
    annotations: { title: 'Record a decision of a plan', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'log_decision' }, async (ctx) => {
    if (!ctx.agent) throw new AppError('forbidden', 'The decision log is kept by an agent');
    await logDecision(ctx.db, args.plan, ctx.agent.id, args.decision, args.rejected_options ?? null, args.trigger_event_id ?? null);
    return { ok: true };
  })));
}

/** Ключ доски дела («NOR-033»); у дела без проекта или номера ключа нет. */
async function taskKeyOf(db: Db, task: Pick<Task, 'project_id' | 'number'>): Promise<string | null> {
  if (!task.project_id) return null;
  const r = await db.query(`select key from projects where id = $1`, [task.project_id]);
  return taskKey(r.rows[0]?.key as string | undefined, task.number);
}
