import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveWaiting } from '../../core/tasks.js';
import { type CallerCtx, inToolCtx, runTool } from '../context.js';
import { ORG, AGENT } from './orientation.js';

// Группа «Ожидания» (спека mcp-and-oauth / step-lifecycle-and-queue): задача-ожидание внешнего события.
// Заводится тем же `create_task` с `kind: 'waiting'`, дата следующей проверки двигается `update_task`
// с `next_check_at` — здесь остаётся только «наступило».

export function registerWaitingTools(server: McpServer, caller: CallerCtx): void {
  server.registerTool('resolve_waiting', {
    description: '"Arrived": the waiting has resolved (or the external waiting of an action task has ended).',
    inputSchema: { org: ORG, agent: AGENT, task: z.string().min(1) },
    annotations: { title: 'Mark a waiting as arrived', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'resolve_waiting' }, (ctx) => resolveWaiting(ctx.db, args.task, ctx.actor))));
}
