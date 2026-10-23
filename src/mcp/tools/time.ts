import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../../db/pool.js';
import { AppError } from '../../core/errors.js';
import { actingUserId, membership } from '../../core/access.js';
import { timeReport } from '../../core/time.js';
import type { Actor } from '../../core/types.js';
import { type CallerCtx, inToolCtx, runTool } from '../context.js';
import { AGENT, ORG } from './orientation.js';

// Отчёты по времени — спека time-tracking. Таймер/ручной ввод (кнопки бота) заводятся ботом через
// src/core/time.ts напрямую; здесь — только чтение для постановщиков и агентов.

const PERSON = z.string().optional().describe('Person: id or name. Without this parameter — across all people of the organization (within your permissions)');
const GROUP_BY = z.enum(['day', 'task', 'agent']).default('day').describe('How the report is broken down: by day, by task or by the areas of the agents');
const FROM = z.string().describe('Start of the period, an ISO date or date-time');
const TO = z.string().describe('End of the period, an ISO date or date-time (exclusive)');

function parseDateArg(v: string, field: string): Date {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new AppError('validation_failed', `Invalid date ${field}: ${v}`);
  return d;
}

async function resolvePersonUserId(db: Db, personRef: string): Promise<string> {
  if (/^[0-9a-f-]{36}$/i.test(personRef)) return personRef;
  const r = await db.query(
    `select u.id from memberships m join users u on u.id = m.user_id
      where m.org_id = current_setting('app.org_id')::uuid and m.status <> 'removed' and u.display_name ilike $1
      limit 2`,
    [personRef],
  );
  if (r.rowCount === 1) return r.rows[0].id;
  if (r.rowCount && r.rowCount > 1) throw new AppError('validation_failed', `Several people named "${personRef}" — be more specific`);
  throw new AppError('not_found', `Person "${personRef}" not found`);
}

/**
 * Чьи часы видно тому, кто спросил (спека roles-and-rights): владельцу и админу — вся организация
 * (null), остальным — только свои. Отказа здесь нет: свои часы человек и так видит в приложении,
 * а до этой правки любой участник выгружал коннектором часы всех людей компании.
 */
async function hoursScope(db: Db, actor: Actor): Promise<string[] | null> {
  const userId = await actingUserId(db, actor);
  if (!userId) return null;
  const m = await membership(db, userId);
  return m && ['owner', 'admin'].includes(m.role) ? null : [userId];
}

/** Записи времени за период — подробная форма `time_report` (слияние `list_time_entries`). */
async function timeEntries(
  db: Db, opts: { userIds?: string[]; from: Date; to: Date; agentScope?: string },
): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [opts.from, opts.to];
  let filter = '';
  if (opts.userIds) { params.push(opts.userIds); filter += ` and te.user_id = any($${params.length})`; }
  if (opts.agentScope) { params.push(opts.agentScope); filter += ` and t.author_agent_id = $${params.length}`; }
  const r = await db.query(
    `select te.id, te.task_id, t.title as task_title, te.user_id, te.started_at, te.ended_at, te.minutes, te.source,
            (te.ended_at is null and te.source = 'timer') as open
       from time_entries te
       -- join, а не left join: запись времени по делу закрытого проекта наружу не отдаём
       -- (спека projects) — правило видимости задач фильтрует её тем же условием.
       join tasks t on t.id = te.task_id
      where te.started_at < $2 and coalesce(te.ended_at, now()) > $1 ${filter}
      order by te.started_at`,
    params,
  );
  return r.rows as Record<string, unknown>[];
}

export function registerTimeTools(server: McpServer, caller: CallerCtx): void {
  server.registerTool('time_report', {
    description: "A time report: hours, the split between timer and manual entry, the number of tasks. Day boundaries are taken in each person's own time zone. "
      + 'An owner and an admin see the whole organization; anyone else gets their own hours, whoever they ask about. '
      + 'With entries: true the same period comes back entry by entry instead of totals — each with its task and its '
      + 'minutes; group_by is not applied to entries. Entries add up to less than the totals: a timer still running comes '
      + 'with open: true and no minutes yet, and entries only cover tasks you can see, while the totals count the hours '
      + 'of tasks in other people\'s closed projects as well.',
    inputSchema: { org: ORG, agent: AGENT, person: PERSON, from: FROM, to: TO, group_by: GROUP_BY,
      entries: z.boolean().optional().describe('Entry by entry instead of totals') },
    annotations: { title: 'Time report', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: false, tool: 'time_report' }, async ({ db, agent, actor }) => {
    const from = parseDateArg(args.from, 'from');
    const to = parseDateArg(args.to, 'to');
    if (to <= from) throw new AppError('validation_failed', 'The end of the period must be later than its start');
    // Кто не распоряжается компанией, тот получает свой отчёт, о ком бы ни спросил, — и имя, о
    // котором спросили, даже не разбирается: иначе рядовой получал бы «такого человека нет» вместо
    // своих часов (ревью слияний).
    const scope = await hoursScope(db, actor);
    const userIds = scope ?? (args.person ? [await resolvePersonUserId(db, args.person)] : undefined);
    // Агент без права time_report_full видит только своё направление, даже если попросил иначе.
    const agentScope = agent && !agent.permissions.time_report_full ? agent.id : undefined;
    // Сводка и перечень записей — один и тот же вопрос о том же периоде, разной подробности
    // (слияние `list_time_entries`, спека connector-surface). Границы видимости те же.
    if (args.entries) return { entries: await timeEntries(db, { userIds, from, to, agentScope }) };
    return timeReport(db, { userIds, from, to, groupBy: args.group_by, agentScope });
  })));

}
