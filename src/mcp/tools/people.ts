import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type CallerCtx, inToolCtx, runTool } from '../context.js';
import { ORG, AGENT, SEEN_MARKS } from './orientation.js';
import { invitePerson, offboardPerson, resendInvitation } from '../../core/invitations.js';
import { resolvePersonRef } from '../../core/people.js';

// Группа «Люди» (спека mcp-and-oauth): пригласить (в том числе повторно — `resend`, по состоянию
// человека, спека person-presence) и вывести человека из организации. Профиль «кто он и что
// закрывает» пишет `set_person_settings(about)`.

export function registerPeopleTools(server: McpServer, caller: CallerCtx): void {
  server.registerTool('invite_person', {
    description: 'Invite a person to the organization by an email with a link to the Telegram bot. Owner or admin only; '
      + 'only the owner invites another owner. '
      + 'The email address is the only way in — a Telegram handle, a phone number or a name will not do. '
      + 'If the organization has a list of allowed domains, an address outside it is refused. '
      + 'If the email is that of an already active member, the membership does not change and no email is sent; the response '
      + 'carries ' + SEEN_MARKS + ' '
      + 'The link into the bot goes only to that email address and is not in the response: whoever opens it becomes that person '
      + 'in Taskano. If the email did not arrive, resend: a new link goes to the same address. '
      + 'resend: true — invite again, depending on where the person is. Invitation not accepted yet: a new email with a new link, and '
      + 'the previous link stops working (result invitation_resent). Accepted but never opened the app: an email and a bot message '
      + 'with a button that opens the app (app_nudge_sent; at most once a day, otherwise app_nudge_recent). Already uses the app: '
      + 'nothing is sent (already_using_app). The response says what was sent (sent: email, telegram) and, for an active member, '
      + 'the same last_seen marks.',
    inputSchema: {
      org: ORG,
      agent: AGENT,
      resend: z.boolean().optional().describe('Invite again a person already invited or already in — what is sent depends on where they are'),
      // Сообщение об ошибке — часть продукта: модель читает его и переспрашивает адрес у человека,
      // вместо того чтобы выдумать почту или пообещать приглашение, которого не будет.
      email: z.string({ error: 'An email address is required to invite someone — ask them for it and wait for the answer' }).email(
        'An invitation can only be sent to an email address — a Telegram handle, a phone number or a name will not do. '
        + 'Ask the person who is inviting them for the address.',
      ).describe('Email address of the person — the only way an invitation can reach them'),
      name: z.string().optional(), role: z.enum(['owner', 'admin', 'member', 'guest']).default('member'),
      language: z.string().optional(),
    },
    annotations: { title: 'Invite a person, or invite them again', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, (args) => runTool(() => inToolCtx<unknown>(caller, args, { write: true, tool: 'invite_person' }, ({ db, actor }) => (args.resend
    ? resendInvitation(db, args.email, actor)
    : invitePerson(db, { email: args.email, name: args.name, role: args.role, language: args.language }, actor)))));

  server.registerTool('offboard_person', {
    description: 'Offboard a person from the organization: stop their open timers, cancel their open tasks, '
      + 'notify the authors of those tasks. Only an owner or admin of the organization can do this, '
      + 'and neither the owner of the organization nor the caller themselves can be offboarded.',
    inputSchema: { org: ORG, agent: AGENT, person: z.string().min(1) },
    annotations: { title: 'Offboard a person', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'offboard_person' }, async ({ db, actor }) => {
    const userId = await resolvePersonRef(db, args.person);
    return offboardPerson(db, userId, actor);
  })));
}
