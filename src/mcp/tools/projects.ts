import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { addProjectMember, createProject, listProjects, removeProjectMember, updateProject } from '../../core/projects.js';
import { type CallerCtx, inToolCtx, runTool } from '../context.js';
import { ORG, AGENT } from './orientation.js';

// Группа «Проект» (спека projects): папка по теме, в которой лежат дела. Проект либо открыт — его
// ведут агенты, видит организация, — либо закрыт: его дела видны только хозяину, и агенту их не
// покажет даже прямой запрос (правило видимости в RLS, миграция 008).

const PROJECT = z.string().min(1).describe('Project: id or name');

export function registerProjectTools(server: McpServer, caller: CallerCtx): void {
  server.registerTool('create_project', {
    description: 'Create a project — a folder by topic, not a plan: a plan is the steps to a goal, a project is the topic the items live in. '
      + 'Open by default: the organization sees it and agents lead it. private: true — a closed project, visible to you alone; '
      + 'an agent cannot create one and never sees what is inside.',
    inputSchema: {
      org: ORG, agent: AGENT, name: z.string().min(1), description: z.string().optional(),
      private: z.boolean().optional().describe('A closed project: only you see its items. A person creates it, and only for themselves'),
    },
    annotations: { title: 'Create a project', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'create_project' }, (ctx) => createProject(ctx.db, {
    name: args.name, description: args.description ?? null, private: args.private,
  }, ctx.actor))));

  server.registerTool('list_projects', {
    description: 'Projects of the organization: the closed ones you have access to and all the open ones, with the number of open items and the people '
      + 'who have access (members) in each. From an agent — the open ones only. Archived projects come only with include_archived.',
    inputSchema: {
      org: ORG, agent: AGENT,
      include_archived: z.boolean().optional().describe('Archived projects too — they are hidden from the lists by default'),
    },
    annotations: { title: 'List projects', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: false, tool: 'list_projects' }, async (ctx) => ({
    // Закрытый проект принадлежит человеку, а не агенту: от имени агента список отдаёт только открытые.
    projects: await listProjects(ctx.db, ctx.agent ? null : ctx.userId, { includeArchived: args.include_archived }),
  }))));

  server.registerTool('update_project', {
    description: 'Change a project: name, description, closedness (private), status (archived — hidden from the lists, its items are '
      + 'not handed out in the queue). A project is closed only while it holds no items of other people; opening it makes its items '
      + 'visible to the AI agents of this organization inside Taskano, so only a person opens and closes it. '
      + 'It changes only the project record in Taskano: nothing is sent anywhere.',
    inputSchema: {
      org: ORG, agent: AGENT, project: PROJECT, name: z.string().optional(), description: z.string().optional(),
      private: z.boolean().optional(), status: z.enum(['active', 'archived']).optional(),
    },
    annotations: { title: 'Change a project', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'update_project' }, (ctx) => updateProject(ctx.db, args.project, {
    name: args.name, description: args.description, private: args.private, status: args.status,
  }, ctx.actor))));

  // Состав закрытого проекта: «закрыта» перестало значить «только хозяин» — значит
  // «те, кого добавили». Добавляет человек: агенту состав не доверен, он и сам в него не входит.
  server.registerTool('add_project_member', {
    description: 'Give a person access to a closed project: they will see its items, set items there and get them in their queue. '
      + 'Only the owner of the project or an admin adds people.',
    inputSchema: { org: ORG, agent: AGENT, project: PROJECT, person: z.string().min(1).describe('A person of this organization: name, email or id') },
    annotations: { title: 'Give access to a closed project', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'add_project_member' }, (ctx) =>
    addProjectMember(ctx.db, args.project, args.person, ctx.actor))));

  server.registerTool('remove_project_member', {
    description: 'Take a person out of a closed project: its items disappear from their lists. Their own items on that project stay '
      + 'on it — removal is about access, not about who does the work.',
    inputSchema: { org: ORG, agent: AGENT, project: PROJECT, person: z.string().min(1) },
    annotations: { title: 'Take access to a closed project away', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'remove_project_member' }, (ctx) =>
    removeProjectMember(ctx.db, args.project, args.person, ctx.actor))));
}
