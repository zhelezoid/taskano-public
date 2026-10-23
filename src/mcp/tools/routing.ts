import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AppError } from '../../core/errors.js';
import { moveTaskToOrg } from '../../core/routing.js';
import { type CallerCtx, resolveOrg, runTool } from '../context.js';
import { AGENT } from './orientation.js';

// Группа «Где живёт дело» (спека task-routing): перенос открытого дела между личным пространством
// человека и его компанией. Инструмент намеренно вне inToolCtx — у переноса две организации сразу,
// и он всегда идёт от имени самого человека.

export function registerRoutingTools(server: McpServer, caller: CallerCtx): void {
  server.registerTool('move_to_org', {
    description: 'Move an open item between the person\'s personal space and their company. '
      + 'An item that serves the company is the company\'s item, even when the owner does it '
      + 'themselves; personal is what would remain if the company closed. Moving into a company requires why, '
      + 'done_criteria and due_date — the item joins the shared work. Only the person themselves can move an item.',
    inputSchema: {
      task: z.string().min(1),
      org: z.string().optional().describe(
        "Where to move it: the company (id or name), or 'personal' — the person's own space. "
        + 'Can be omitted if they have a single company'),
      why: z.string().optional().describe('Why the item matters — required when moving into a company'),
      done_criteria: z.string().optional().describe('How we know it is done — required when moving into a company'),
      due_date: z.string().optional().describe('YYYY-MM-DD — required when moving an action into a company'),
      agent: AGENT,
    },
    annotations: { title: 'Move an item between spaces', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, (args) => runTool(async () => {
    // Агент не переносит: из личного он читал бы закрытое ему, в личное — уводил бы работу
    // из-под надзора (спека owner-feedback).
    if (args.agent) throw new AppError('forbidden', 'An agent does not move items between spaces — only the person themselves');
    const toOrgId = await resolveOrg(caller.userId, args.org);
    return moveTaskToOrg({ kind: 'user', userId: caller.userId }, args.task, toOrgId, {
      why: args.why, doneCriteria: args.done_criteria, dueDate: args.due_date,
    });
  }));
}
