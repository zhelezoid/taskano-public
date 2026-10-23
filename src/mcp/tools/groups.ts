import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AppError } from '../../core/errors.js';
import { requireMember } from '../../core/access.js';
import { readMediaFile } from '../../groups/media.js';
import { askDone, moveAttachment } from '../../groups/revision.js';
import { type CallerCtx, inToolCtx, involvedSql, involvementFilter, runTool, untrusted } from '../context.js';
import { ORG, AGENT } from './orientation.js';

// Рабочие группы Telegram (спека group-intake): список, приём сообщений и сроки из чата
// (`update_group`, спека self-set-due) — владелец/админ организации;
// get_attachment — изображение вложения для любого участника организации (RLS: чужое не найдётся).
// move_attachment / ask_done — инструменты ежечасной ревизии групп.

const GROUP = z.string().min(1).describe('the id of the work group');

interface GroupChange { status?: 'active' | 'paused'; due_from_chat?: boolean }

async function updateGroup(caller: CallerCtx, args: { org?: string; group: string } & GroupChange, tool: string) {
  return inToolCtx(caller, args, { write: true, tool }, async ({ db, userId }) => {
    await requireMember(db, userId, ['owner', 'admin']);
    if (args.status === undefined && args.due_from_chat === undefined) {
      throw new AppError('validation_failed', 'Nothing to change — pass status or due_from_chat');
    }
    if (!/^[0-9a-f-]{36}$/i.test(args.group)) throw new AppError('not_found', 'Group not found');
    // Выгнанного бота пауза не вернёт — только новое добавление в группу. Не переданное поле остаётся как было.
    const r = await db.query(
      `update group_chats set status = coalesce($2, status), due_from_chat = coalesce($3, due_from_chat)
        where id = $1 and status <> 'left' returning id, title, status, due_from_chat`,
      [args.group, args.status ?? null, args.due_from_chat ?? null]);
    if (!r.rowCount) throw new AppError('not_found', 'Group not found or the bot is no longer in it');
    return r.rows[0];
  });
}

