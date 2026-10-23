import type { Context } from 'grammy';
import { transition } from '../core/lifecycle.js';
import { loadUserSchedule, localDate, nextWorkingStart, zonedToUtc } from '../core/calendar.js';
import { t } from '../i18n/index.js';
import { dialogDb, saveDialog, userKey } from './dialog.js';
import { actInOrg, findByTelegramId, findTaskByShortId, replyInvitedRefusal, type OrgTask } from './lookup.js';
import type { InvitedMode } from '../core/invitations.js';
import type { Db } from '../db/pool.js';
import { cancelOnlyKeyboard } from './keyboards.js';
import { askSeparately, editToConfirm } from './card-view.js';
import type { ReminderAction } from './callbacks.js';

// Кнопки напоминания — спека telegram-bot, «Напоминания»: каждое закрывается одним нажатием.

function cardCtx(ctx: Context): { chatId: number; messageId: number } | null {
  const chatId = ctx.chat?.id ?? ctx.msg?.chat.id;
  const messageId = ctx.msgId;
  return chatId && messageId ? { chatId, messageId } : null;
}

/** Действие по делу с правилом приглашённого; `false` — отказано, человеку уже сказано почему. */
async function actOrRefuse(
  ctx: Context, found: OrgTask, userId: string, lang: string, mode: InvitedMode, fn: (db: Db) => Promise<unknown>,
): Promise<boolean> {
  try {
    await actInOrg(found, userId, mode, fn);
    return true;
  } catch (e) {
    if (await replyInvitedRefusal(ctx, lang, e)) return false;
    throw e;
  }
}

export async function handleReminderCallback(ctx: Context, action: ReminderAction, shortId: string): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const person = await findByTelegramId(from.id);
  if (!person) { await ctx.answerCallbackQuery(); return; }
  const found = await findTaskByShortId(person.userId, shortId);
  if (!found) { await ctx.answerCallbackQuery(); return; }
  const { task } = found;
  const actor = { kind: 'user' as const, userId: person.userId };
  const lang = person.language;
  const pos = cardCtx(ctx);

  switch (action) {
    case 'today':
      await editToConfirm(ctx, pos?.chatId, pos?.messageId, t(lang, 'reminder.today_done'));
      break;
    case 'nochange':
      await editToConfirm(ctx, pos?.chatId, pos?.messageId, t(lang, 'reminder.today_done'));
      break;
    case 'tomorrow': {
      // Перенос на завтра — срок, названный самим человеком: действие работы.
      await actOrRefuse(ctx, found, person.userId, lang, 'work', async (db) => {
        const schedule = await loadUserSchedule(db, person.userId);
        const today = localDate(new Date(), schedule.tz);
        const [y, m, d] = today.split('-').map(Number) as [number, number, number];
        const tomorrow = new Date(Date.UTC(y, m - 1, d + 1));
        const date = `${tomorrow.getUTCFullYear()}-${String(tomorrow.getUTCMonth() + 1).padStart(2, '0')}-${String(tomorrow.getUTCDate()).padStart(2, '0')}`;
        await transition(db, task.id, 'postpone', actor, { postponeTo: date });
        await editToConfirm(ctx, pos?.chatId, pos?.messageId, t(lang, 'postpone.done', { date }));
      });
      break;
    }
    case 'nottoday': {
      await actOrRefuse(ctx, found, person.userId, lang, 'other', async (db) => {
        const schedule = await loadUserSchedule(db, person.userId);
        const today = localDate(new Date(), schedule.tz);
        const [y, m, d] = today.split('-').map(Number) as [number, number, number];
        const tomorrowMidnight = zonedToUtc(y, m, d + 1, 0, 0, schedule.tz);
        const nextStart = nextWorkingStart(schedule, tomorrowMidnight);
        await db.query('update tasks set snoozed_until = $2 where id = $1', [task.id, nextStart]);
        await editToConfirm(ctx, pos?.chatId, pos?.messageId, t(lang, 'reminder.not_today_done'));
      });
      break;
    }
    case 'cant': {
      const ask = await askSeparately(ctx, t(lang, 'reminder.cant_ask'), cancelOnlyKeyboard(lang));
      await dialogDb((db) => saveDialog(db, userKey(from.id), { state: 'await_reminder_cant', data: { shortId, orgId: found.orgId, version: task.version, ...pos, ...ask } }));
      await ctx.answerCallbackQuery();
      return;
    }
    default:
      break;
  }
  await ctx.answerCallbackQuery();
}

export async function handleReminderCantText(ctx: Context, dialogData: Record<string, unknown>, text: string): Promise<void> {
  const from = ctx.from!;
  const person = await findByTelegramId(from.id);
  if (!person) return;
  const found = await findTaskByShortId(person.userId, dialogData.shortId as string);
  await dialogDb((db) => saveDialog(db, userKey(from.id), { state: 'idle', data: {} }));
  if (!found) return;
  // Отправленный вопрос — действие работы: у компании, куда лишь позвали, он и принимает приглашение.
  if (!(await actOrRefuse(ctx, found, person.userId, person.language, 'work',
    (db) => transition(db, found.task.id, 'question', { kind: 'user', userId: person.userId }, { text })))) return;
  await editToConfirm(ctx, dialogData.chatId as number | undefined, dialogData.messageId as number | undefined, t(person.language, 'question.sent'), dialogData);
}
