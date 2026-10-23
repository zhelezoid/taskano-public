import type { Db } from '../db/pool.js';
import { emit } from '../core/events.js';
import { notify } from '../core/notify.js';
import { sendEmail } from '../email/send.js';
import { invitationReminderMail } from '../email/templates/invitation-reminder.js';
import { env } from '../config/env.js';
import { invitationBudgetRefusal } from '../core/invitations.js';

// Приглашение не принято: 2 дня → письмо-напоминание, 5 дней → эскалация пригласившему
// (спека step-lifecycle-and-queue, «Таймеры»; telegram-bot, «Вход»).

const REMINDER_AFTER_MS = 2 * 86400000;
const ESCALATE_AFTER_MS = 5 * 86400000;

interface InvitationRow {
  id: string; email: string; language: string | null;
  invited_by_user_id: string | null; invited_by_agent_id: string | null;
}

async function invitationOwner(db: Db, inv: InvitationRow): Promise<string | null> {
  if (inv.invited_by_agent_id) {
    const r = await db.query('select owner_user_id from agents where id = $1', [inv.invited_by_agent_id]);
    return r.rows[0]?.owner_user_id ?? null;
  }
  return inv.invited_by_user_id;
}

export async function runInvitationTimers(db: Db, now: Date): Promise<void> {
  const toRemind = (await db.query(
    `select id, email, language, invited_by_user_id, invited_by_agent_id from invitations
      where status = 'pending' and reminded_at is null and created_at <= $1`,
    [new Date(now.getTime() - REMINDER_AFTER_MS)],
  )).rows as InvitationRow[];
  for (const inv of toRemind) {
    // Напоминание — тоже письмо с домена taskano.app: в тех же потолках, что и приглашение (спека
    // open-signup). Не влезает — не шлём, но отмечаем, чтобы не пробовать каждую минуту.
    if (!(await invitationBudgetRefusal(db, now))) {
      await sendEmail(invitationReminderMail(inv.email, inv.language, env.telegramBotUsername));
      await emit(db, { type: 'invitation_reminded', data: { invitation_id: inv.id } });
    }
    await db.query('update invitations set reminded_at = $2 where id = $1', [inv.id, now]);
  }

  const toEscalate = (await db.query(
    `select id, email, language, invited_by_user_id, invited_by_agent_id from invitations
      where status = 'pending' and escalated_at is null and created_at <= $1`,
    [new Date(now.getTime() - ESCALATE_AFTER_MS)],
  )).rows as InvitationRow[];
  for (const inv of toEscalate) {
    await emit(db, { type: 'invitation_stalled', agentId: inv.invited_by_agent_id, data: { invitation_id: inv.id, email: inv.email } });
    const owner = await invitationOwner(db, inv);
    // Кого ждём — называется при показе по этому id (спека bot-messages): пустой payload давал «?».
    if (owner) {
      await notify(db, {
        userId: owner, kind: 'invitation_stalled', level: 'glance', payload: { invitation_id: inv.id }, dedupeKey: `invitation_stalled:${inv.id}`,
      });
    }
    await db.query('update invitations set escalated_at = $2 where id = $1', [inv.id, now]);
  }
}
