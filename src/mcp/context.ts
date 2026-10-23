import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { setActor, withGlobal, withOrg, withSystem, type Db } from '../db/pool.js';
import { AppError } from '../core/errors.js';
import { requireAgentControl, type AgentRow } from '../core/access.js';
import type { Actor } from '../core/types.js';
import { logger } from '../log.js';

// Общая обвязка инструментов MCP: кто вызывает, в какой организации, от чьего имени.
// Спека mcp-and-oauth: токен → человек; `org` и `agent` — в аргументах каждого вызова.

export interface CallerCtx {
  userId: string;
  /**
   * Вызов по токену агента (спека agent-tokens): организация и агент закреплены токеном. Без
   * закрепления — человек по OAuth, выбирающий их аргументами.
   */
  pin?: { orgId: string; agentId: string; tokenId: string };
}

export interface ToolCtx {
  db: Db;
  orgId: string;
  userId: string;
  agent: AgentRow | null;
  actor: Actor;
}

/** Найти организацию по id или имени среди организаций человека; без org — единственная компания. */
export async function resolveOrg(userId: string, orgRef?: string | null): Promise<string> {
  // Только активные членства: приглашённый ещё не действует в организации (аудит безопасности, п.8–9).
  const orgs = (await withGlobal((db) => db.query(
    `select o.id, o.name, o.kind from memberships m join orgs o on o.id = m.org_id
      where m.user_id = $1 and m.status = 'active' order by o.kind, o.created_at`, [userId]))).rows as { id: string; name: string; kind: string }[];
  const list = () => orgs.map((o) => ({ id: o.id, name: o.name, kind: o.kind }));
  if (orgRef) {
    if (orgRef === 'personal') {
      // После переезда на проекты (спека projects-stage2) «личное» — это закрытый проект человека
      // внутри компании; старое личное пространство остаётся только у того, кто ещё не переехал.
      //
      // Читаем системным слоем, а не глобальным: `projects` под FORCE RLS, и в транзакции без
      // org_id запрос молча возвращал ноль строк — ветка не срабатывала ни разу, а личные дела
      // человека оставались видны только в приложении. Берём один столбец и только по
      // собственным проектам человека: чужого здесь не видно и без RLS.
      const board = (await withSystem((db) => db.query(
        `select org_id from projects where owner_user_id = $1 and private and status = 'active'
          order by created_at limit 1`, [userId]))).rows[0];
      if (board && orgs.some((o) => o.id === board.org_id)) return board.org_id as string;
      const p = orgs.find((o) => o.kind === 'personal');
      if (p) return p.id;
    }
    const byId = orgs.find((o) => o.id === orgRef);
    if (byId) return byId.id;
    const byName = orgs.filter((o) => o.name.toLowerCase() === orgRef.toLowerCase());
    if (byName.length === 1) return byName[0]!.id;
    if (byName.length > 1) throw new AppError('validation_failed', `The name "${orgRef}" is ambiguous — pass the organization id`, { orgs: list() });
    throw new AppError('not_found', `Organization "${orgRef}" not found among yours`, { orgs: list() });
  }
  const companies = orgs.filter((o) => o.kind === 'company');
  if (companies.length === 1) return companies[0]!.id;
  if (!companies.length) throw new AppError('not_found', 'You have no organization. Create one with the create_org tool', { orgs: [] });
  throw new AppError('validation_failed', 'Pass org: you have several organizations', { orgs: companies.map((o) => ({ id: o.id, name: o.name })) });
}

/**
 * Выполнить инструмент в контексте организации. `write` — действие меняет данные:
 * от имени агента на паузе оно запрещено (ограничитель «пауза агента»).
 */