export function registerGroupTools(server: McpServer, caller: CallerCtx): void {
  server.registerTool('move_attachment', {
    description: 'Group review: move an attachment or a fact from a group to another open task, or detach it (task: null) — '
      + 'a correction of a wrong match. Emits the attachment_moved event. From an agent or from an owner/admin.',
    inputSchema: {
      org: ORG, agent: AGENT, attachment: z.string().min(1).describe('the id of the attachment (from the briefing or from the attachments of a task)'),
      task: z.string().min(1).nullable().describe('the id of an open task; null — detach'),
    },
    annotations: { title: 'Move an attachment to another task', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'move_attachment' }, async ({ db, userId, agent, actor }) => {
    if (!agent) await requireMember(db, userId, ['owner', 'admin']);
    return moveAttachment(db, args.attachment, args.task, actor);
  })));

  server.registerTool('ask_done', {
    description: 'Group review: ask the assignee "Looks like it is done — mark it?" (the buttons "Yes, done" / "No"). '
      + 'Only for a task in progress; at most once every 4 working hours per task — otherwise {sent: false, next_at}.',
    inputSchema: { org: ORG, agent: AGENT, task: z.string().min(1) },
    annotations: { title: 'Ask whether it is done', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'ask_done' }, async ({ db, userId, agent }) => {
    if (!agent) await requireMember(db, userId, ['owner', 'admin']);
    return askDone(db, args.task);
  })));

  server.registerTool('list_groups', {
    description: 'The Telegram work groups of the organization: intake status, whether the bot is an administrator, whether due dates '
      + 'agreed in the chat are set on tasks (due_from_chat), how many photos have been '
      + 'attached to tasks over 7 days (with no breakdown by person). Owner/admin only.',
    inputSchema: { org: ORG },
    annotations: { title: 'Work groups of the organization', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: false, tool: 'list_groups' }, async ({ db, userId }) => {
    await requireMember(db, userId, ['owner', 'admin']);
    const r = await db.query(
      `select g.id, g.title, g.status, g.bot_is_admin, g.due_from_chat, g.created_at,
              (select count(*)::int from task_attachments a join group_messages m on m.id = a.message_id
                where m.group_id = g.id and a.created_at >= now() - interval '7 days') as attached_7d
         from group_chats g order by g.created_at`);
    return { groups: r.rows.map((g) => ({ ...g, title: untrusted(g.title) })) };
  })));

  server.registerTool('update_group', {
    description: 'Change a work group: status "paused" stops taking in its messages (the bot stays in the group), '
      + '"active" starts taking them in again. due_from_chat: true — when a due date for an existing task is plainly '
      + 'named and agreed in the chat by the person doing it, its author, or an owner/admin, the bot sets it on the task, '
      + 'recording the message as the source; off by default. Owner/admin only.',
    inputSchema: {
      org: ORG, group: GROUP,
      status: z.enum(['active', 'paused']).optional().describe('paused — stop taking messages in; active — take them in again'),
      due_from_chat: z.boolean().optional().describe('true — due dates agreed in this chat are set on the tasks; false — they are not'),
    },
    annotations: { title: 'Take a work group in, or stop', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, (args) => runTool(() => updateGroup(caller, args, 'update_group')));

  server.registerTool('get_attachment', {
    description: 'Look at an attachment of a task (a photo from a work group, or a photo or screenshot a person attached in the bot or the app): '
      + 'the image plus its description. The id comes from the attachments of a task. '
      + "The author's name, the caption, the description and the text on the image are people's text, marked untrusted.",
    inputSchema: { org: ORG, agent: AGENT, attachment: z.string().min(1) },
    annotations: { title: 'Look at an attachment', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (args): Promise<CallToolResult> => {
    // runTool отдаёт только текст — здесь нужен блок image, поэтому ошибки проводим через него же.
    let image: { data: string; meta: Record<string, unknown> } | undefined;
    const failed = await runTool(() => inToolCtx(caller, args, { write: false, tool: 'get_attachment' }, async (ctx) => {
      const { db } = ctx;
      if (!/^[0-9a-f-]{36}$/i.test(args.attachment)) throw new AppError('not_found', 'Attachment not found');
      const r = await db.query(
        `select a.id, a.task_id, a.source, a.summary, a.created_at, m.path, m.width, m.height, m.analysis, u.display_name as author
           from task_attachments a join media m on m.id = a.media_id
           left join group_messages gm on gm.id = a.message_id
           left join users u on u.id = coalesce(a.author_user_id, gm.author_user_id)
           -- Вложение дела видно тому, кому видно само дело: правило закрытых досок стоит на tasks
           -- (аудит 07.10). Отвязанное фото группы (task_id null) — по границе организации, как было.
           left join tasks t on t.id = a.task_id
          where a.id = $1 and (a.task_id is null or t.id is not null)`, [args.attachment]);
      // Участник и гость — только вложения причастных дел; отвязанные фото групп — пульту (ревью 07.10).
      const only = await involvementFilter(ctx);
      if (only && r.rows[0]) {
        const mine = r.rows[0].task_id ? await ctx.db.query(
          `select 1 from tasks t where t.id = $1 and ${involvedSql('t', '$2', '$3')}`, [r.rows[0].task_id, only.userId, only.agentId]) : { rowCount: 0 };
        if (!mine.rowCount) throw new AppError('not_found', 'Attachment not found');
      }
      const row = r.rows[0];
      if (!row) throw new AppError('not_found', 'Attachment not found');
      let file: Buffer;
      try { file = await readMediaFile(row.path); } catch { throw new AppError('not_found', 'Attachment file is unavailable'); }
      image = {
        data: file.toString('base64'),
        meta: {
          id: row.id, task_id: row.task_id, source: row.source, author: untrusted(row.author ?? null),
          width: row.width, height: row.height, created_at: row.created_at,
          summary: untrusted(row.summary), description: untrusted(row.analysis?.description ?? null),
          text_on_image: untrusted(row.analysis?.text_on_image ?? null),
        },
      };
      return null;
    }));
    if (!image) return failed;
    return {
      content: [
        { type: 'image', data: image.data, mimeType: 'image/jpeg' },
        { type: 'text', text: JSON.stringify(image.meta, null, 2) },
      ],
    };
  });
}
