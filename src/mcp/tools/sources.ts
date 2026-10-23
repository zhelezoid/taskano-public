import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../../db/pool.js';
import { AppError } from '../../core/errors.js';
import { addSource, assertNotServerSource, type SourceKind } from '../../core/sources.js';
import { requireAuthorOrManager } from '../../core/tasks.js';
import type { Actor } from '../../core/types.js';
import { actorAgentId, actorUserId } from '../../core/types.js';
import { type CallerCtx, inToolCtx, runTool } from '../context.js';
import { ORG, AGENT } from './orientation.js';

// Группа «Источники дела» (спека task-context): откуда дело взялось и что агент прочитал снаружи.
// Сервер сам во внешние системы не ходит — туда ходит агент своим коннектором и приносит слепок.
// Найти дело по объекту внешней системы умеет `find_task` с полем `external`.

/** Ссылка источника: только http(s) — её открывают и бот, и Mini App. */
const URL_FIELD = z.string().url().refine((u) => /^https?:$/.test(new URL(u).protocol), 'only http(s) links').optional();

const KIND = z.enum(['chat', 'group', 'external', 'task'])
  .describe('chat — a conversation with you; group — a Telegram work chat, written by the server itself and refused here; '
    + 'external — a tracker, a document, an email; task — another Taskano task');
const SNAPSHOT = z.object({
  status: z.string().optional(), summary: z.string().optional(), updated_at: z.string().optional(),
}).loose().describe('What you read out there: {status, summary, updated_at}. summary is a digest (≤ 1000 characters), not a copy of the page');

/**
 * Дописать источник к делу может автор, исполнитель и owner/admin (спека roles-and-rights). Цитату
 * источника исполнитель читает как основание дела — подложить её в чужое дело со стороны нельзя.
 * Агент — либо тот, кто дело ведёт, либо в правах человека, который его позвал.
 */
async function requireSourceAccess(db: Db, taskId: string, actor: Actor): Promise<void> {
  const t = (await db.query('select assignee_user_id, author_agent_id from tasks where id = $1', [taskId])).rows[0] as
    { assignee_user_id: string; author_agent_id: string | null } | undefined;
  if (!t) throw new AppError('not_found', 'Task not found');
  const agentId = actorAgentId(actor);
  if (agentId && t.author_agent_id === agentId) return;
  const userId = actorUserId(actor);
  if (!userId) return;                          // системе источники заводит сам сервер (перенос дела, разбор группы)
  if (t.assignee_user_id === userId) return;
  await requireAuthorOrManager(db, taskId, { kind: 'user', userId });
}

export function registerSourceTools(server: McpServer, caller: CallerCtx): void {
  server.registerTool('add_source', {
    description: 'Put the context of a task into the task itself: where it came from, what it is based on, what is already known. '
      + 'The author of the task, the person doing it, an owner or an admin can add a source; an agent — to a task it leads. '
      + 'title is how a person names this source ("Linear EXT-142", "the conversation on 19 September"); '
      + 'quote — the words of the people it is based on (≤ 500 characters, longer is trimmed); '
      + 'snapshot — what you yourself read there earlier, so that the next run does not have to go there again. '
      + 'Taskano only stores what you pass: it never opens the url, never calls a tracker or any other system. '
      + 'Idempotent by (system, external_id) and by (task, url): a repeat with a fresh snapshot updates the row and its age '
      + 'instead of adding a second one — that is how a snapshot is refreshed. The dossier of the task shows the age of every snapshot in days. '
      + 'No more than 50 sources per task.',
    inputSchema: {
      org: ORG, agent: AGENT, task: z.string().min(1), kind: KIND, title: z.string().min(1),
      url: URL_FIELD, system: z.string().optional(),
      external_id: z.string().optional().describe('the id of the object in that system; for kind=task — the id of the Taskano task'),
      quote: z.string().optional(), snapshot: SNAPSHOT.optional(),
    },
    annotations: { title: 'Add the source of a task', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'add_source' }, async ({ db, actor }) => {
    await requireSourceAccess(db, args.task, actor);
    assertNotServerSource(args.kind, args.system);
    return addSource(db, {
      taskId: args.task, kind: args.kind as SourceKind, title: args.title, url: args.url ?? null,
      system: args.system ?? null, externalId: args.external_id ?? null, quote: args.quote ?? null, snapshot: args.snapshot ?? null,
    }, actor);
  })));
}