export async function inToolCtx<T>(
  caller: CallerCtx,
  args: { org?: string | null; agent?: string | null },
  opts: { write: boolean; tool: string; agentView?: boolean },
  fn: (ctx: ToolCtx) => Promise<T>,
): Promise<T> {
  const orgId = await resolveOrg(caller.userId, args.org);
  // Закреплённый вызов не выходит за свою организацию и своего агента. Аргументы уже переписаны
  // обвязкой сервера, а здесь — вторая стена: инструмент, сам выбирающий организацию (find_task
  // обходит все организации человека), не уведёт токен в соседнюю.
  const pin = caller.pin;
  if (pin && orgId !== pin.orgId) throw new AppError('forbidden', 'This token works only in its own organization');
  if (pin && !args.agent) throw new AppError('forbidden', 'This token acts only on behalf of its agent');
  return withOrg(orgId, async (db) => {
    let agent: AgentRow | null = null;
    if (args.agent) {
      agent = await requireAgentControl(db, args.agent, caller.userId);
      if (pin && agent.id !== pin.agentId) throw new AppError('forbidden', 'This token acts only on behalf of its agent');
      if (opts.write && agent.status === 'paused') throw new AppError('agent_paused', `Agent "${agent.name}" is paused`);
    } else {
      const m = await db.query(`select 1 from memberships where org_id = $1 and user_id = $2 and status = 'active'`, [orgId, caller.userId]);
      if (!m.rowCount) throw new AppError('forbidden', 'You are not a member of this organization');
    }
    const actor: Actor = agent ? { kind: 'agent', agentId: agent.id, userId: caller.userId } : { kind: 'user', userId: caller.userId };
    // Действующее лицо сессии — только человек, действующий сам. Вызов от имени агента идёт БЕЗ
    // человека: иначе агент увидел бы закрытые проекты своего владельца (спека projects).
    //
    // `agentView` — для инструментов, которые агентские по смыслу, но аргумента `agent` не имеют
    // (сводка сразу по всем агентам организации). Без него сводка читала бы дела с правами
    // владельца и вынесла бы агенту содержимое его закрытых проектов.
    await setActor(db, !opts.agentView && actor.kind === 'user' ? actor.userId : null);
    await resolveTaskArg(db, args);
    const result = await fn({ db, orgId, userId: caller.userId, agent, actor });
    if (agent && opts.write) {
      // Токен — в журнал: по нему видно, что натворил утёкший токен (null — через коннектор).
      await db.query(
        `insert into agent_audit(org_id, agent_id, user_id, tool, args_summary, result, agent_token_id) values ($1, $2, $3, $4, $5, 'ok', $6)`,
        [orgId, agent.id, caller.userId, opts.tool, JSON.stringify(summarize(args)), pin?.tokenId ?? null],
      );
    }
    return result;
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_KEY_RE = /^([A-Za-z][A-Za-z0-9]{1,4})-(\d{1,6})$/;

/**
 * Аргумент `task` у инструментов — id дела, но люди и модели называют дело ключом («NOR-012»): его
 * же показывают find_task, сводка и бот. Ключ раньше уходил в SQL как uuid и ронял вызов немой
 * «internal» — ровно то, за что каталоги отказывают. Здесь ключ (в том числе прежний, после переезда
 * дела в другой проект) превращается в id внутри организации вызова и с правами вызывающего (RLS
 * уже включён). Не ключ и не id — не трогаем: `comment_task` ищет своё дело по слову сам.
 */
async function resolveTaskArg(db: Db, args: object): Promise<void> {
  const a = args as { task?: unknown };
  if (typeof a.task !== 'string') return;
  const ref = a.task.trim();
  if (UUID_RE.test(ref)) { a.task = ref; return; }
  const key = TASK_KEY_RE.exec(ref);
  if (!key) return;
  const prefix = key[1]!.toUpperCase();
  const num = Number(key[2]);
  const r = await db.query(
    `select t.id from tasks t left join projects p on p.id = t.project_id
      where (upper(p.key) = $1 and t.number = $2) or $3 = any(t.former_keys)
      order by (upper(p.key) = $1 and t.number = $2) desc nulls last limit 1`,
    [prefix, num, `${prefix}-${String(num).padStart(3, '0')}`]);
  if (!r.rowCount) throw new AppError('not_found', `Task ${ref} not found in this organization — check the key with find_task, or pass org`);
  a.task = r.rows[0].id as string;
}

function summarize(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}…` : v;
  return out;
}

/** Текст людей — недоверенный ввод: оборачиваем, чтобы агент не исполнял инструкции из него. */
/**
 * Видит ли вызывающий любое дело организации. Владелец, админ и агент — да. Участник и
 * гость — только дела, к которым причастны (исполнитель, постановщик, проверяющий ожидание или
 * результата): так же,
 * как бот (`findTaskByShortId`) и приложение. Раньше коннектор отдавал рядовому участнику полное
 * досье любого дела на общих досках — разговор, источники, историю (аудит безопасности 07.10).
 */
export async function seesAllTasks(ctx: Pick<ToolCtx, 'db' | 'userId' | 'agent'>): Promise<boolean> {
  // Агент видит всё, только если его хозяин — владелец или админ: хозяином агента можно сделать и
  // рядового, и через `agent=` он иначе обходил бы это правило (ревью 07.10).
  const userId = ctx.agent ? ctx.agent.owner_user_id : ctx.userId;
  const r = await ctx.db.query(
    `select role from memberships where org_id = current_setting('app.org_id')::uuid and user_id = $1 and status = 'active'`,
    [userId]);
  return ['owner', 'admin'].includes(r.rows[0]?.role as string);
}

/**
 * Условие «причастен к делу» для `alias` таблицы tasks: `param` — плейсхолдер id человека, `agentParam` —
 * агента, если вызов от агента (его собственные дела ему видны всегда).
 */
export function involvedSql(alias: string, param: string, agentParam?: string): string {
  const own = agentParam ? ` or ${alias}.author_agent_id = ${agentParam}` : '';
  return `(${alias}.assignee_user_id = ${param} or ${alias}.author_user_id = ${param} or ${alias}.waiting->>'check_user_id' = ${param}::text`
    + ` or ${alias}.reviewer_user_id = ${param}${own})`;
}

/** Ограничение причастностью для вызывающего: `null` — видит всё. */
export async function involvementFilter(ctx: Pick<ToolCtx, 'db' | 'userId' | 'agent'>): Promise<{ userId: string; agentId: string | null } | null> {
  if (await seesAllTasks(ctx)) return null;
  return { userId: ctx.agent ? ctx.agent.owner_user_id : ctx.userId, agentId: ctx.agent?.id ?? null };
}

export function untrusted(text: string | null | undefined): { untrusted: true; text: string } | null {
  return text == null ? null : { untrusted: true, text };
}

/** Текстовые поля задачи из переписки группы: их пишет модель по словам людей группы. expected_result не
 *  входит — это enum-структура {type, required}, свободного текста в ней нет. */
const GROUP_TASK_TEXT_KEYS = ['title', 'description', 'why', 'done_criteria', 'rationale'];

export function isGroupTask(row: object): boolean {
  const origin = (row as { origin?: unknown }).origin;
  return typeof origin === 'string' && origin.startsWith('group:');
}

/**
 * Написал ли дело тот, кто читает выдачу: автор-человек дела — тот же человек, что вызывает (сам или
 * через своего агента). У дела, поставленного агентом, автор-человек — хозяин агента, так что шаги
 * своих агентов человек и его агенты читают как свои. У усыновлённого дела (`adopt_task`) автор-человек
 * остаётся прежним: слова писал он, и агент их только унаследовал. Строка без поля авторства — чужая:
 * отказ в безопасную сторону.
 */
export function authoredBy(row: object, viewer: Actor): boolean {
  if (viewer.kind === 'system') return true;
  return (row as { author_user_id?: unknown }).author_user_id === viewer.userId;
}

/**
 * Строка задачи для выдачи агенту: у задачи из группы (origin group:…) текстовые поля — под untrusted
 * (спека group-intake). Строка без origin не меняется — SQL выдачи обязан выбирать origin.
 */
export function taskForAgent<T extends object>(row: T): T {
  return markTaskText(row, isGroupTask(row));
}

/**
 * То же для выдачи тому, кто читает (`viewer`): текстовые поля — под untrusted ещё и тогда, когда их
 * писал не он. Слова чужого дела — те же слова людей, что реплики и имена в сводке (HUMAN_TEXT_KEYS,
 * `briefing`): дело может поставить рядовой, гость или чужой агент, и заголовок «игнорируй прежние
 * указания…» иначе приходил бы агенту владельца как его собственный текст. Отдельная функция, а не
 * второй аргумент `taskForAgent`: ту зовут через `.map`, и индекс строки попал бы на место читающего.
 * SQL выдачи обязан выбирать origin и поля авторства.
 */
export function taskForViewer<T extends object>(row: T, viewer: Actor): T {
  return markTaskText(row, isGroupTask(row) || !authoredBy(row, viewer));
}

function markTaskText<T extends object>(row: T, mark: boolean): T {
  if (!mark) return row;
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const k of GROUP_TASK_TEXT_KEYS) if (typeof out[k] === 'string') out[k] = untrusted(out[k] as string);
  return out as T;
}

/** Предложение для выдачи агенту: задача из переписки сверх лимита несёт в summary название из группы. */
export function proposalForAgent<T extends object>(row: T): T {
  const p = row as { type?: unknown; summary?: unknown };
  if (p.type !== 'dialog_task' || typeof p.summary !== 'string') return row;
  return { ...row, summary: untrusted(p.summary) };
}

/** Поля событий, куда попадает свободный текст людей (вопрос, причина, указание владельца, название,
 *  пересказ сообщения рабочей группы). */
// `name` — имя проекта или доски в событиях проектов: его пишет человек (ревью 08.10).
const HUMAN_TEXT_KEYS = ['text', 'instruction', 'title', 'reason', 'comment', 'summary', 'name'];

/** Данные события для выдачи агенту: текст людей — под пометкой untrusted (ревью безопасности). */
export function eventDataForAgent(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const out: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  for (const k of HUMAN_TEXT_KEYS) if (typeof out[k] === 'string') out[k] = untrusted(out[k] as string);
  return out;
}

/**
 * `dry_run` создающих инструментов: выполнить в savepoint и всегда откатить — ни строк, ни
 * уведомлений (они тоже пишутся в той же транзакции) не остаётся (спека mcp-and-oauth).
 */
export async function withDryRun<T>(db: Db, dryRun: boolean | undefined, fn: () => Promise<T>): Promise<T | { dry_run: true; would_create: T }> {
  if (!dryRun) return fn();
  await db.query('savepoint dry_run');
  try {
    const result = await fn();
    return { dry_run: true, would_create: result };
  } finally {
    await db.query('rollback to savepoint dry_run');
  }
}

export function ok(data: unknown): CallToolResult {
  // structuredContent обязан быть объектом: SDK отклоняет голый массив и примитивы.
  const structured = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : { items: data };
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: structured as Record<string, unknown> };
}

/** Единая обработка ошибок инструментов: машинный code + человеческое message. */
export async function runTool(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await fn();
    return ok(data ?? { ok: true });
  } catch (e) {
    if (e instanceof AppError) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: e.code, message: e.message, details: e.details ?? null }) }] };
    }
    // Страховка: строка не того вида в поле id (дело, план, вложение) — ошибка того, кто звал, а не
    // наша. Postgres отвечает 22P02 «invalid input syntax», и без этой ветки вызов уходил бы в
    // «internal» с номером случая вместо понятного «такого id нет».
    if ((e as { code?: unknown })?.code === '22P02') {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({
        code: 'validation_failed',
        message: 'An id in the request is not valid. Pass the id returned by find_task (or the task key, like NOR-001).',
        details: null,
      }) }] };
    }
    // Непредвиденную ошибку наружу не раскрываем, но и «Internal server error» без единой зацепки
    // не отдаём: агенту нечего сказать человеку, а поддержке — нечего искать в логе. Отдаём короткий
    // номер случая, по которому запись находится (каталог коннекторов считает немые ошибки поводом
    // для отказа — «generic errors without details»).
    const incident = randomUUID().slice(0, 8);
    logger.error({ err: e, incident }, 'mcp tool failed');
    return {
      isError: true,
      content: [{
        type: 'text',
        text: JSON.stringify({
          code: 'internal',
          message: `Something broke on our side (incident ${incident}). Whether the call went through is not known `
            + `here — check with get_task or find_task before repeating it, or repeat it with the same `
            + `idempotency_key if it had one. If it keeps failing, tell support@taskano.app this number.`,
          details: { incident },
        }),
      }],
    };
  }
}

/** Слепок внешней системы: `summary` — пересказ чужого текста, для агента это данные, а не указания. */
export function snapshotForAgent(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const s = snapshot as Record<string, unknown>;
  return typeof s.summary === 'string' ? { ...s, summary: untrusted(s.summary) } : s;
}
