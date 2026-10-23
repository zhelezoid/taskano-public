import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withGlobal } from '../../db/pool.js';
import { resolvePersonRef, userOrgs } from '../../core/people.js';
import { ownBoardId, resolveProject, taskKey } from '../../core/projects.js';
import { OPEN_STATUSES } from '../../core/types.js';
import { AppError } from '../../core/errors.js';
import { actorHasRole } from '../../core/access.js';
import { presenceView, viewerTimezone } from '../../core/presence.js';
import { env } from '../../config/env.js';
import { CURRENT_SKILL_VERSION, MIN_SKILL_VERSION, SKILL_REPO } from '../../config/product.js';
import type { Actor } from '../../core/types.js';
import { type CallerCtx, inToolCtx, involvedSql, involvementFilter, resolveOrg, runTool, snapshotForAgent, taskForViewer, untrusted } from '../context.js';

// Эталон группы инструментов: схема zod, description для модели, inToolCtx, runTool.
export const ORG = z.string().optional().describe('Organization: id or name. Can be omitted if you have a single company');
export const AGENT = z.string().optional().describe('Agent (id or name) on whose behalf the action is taken. Omit it when a person acts');

/** Что значат отметки «когда заходил» — общий текст для описаний инструментов (спека person-presence). */
export const SEEN_MARKS = 'last_seen_bot and last_seen_app — when the person was last seen, in words (within the last hour, today, yesterday, N days ago) in the time zone of the caller, with the day in last_seen_bot_on and last_seen_app_on; null means not since seen_tracked_since, the date these marks started being recorded. The bot mark is set only when the person writes to the bot or presses a button — Telegram does not tell the bot that a chat was opened or read; the app mark is set on every opening of the app.';

// Версии и адрес skill живут в config/product.ts: их же берёт ядро для приветственного письма,
// а ядру нельзя тянуть за собой слой MCP — импорты замкнулись бы в кольцо.
export { CURRENT_SKILL_VERSION, MIN_SKILL_VERSION, SKILL_REPO } from '../../config/product.js';

/** Обозначение дела внутри проекта: «NOR-12», «nor-012» (спека projects-stage2). */
const BOARD_KEY_RE = /^([A-Za-z][A-Za-z0-9]{1,4})-(\d{1,6})$/;

// Границы поиска дела по словам (спека task-in-conversation): сколько отдаём, сколько слов читаем.
const FIND_TASK_LIMIT = 20;
const FIND_TASK_MAX = 200;
const FIND_TASK_WORDS = 8;
const UUID_RE = /^[0-9a-f-]{36}$/i;

/** Поля дела в выдаче поиска: то же, что раньше отдавал отдельный список дел. */
const TASK_COLUMNS = `t.id, t.short_id, t.plan_id, t.project_id, t.kind, t.title, t.status, t.priority, t.due_date,
  t.assignee_user_id, t.author_agent_id, t.author_user_id, t.origin, t.created_at, p.key as project_key, t.number,
  (select json_build_object('requested_at', m.created_at, 'answered_at', m.answered_at) from task_messages m
    where m.task_id = t.id and m.kind = 'due_request' order by m.created_at desc, m.id desc limit 1) as due_request`;

interface OrgRow { id: string; name: string; kind: string }

/**
 * Строка выдачи поиска для агента: текст дела, написанный не тем, кто ищет, и текст из рабочего чата —
 * под untrusted, а найденное по объекту внешней системы несёт свой источник со слепком (иначе агент
 * шёл бы за ним вторым вызовом).
 */
function forAgent(row: Record<string, unknown>, viewer: Actor): Record<string, unknown> {
  const { source_id: id, source_url: url, source_title: title, source_snapshot: snapshot, source_captured_at: capturedAt,
    project_key: projectKey, number, ...task } = row;
  // Номер дела, который видят люди («NOR-004»). Без него агент называл дело внутренним short_id
  // («NOR-164»), которого нет ни в боте, ни в приложении (30.09).
  const out = { key: taskKey(projectKey as string | null, number as number | null), ...taskForViewer(task, viewer) };
  if (!id) return out;
  return { ...out, source: { id, url, title: untrusted(title as string | null), snapshot: snapshotForAgent(snapshot), captured_at: capturedAt } };
}

