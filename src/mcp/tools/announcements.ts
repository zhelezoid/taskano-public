import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AppError } from '../../core/errors.js';
import { withIdempotency } from '../../core/idempotency.js';
import { resolvePersonRef } from '../../core/people.js';
import {
  AGENT_DAILY_LIMIT, ALERT_AGENT_DAILY_LIMIT, ALERT_DEFAULTS, ALERT_KEY_MAX_LENGTH, ALERT_OPEN_LIMIT, alertStatus, announcementStatus,
  ANNOUNCEMENT_MAX_LENGTH, MAX_NAMED_RECIPIENTS, ORG_DAILY_LIMIT, raiseAlert, REMINDER_LIMIT, resolveAlert, sendAnnouncement,
} from '../../core/announcements.js';
import { type CallerCtx, inToolCtx, runTool, untrusted } from '../context.js';
import { ORG, AGENT } from './orientation.js';

// Группа «Объявления» (спека announcements): правило или новость, которую люди обязаны прочесть, —
// не задача. Подтверждение «Прочёл, подтверждаю» ставят сами получатели в боте или в приложении.
// Тревога (спека announcement-alerts) — объявление, которое повторяется по ключу, пока событие не наступит.

export function registerAnnouncementTools(server: McpServer, caller: CallerCtx): void {
  server.registerTool('send_announcement', {
    description: 'Send an announcement to one person, several people or everyone ("all") in the organization: a rule or a notice '
      + 'to read, not a task — there is nothing to do or hand in. Each recipient gets it in Telegram in their own language with the '
      + 'button "I have read it, confirmed", and in the app it stays on top of every screen until it is confirmed; whoever has not '
      + `confirmed is reminded up to ${REMINDER_LIMIT} times. The author is never a recipient, also when an agent sends for them. "all" fixes the list of active members at the moment of `
      + 'sending, so a person who joins later does not get it. Owner or admin only; an agent acts with the rights of its owner. '
      + 'idempotency_key is required: the same key returns the announcement already sent instead of a second one. '
      + 'An announcement cannot be edited or withdrawn — send a new one instead. Not available in the personal space. '
      + `Limits per 24 hours: ${ORG_DAILY_LIMIT} announcements per organization, ${AGENT_DAILY_LIMIT} per agent.`,
    inputSchema: {
      org: ORG,
      agent: AGENT,
      text: z.string().min(1).max(ANNOUNCEMENT_MAX_LENGTH).describe(`The announcement itself, plain text, up to ${ANNOUNCEMENT_MAX_LENGTH} characters`),
      to: z.union([z.literal('all'), z.array(z.string().min(1)).min(1).max(MAX_NAMED_RECIPIENTS)])
        .describe(`"all" — every active member, or a list of up to ${MAX_NAMED_RECIPIENTS} people: name, email or id, as for a task assignee`),
      idempotency_key: z.string().min(1),
    },
    annotations: { title: 'Send an announcement', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'send_announcement' }, (ctx) => {
    // «Личное» — закрытая доска человека внутри компании (спека projects-stage2): объявлять там некому.
    if (args.org === 'personal') throw new AppError('validation_failed', 'An announcement cannot be sent in the personal space — there is nobody to announce to');
    const actorKey = ctx.agent?.id ?? ctx.userId;
    return withIdempotency(ctx.db, actorKey, args.idempotency_key, args, async () => {
      let to: 'all' | string[] = 'all';
      if (args.to !== 'all') {
        to = [];
        for (const ref of args.to) to.push(await resolvePersonRef(ctx.db, ref));
      }
      const sent = await sendAnnouncement(ctx.db, { text: args.text, to }, ctx.actor);
      return { announcement_id: sent.announcement_id, recipients: sent.recipients.map((r) => ({ user_id: r.user_id, name: untrusted(r.name) })) };
    });
  })));

  server.registerTool('raise_alert', {
    description: 'Raise an alert: an announcement that keeps coming back until the thing it is about changes — for a watcher that sees '
      + 'something stuck (a delivery stage that does not move) and must not be ignored. Identified by key, the watcher\'s own stable id of '
      + 'the event. Each recipient gets the first round at once, then rounds repeat on their working day, spaced evenly across their '
      + `working hours: per_day times a day (default ${ALERT_DEFAULTS.per_day}), and once the alert has been open for escalate_after_days `
      + `days (default ${ALERT_DEFAULTS.escalate_after_days}) — escalated_per_day times a day (default ${ALERT_DEFAULTS.escalated_per_day}). `
      + 'Every round looks like an announcement: full screen in the app and the button "I have read it, confirmed" in Telegram, in the '
      + 'recipient\'s language. Confirming a round does NOT stop the repeats — only closing the alert does. Calling it again while an alert '
      + 'with this key is open does not create a second one and does not send an extra round: it replaces the text (the next round carries '
      + 'it), and recipients, frequency and opening time stay as they were — so it is safe to call on every pass of the watcher. '
      + '"all" fixes the list of active members at the moment of raising; the author is a recipient only when named explicitly in a list. '
      + 'Owner or admin only; an agent acts with the rights of its owner. Not available in the personal space. '
      + `Limits: ${ALERT_OPEN_LIMIT} open alerts per organization, ${ALERT_AGENT_DAILY_LIMIT} new alerts per agent per 24 hours.`,
    inputSchema: {
      org: ORG,
      agent: AGENT,
      key: z.string().min(1).max(ALERT_KEY_MAX_LENGTH).describe(`Stable id of the event on the watcher's side, e.g. "shipment-stage:ORD-1:in_transit", up to ${ALERT_KEY_MAX_LENGTH} characters`),
      text: z.string().min(1).max(ANNOUNCEMENT_MAX_LENGTH).describe(`What to say: what is stuck, for how long, whose it is, which fact is awaited; plain text, up to ${ANNOUNCEMENT_MAX_LENGTH} characters`),
      to: z.union([z.literal('all'), z.array(z.string().min(1)).min(1).max(MAX_NAMED_RECIPIENTS)])
        .describe(`"all" — every active member except the author, or a list of up to ${MAX_NAMED_RECIPIENTS} people: name, email or id, as for a task assignee`),
      per_day: z.number().int().min(1).max(4).optional().describe(`Rounds per working day at first, 1 to 4 (default ${ALERT_DEFAULTS.per_day})`),
      escalated_per_day: z.number().int().min(1).max(4).optional().describe(`Rounds per working day after escalation, from per_day to 4 (default ${ALERT_DEFAULTS.escalated_per_day})`),
      escalate_after_days: z.number().int().min(1).max(30).optional().describe(`Days open before the frequency rises, 1 to 30 (default ${ALERT_DEFAULTS.escalate_after_days})`),
    },
    annotations: { title: 'Raise a repeating alert', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'raise_alert' }, async (ctx) => {
    if (args.org === 'personal') throw new AppError('validation_failed', 'An alert cannot be raised in the personal space — there is nobody to alert');
    let to: 'all' | string[] = 'all';
    // У открытой тревоги список уже зафиксирован и `to` не читается: сторож зовёт подъём на каждом проходе,
    // и ушедший из компании человек в его списке не должен ронять обновление текста.
    const open = (await ctx.db.query('select 1 from announcement_alerts where key = $1 and resolved_at is null', [args.key.trim()])).rowCount;
    if (args.to !== 'all' && !open) {
      to = [];
      for (const ref of args.to) to.push(await resolvePersonRef(ctx.db, ref));
    }
    const raised = await raiseAlert(ctx.db, {
      key: args.key, text: args.text, to, per_day: args.per_day, escalated_per_day: args.escalated_per_day, escalate_after_days: args.escalate_after_days,
    }, ctx.actor);
    return { alert_id: raised.alert_id, created: raised.created, recipients: raised.recipients.map((r) => ({ user_id: r.user_id, name: untrusted(r.name) })) };
  })));

  server.registerTool('resolve_alert', {
    description: 'Close an alert by its key: the event it was about has happened (the stage moved), so the rounds stop and a round not yet '
      + 'confirmed disappears from the recipients\' screens. No open alert with this key is not an error — the answer is resolved: false, so '
      + 'a watcher can call it on every pass. Raising the same key again later opens a new alert. Owner or admin only; an agent acts with the '
      + 'rights of its owner.',
    inputSchema: {
      org: ORG,
      agent: AGENT,
      key: z.string().min(1).max(ALERT_KEY_MAX_LENGTH).describe('The key the alert was raised with'),
      reason: z.string().max(500).optional().describe('Why it is closed, e.g. "stage moved to arrived"; up to 500 characters'),
    },
    annotations: { title: 'Close a repeating alert', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'resolve_alert' }, async (ctx) => {
    const r = await resolveAlert(ctx.db, { key: args.key, reason: args.reason }, ctx.actor);
    return { resolved: r.resolved, alert_id: r.alert_id };
  })));

  server.registerTool('announcement_status', {
    description: 'Who has confirmed an announcement: the latest announcements (up to 20), or a single one when announcement is given. '
      + 'For every recipient — the name, confirmed_at (null while not confirmed), where it was confirmed (bot or app) and how many '
      + 'reminders were sent. Rounds of repeating alerts are not listed among the announcements: the alerts field has the open alerts and '
      + 'those closed in the last 7 days — key, text, days open, rounds per day now, and for every recipient how many rounds were shown, '
      + 'when the last one was, and when and where they last confirmed. Owner or admin only; an agent acts with the rights of its owner.',
    inputSchema: {
      org: ORG,
      agent: AGENT,
      announcement: z.string().min(1).optional().describe('Id of one announcement; omit it for the latest ones'),
    },
    annotations: { title: 'Who confirmed an announcement', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: false, tool: 'announcement_status' }, async (ctx) => {
    const rows = await announcementStatus(ctx.db, ctx.actor, args.announcement);
    const alerts = await alertStatus(ctx.db, ctx.actor);
    return {
      announcements: rows.map((a) => ({
        id: a.id, text: untrusted(a.text), from: untrusted(a.from), via_agent: untrusted(a.via_agent), sent_at: a.sent_at, to_all: a.to_all,
        confirmed: a.recipients.filter((r) => r.confirmed_at).length, total: a.recipients.length,
        recipients: a.recipients.map((r) => ({
          user_id: r.user_id, name: untrusted(r.name), confirmed_at: r.confirmed_at, confirmed_via: r.confirmed_via,
          status: r.confirmed_at ? 'confirmed' : 'not_confirmed', reminded_count: r.reminded_count,
        })),
      })),
      alerts: alerts.map((a) => ({
        id: a.id, key: untrusted(a.key), text: untrusted(a.text), from: untrusted(a.from), via_agent: untrusted(a.via_agent),
        opened_at: a.opened_at, resolved_at: a.resolved_at, resolved_reason: untrusted(a.resolved_reason),
        status: a.resolved_at ? 'resolved' : 'open', days_open: a.days_open, per_day_now: a.per_day_now,
        recipients: a.recipients.map((r) => ({
          user_id: r.user_id, name: untrusted(r.name), rounds: r.rounds, last_round_at: r.last_round_at,
          last_confirmed_at: r.last_confirmed_at, last_confirmed_via: r.last_confirmed_via,
        })),
      })),
    };
  })));
}
