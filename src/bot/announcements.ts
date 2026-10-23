import type { Context } from 'grammy';
import { AppError } from '../core/errors.js';
import { confirmAnnouncementForUser } from '../core/announcements.js';
import { humanDateTime, t } from '../i18n/index.js';
import { findByTelegramId } from './lookup.js';
import { editToConfirm } from './card-view.js';

// «Прочёл, подтверждаю» под объявлением (спека announcements). Кнопка текст не затирает —
// объявление остаётся, кнопка уходит, внизу строка «Подтверждено <когда>» (`editToConfirm`).

export async function handleAnnouncementCallback(ctx: Context, announcementId: string): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const person = await findByTelegramId(from.id);
  if (!person) { await ctx.answerCallbackQuery(); return; }
  let confirmedAt: Date;
  try {
    // Повторное нажатие время не меняет: ядро отдаёт уже записанное.
    confirmedAt = (await confirmAnnouncementForUser(person.userId, announcementId, 'bot')).confirmedAt;
  } catch (e) {
    if (!(e instanceof AppError) || e.code !== 'not_found') throw e;
    await ctx.answerCallbackQuery();
    await ctx.reply(t(person.language, 'announcement.not_found'));
    return;
  }
  await editToConfirm(ctx, undefined, undefined, t(person.language, 'announcement.confirmed', {
    when: humanDateTime(person.language, new Date(confirmedAt), person.timezone),
  }));
  await ctx.answerCallbackQuery();
}