export function registerOrientationTools(server: McpServer, caller: CallerCtx): void {
  server.registerTool('whoami', {
    description: 'Who am I: the person (name, language, time zone, email), their organizations and roles — '
      + 'including a company whose invitation has not been accepted yet.',
    inputSchema: {},
    annotations: { title: 'Who am I', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, () => runTool(() => withGlobal(async (db) => {
    const u = (await db.query(
      `select u.id, u.display_name, u.language, u.timezone, e.email from users u
         left join user_emails e on e.user_id = u.id and e.is_primary where u.id = $1`, [caller.userId])).rows[0];
    // Человеку важно знать и о приглашении, которое он ещё не принял, — это ответ на «где я состою».
    return { user: u, orgs: await userOrgs(db, caller.userId, { includeInvited: true }) };
  })));

  server.registerTool('get_capabilities', {
    description: 'The version of the server, the minimum skill version it accepts, and the published skill version '
      + 'with the repository it is distributed from.',
    inputSchema: {},
    annotations: { title: 'Server and skill versions', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, () => runTool(async () => ({
    server_version: env.version, min_skill_version: MIN_SKILL_VERSION,
    current_skill_version: CURRENT_SKILL_VERSION, skill_repo: SKILL_REPO,
  })));

  server.registerTool('find_person', {
    description: 'People of the organization: name, email, language, time zone, country, role, mode, invitation status, '
      + 'whether they are in the Telegram bot, and `about` — who they are and what they close, in the words of people '
      + '(marked untrusted; may be empty). With query — the people whose name or '
      + 'email contains it, up to 10 of them; without query — everyone in the organization. '
      + 'For an owner or admin, about active members also ' + SEEN_MARKS,
    inputSchema: {
      org: ORG,
      query: z.string().min(1).optional().describe('Part of a name or an email. Omit it to get every person of the organization'),
    },
    annotations: { title: 'People of the organization', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: false, tool: 'find_person' }, async ({ db, actor }) => {
    // Ищем по любому адресу человека, а показываем основной: вторая почта — тот же человек, и по ней
    // его тоже находят. `limit null` в Postgres значит «без предела» — весь список организации.
    const r = await db.query(
      `select u.id, u.display_name as name, e.email, u.language, u.timezone, u.country, m.role, m.mode, m.status, m.about,
              -- Приглашённый ещё не в компании: есть ли у него Telegram и когда он заходил — это его
              -- жизнь в других компаниях, а пригласить можно любой адрес (открытая регистрация).
              (m.status = 'active' and tl.user_id is not null) as in_telegram, u.last_seen_bot_at, u.last_seen_app_at
         from memberships m join users u on u.id = m.user_id
         left join user_emails e on e.user_id = u.id and e.is_primary
         left join telegram_links tl on tl.user_id = u.id
        where m.org_id = current_setting('app.org_id')::uuid and m.status <> 'removed' and u.anonymized_at is null
          and ($1::text is null
               or u.display_name ilike '%' || $1 || '%'
               or exists (select 1 from user_emails e2 where e2.user_id = u.id and e2.email::text ilike '%' || $1 || '%'))
        order by u.display_name
        limit $2`, [args.query ?? null, args.query ? 10 : null]);
    // Когда человек заходил (спека person-presence) — взгляд управляющего: рядовому о коллегах
    // этого знать незачем, и полей у него нет вовсе, а не пустые.
    const seesPresence = await actorHasRole(db, actor, ['owner', 'admin']);
    const tz = seesPresence ? await viewerTimezone(db, actor) : 'UTC';
    // Профиль — слова людей о людях: агенту он приходит как данные, не как указание.
    // Имя человек задаёт себе сам — как и в сводке, оно приходит словами, а не указанием.
    return r.rows.map(({ last_seen_bot_at: bot, last_seen_app_at: app, ...p }) => ({
      ...p, name: untrusted(p.name as string | null), about: untrusted(p.about as string | null),
      ...(seesPresence && p.status === 'active' ? presenceView(bot, app, tz) : {}),
    }));
  })));

  // Дело, о котором заговорили (спека task-in-conversation). Человек помнит слова названия, а не то,
  // личное это дело или компании, — поэтому ищем сразу по всем его пространствам и говорим, где нашлось.
  // Здесь же живут и списки: «дела Ильяса», «что у этого плана» — тот же вопрос «какие дела», заданный
  // не словами названия, а полями (слияние поверхности коннектора).
  server.registerTool('find_task', {
    description: 'Find tasks: by words from the title or description, by the key of a task ("NOR-12", including a key it used '
      + 'to have), by its identifier in an external tracker (external), or by filters alone — person, status, plan, project, '
      + 'mine_only (set by me or by this agent). Without org the search covers the personal space and every company of the '
      + 'person; with org — that space only. Open tasks come first; closed ones only with include_closed or an explicit status. '
      + 'The answer says which space every task was found in.',
    inputSchema: {
      org: ORG.describe('Limit the search to one space: an organization (id or name) or "personal" — the personal items of the person. Omit to search all of them'),
      agent: AGENT,
      query: z.string().min(2).optional().describe('Words from the title or description; order does not matter, all of them must occur'),
      external: z.object({ system: z.string().min(1), id: z.string().min(1) }).optional()
        .describe('The object in an external tracker: {system, id} — the answer carries the source and its snapshot'),
      person: z.string().optional().describe('The person the task is on: id, name or email'),
      status: z.array(z.string()).optional().describe('Statuses to look among; without it — what is open'),
      plan: z.string().optional().describe('The id of a plan — its steps'),
      project: z.string().optional().describe('Project: id or name'),
      mine_only: z.boolean().optional().describe('Only what I set myself (from an agent — what this agent set)'),
      include_closed: z.boolean().optional().describe('Also search what is already closed — done, cancelled, declined'),
      limit: z.number().int().min(1).max(FIND_TASK_MAX).optional(),
    },
    annotations: { title: 'Find tasks', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, (args) => runTool(async () => {
    const query = args.query?.trim() ?? '';
    const asKey = query ? BOARD_KEY_RE.exec(query) : null;
    const words = asKey ? [] : query.split(/\s+/).filter(Boolean);
    if (args.query !== undefined && (!words.length && !asKey)) throw new AppError('validation_failed', 'Say at least two characters to search for');
    // Лишние слова не отбрасываются молча: иначе дело выдаётся как совпавшее по словам, которых в нём нет.
    if (words.length > FIND_TASK_WORDS) throw new AppError('validation_failed', `Search by ${FIND_TASK_WORDS} words at most — name the ones you remember from the title`);
    if (args.plan && !UUID_RE.test(args.plan)) throw new AppError('validation_failed', 'plan — the id of a plan');
    const limit = args.limit ?? FIND_TASK_LIMIT;
    // Названная точно вещь (обозначение дела, объект внешней системы) ищется во всех статусах: её
    // назвали целиком, и отсечь найденное по статусу значило бы ответить «нет такого».
    const exact = Boolean(asKey || args.external);
    // От имени агента ищем в одной организации: агент живёт в своей компании, и в остальных его нет.
    const only = args.org ? await resolveOrg(caller.userId, args.org) : (args.agent ? await resolveOrg(caller.userId, null) : null);
    // Организации — те же, что видит resolveOrg: только активные членства (приглашённый ещё не действует).
    const orgs = (await withGlobal((db) => db.query(
      `select o.id, o.name, o.kind from memberships m join orgs o on o.id = m.org_id
        where m.user_id = $1 and m.status = 'active' order by o.kind, o.created_at`, [caller.userId]))).rows as OrgRow[];

    const found: Record<string, unknown>[] = [];
    let personHit = false;
    let personMiss: unknown = null;
    for (const org of orgs) {
      if (only && org.id !== only) continue;
      // Действующее лицо ставит inToolCtx: человек видит свои закрытые проекты, агент — нет
      // (спека projects).
      const rows = await inToolCtx(caller, { org: org.id, agent: args.agent }, { write: false, tool: 'find_task' }, async (ctx) => {
        const params: unknown[] = [];
        const add = (v: unknown): string => { params.push(v); return `$${params.length}`; };
        const conds: string[] = [];

        if (args.person) {
          // Человек есть не в каждой компании — там, где его нет, искать нечего. Но если его нет нигде,
          // пустой список врёт: «задач нет» вместо «такого человека нет» (после цикла — ошибка).
          const personId = await resolvePersonRef(ctx.db, args.person).catch((e: unknown) => { personMiss = e; return null; });
          if (!personId) return [];
          personHit = true;
          conds.push(`t.assignee_user_id = ${add(personId)}`);
        }
        if (args.plan) conds.push(`t.plan_id = ${add(args.plan)}`);
        // Участник и гость находят только причастные дела — как в боте и приложении.
        const only = await involvementFilter(ctx);
        if (only) conds.push(involvedSql('t', add(only.userId), add(only.agentId)));
        if (args.project) {
          const project = await resolveProject(ctx.db, args.project, ctx.agent ? null : ctx.userId).catch(() => null);
          if (!project) return [];
          conds.push(`t.project_id = ${add(project.id)}`);
        }
        if (args.mine_only) {
          if (ctx.agent) conds.push(`t.author_agent_id = ${add(ctx.agent.id)}`);
          else conds.push(`t.author_user_id = ${add(ctx.userId)} and t.author_agent_id is null`);
        }
        // «Личное» после переезда — закрытая доска человека внутри компании (спека projects-stage2):
        // без этого условия поиск по личному вывалил бы всю работу компании.
        if (args.org === 'personal') {
          const board = await ownBoardId(ctx.db, ctx.userId);
          if (board) conds.push(`t.project_id = ${add(board)}`);
        }
        if (args.status?.length) conds.push(`t.status = any(${add(args.status)})`);
        else if (!args.include_closed && !exact) conds.push(`t.status = any(${add(OPEN_STATUSES)})`);

        // Каждое слово ищется отдельно и обязано встретиться: человек помнит слова, а не формулировку.
        // `%`, `_` и `\` в слове экранируются: иначе запрос «50%» вывалил бы весь список.
        for (const w of words) {
          conds.push(`t.title || ' ' || coalesce(t.description, '') ilike '%' || ${add(w.replace(/([\\%_])/g, '\\$1'))} || '%' escape '\\'`);
        }
        // Назвали обозначение («NOR-12») — ищем именно его, в том числе среди прежних: дело могло
        // переехать в другой проект, а обозначение осталось в чужой переписке.
        if (asKey) {
          const key = asKey[1]!.toUpperCase();
          conds.push(`(upper(p.key) = ${add(key)} and t.number = ${add(Number(asKey[2]))}`
            + ` or ${add(`${key}-${String(Number(asKey[2])).padStart(3, '0')}`)} = any(t.former_keys))`);
        }
        // Дела в работе впереди закрытых, внутри — помеченные важным и с ближним сроком: это тот же
        // порядок, которым список отдавал слитый сюда `personal_list`, и то же, что обещает описание
        // `create_task` («звезда важного поднимает дело»). Правило живёт в SQL, иначе лимит пространства
        // вырезал бы важное дело до сортировки (ревью диффа).
        const openParam = add(OPEN_STATUSES);
        const limitParam = add(limit);
        const external = args.external
          ? `join task_sources s on s.task_id = t.id and s.system = ${add(args.external.system)} and s.external_id = ${add(args.external.id)}`
          : '';
        const sourceCols = args.external
          ? ', s.id as source_id, s.url as source_url, s.title as source_title, s.snapshot as source_snapshot, s.captured_at as source_captured_at'
          : '';
        return (await ctx.db.query(
          `select ${TASK_COLUMNS}${sourceCols}
             from tasks t left join projects p on p.id = t.project_id ${external}
            ${conds.length ? `where ${conds.join(' and ')}` : ''}
            order by (t.status = any(${openParam})) desc, (t.priority = 'urgent') desc,
                     t.due_date nulls last, t.created_at desc limit ${limitParam}`, params)).rows.map((row) => forAgent(row, ctx.actor));
      });
      // Название компании пишет её владелец, а компаний у человека бывает несколько — чужие слова.
      for (const row of rows) found.push({ org_id: org.id, org_name: untrusted(org.name), org_kind: org.kind, ...row });
    }
    // Человека не нашли ни в одном пространстве — это ответ «не знаю такого», а не «дел нет».
    if (args.person && !personHit && personMiss) throw personMiss;
    // Слияние пространств тем же порядком, что и внутри пространства: живое впереди, важное выше,
    // ближний срок раньше, дальше — свежее сверху (по времени, не по тексту даты). Иначе лимит срезал бы
    // важное дело одной компании ради обычного дела другой.
    const open = new Set<string>(OPEN_STATUSES);
    const at = (row: Record<string, unknown>): number => new Date(String(row.created_at)).getTime();
    // Дело без срока идёт после любого со сроком — это `nulls last` запроса.
    const due = (row: Record<string, unknown>): number => (row.due_date == null ? Infinity : new Date(String(row.due_date)).getTime());
    const urgent = (row: Record<string, unknown>): number => Number(row.priority === 'urgent');
    found.sort((a, b) => (Number(open.has(String(b.status))) - Number(open.has(String(a.status))))
      || (urgent(b) - urgent(a)) || (due(a) - due(b)) || (at(b) - at(a)));
    return { tasks: found.slice(0, limit) };
  }));

  server.registerTool('list_agents', {
    description: 'Agents of the organization: area of work, owner, status.',
    inputSchema: { org: ORG },
    annotations: { title: 'Agents of the organization', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: false, tool: 'list_agents' }, async ({ db }) => {
    const r = await db.query(
      `select a.id, a.name, a.description, a.status, a.owner_user_id, u.display_name as owner_name
         from agents a join users u on u.id = a.owner_user_id order by a.name`);
    return r.rows;
  })));
}
