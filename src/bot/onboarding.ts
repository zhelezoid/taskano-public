import type { Context } from 'grammy';
import { sha256 } from '../core/crypto.js';
import { withGlobal, withSystem } from '../db/pool.js';
import { AppError } from '../core/errors.js';
import { acceptInvitation } from '../core/invitations.js';
import { issueLoginCode, verifyLoginCode } from '../core/login-codes.js';
import { ensureUserByEmail, guessCountry, guessTimezone, mayEnter } from '../core/people.js';
import { sendEmail } from '../email/send.js';
import { loginCodeMail } from '../email/templates/login-code.js';
import { isLang, t } from '../i18n/index.js';
import { clearDialog, dialogDb, loadDialog, saveDialog, userKey } from './dialog.js';
import { findByTelegramId, linkTelegramByLogin } from './lookup.js';
import { consentKeyboard, inviteConfirmKeyboard, languageKeyboard, openAppKeyboard, setAppMenuButton, timezoneConfirmKeyboard, timezonePickerKeyboard } from './keyboards.js';

// Вход в бота — спека telegram-bot, «Вход». Приглашение подтверждается («Да, это я») перед тем как
// применяется (акцепт делает `acceptInvitation`); вход по почте — тот же код входа, что и OAuth.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function tzGuess(languageCode: string | undefined): string {
  const lang = (languageCode ?? '').slice(0, 2).toLowerCase();
  return guessTimezone(guessCountry(isLang(lang) ? lang : null));
}

async function sendWelcome(ctx: Context, lang: string, orgName: string): Promise<void> {
  await ctx.reply(t(lang, 'start.welcome', { org: orgName }), { reply_markup: { remove_keyboard: true } });
  if (ctx.chat) await setAppMenuButton(ctx.api, ctx.chat.id, lang);
}

/** Найти приглашение по токену без применения (акцепт — только по «Да, это я»). */
async function peekInvitation(token: string): Promise<{ orgId: string; orgName: string; email: string } | null> {
  const hash = sha256(token);
  return withSystem(async (sys) => {
    const r = await sys.query(
      `select i.org_id, i.email, o.name as org_name from invitations i join orgs o on o.id = i.org_id
        where i.token_hash = $1 and i.status = 'pending'`,
      [hash],
    );
    if (!r.rowCount) return null;
    return { orgId: r.rows[0].org_id, orgName: r.rows[0].org_name, email: r.rows[0].email };
  });
}

export async function handleStartCommand(ctx: Context, payload: string): Promise<void> {
  const from = ctx.from;
  if (!from || !ctx.chat) return;
  const key = userKey(from.id);
  const arg = payload.trim();

  if (arg.startsWith('inv_')) {
    const token = arg.slice(4);
    const inv = await peekInvitation(token);
    if (!inv) { await ctx.reply(t(from.language_code ?? 'en', 'start.invite_not_found')); return; }
    await dialogDb((db) => saveDialog(db, key, { state: 'onboard_invite_confirm', data: { token, email: inv.email } }));
    await ctx.reply(t(from.language_code ?? 'en', 'start.confirm_email', { email: inv.email }), { reply_markup: inviteConfirmKeyboard(from.language_code ?? 'en') });
    return;
  }

  if (arg.startsWith('t_')) {
    const { handleTaskDeepLink } = await import('./lists.js');
    // `t_356` и `t_356_NOR-033`: ключ доски — для человека, дело находится по номеру.
    await handleTaskDeepLink(ctx, arg.slice(2).split('_')[0]!);
    return;
  }

  await startLoginByEmail(ctx);
}

export async function startLoginByEmail(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const key = userKey(from.id);
  const person = await findByTelegramId(from.id);
  const lang = person?.language ?? from.language_code ?? 'en';
  await dialogDb((db) => saveDialog(db, key, { state: 'onboard_login_email', data: {} }));
  await ctx.reply(t(lang, 'start.login_prompt'));
}

export async function handleInviteDecision(ctx: Context, decision: 'yes' | 'no'): Promise<void> {
  const from = ctx.from;
  const chat = ctx.chat;
  if (!from || !chat) return;
  const key = userKey(from.id);
  const dialog = await dialogDb((db) => loadDialog(db, key));
  const token = dialog.data.token as string | undefined;
  const lang = from.language_code ?? 'en';
  if (dialog.state !== 'onboard_invite_confirm' || !token) { await ctx.answerCallbackQuery(); return; }

  if (decision === 'no') {
    await dialogDb((db) => clearDialog(db, key));
    await ctx.editMessageText(t(lang, 'start.invite_declined'));
    await ctx.answerCallbackQuery();
    return;
  }

  try {
    const { userId, orgId } = await acceptInvitation(token, from.id, chat.id);
    await dialogDb((db) => saveDialog(db, key, { state: 'onboard_language', data: { userId, orgId } }));
    await ctx.editMessageText(t(lang, 'start.choose_language'), { reply_markup: languageKeyboard() });
  } catch (e) {
    await dialogDb((db) => clearDialog(db, key));
    const msg = e instanceof AppError && e.code === 'conflict' ? t(lang, 'start.invite_conflict') : t(lang, 'start.invite_not_found');
    await ctx.editMessageText(msg);
  }
  await ctx.answerCallbackQuery();
}

/** `/language` в любой момент и выбор языка при онбординге — один обработчик. */
export async function handleLanguagePick(ctx: Context, code: string): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const key = userKey(from.id);
  const dialog = await dialogDb((db) => loadDialog(db, key));

  if (dialog.state === 'onboard_language') {
    const userId = dialog.data.userId as string;
    await withGlobal((db) => db.query('update users set language = $2, country = coalesce(country, $3) where id = $1', [userId, code, guessCountry(code)]));
    const tz = tzGuess(from.language_code) || guessTimezone(guessCountry(code));
    await dialogDb((db) => saveDialog(db, key, { state: 'onboard_timezone', data: { ...dialog.data, guessedTz: tz } }));
    await ctx.editMessageText(t(code, 'start.confirm_timezone', { tz }), { reply_markup: timezoneConfirmKeyboard(code) });
    await ctx.answerCallbackQuery();
    return;
  }

  const person = await findByTelegramId(from.id);
  if (!person) { await ctx.answerCallbackQuery(); return; }
  await withGlobal((db) => db.query('update users set language = $2 where id = $1', [person.userId, code]));
  await ctx.editMessageText(t(code, 'language.changed'));
  await ctx.reply(t(code, 'language.changed'), { reply_markup: { remove_keyboard: true } });
  if (ctx.chat) await setAppMenuButton(ctx.api, ctx.chat.id, code);
  await ctx.answerCallbackQuery();
}

export async function handleLanguageCommand(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const person = await findByTelegramId(from.id);
  const lang = person?.language ?? from.language_code ?? 'en';
  await ctx.reply(t(lang, 'language.choose'), { reply_markup: languageKeyboard() });
}

export async function handleTimezoneOk(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const key = userKey(from.id);
  const dialog = await dialogDb((db) => loadDialog(db, key));
  if (dialog.state !== 'onboard_timezone') { await ctx.answerCallbackQuery(); return; }
  await finishTimezone(ctx, dialog.data.guessedTz as string);
}

export async function handleTimezoneChange(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const key = userKey(from.id);
  const dialog = await dialogDb((db) => loadDialog(db, key));
  if (dialog.state !== 'onboard_timezone') { await ctx.answerCallbackQuery(); return; }
  const lang = (await withGlobal((db) => db.query('select language from users where id = $1', [dialog.data.userId]))).rows[0]?.language ?? 'en';
  await ctx.editMessageText(t(lang, 'start.pick_timezone'), { reply_markup: timezonePickerKeyboard() });
  await ctx.answerCallbackQuery();
}

export async function handleTimezonePick(ctx: Context, tz: string): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const key = userKey(from.id);
  const dialog = await dialogDb((db) => loadDialog(db, key));
  if (dialog.state !== 'onboard_timezone') { await ctx.answerCallbackQuery(); return; }
  await finishTimezone(ctx, tz);
}

async function finishTimezone(ctx: Context, tz: string): Promise<void> {
  const from = ctx.from!;
  const key = userKey(from.id);
  const dialog = await dialogDb((db) => loadDialog(db, key));
  const userId = dialog.data.userId as string;
  await withGlobal((db) => db.query('update users set timezone = $2 where id = $1', [userId, tz]));
  const lang = (await withGlobal((db) => db.query('select language from users where id = $1', [userId]))).rows[0]?.language ?? 'en';
  await dialogDb((db) => saveDialog(db, key, { state: 'onboard_consent', data: dialog.data }));
  await ctx.editMessageText(t(lang, 'start.consent'), { reply_markup: consentKeyboard(lang) });
  await ctx.answerCallbackQuery();
}

export async function handleConsent(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const key = userKey(from.id);
  const dialog = await dialogDb((db) => loadDialog(db, key));
  if (dialog.state !== 'onboard_consent') { await ctx.answerCallbackQuery(); return; }
  const userId = dialog.data.userId as string;
  const orgId = dialog.data.orgId as string;
  const org = await withGlobal(async (db) => {
    await db.query('update users set consent_at = coalesce(consent_at, now()) where id = $1', [userId]);
    return db.query('select name, language from orgs where id = $1', [orgId]);
  });
  const lang = (await withGlobal((db) => db.query('select language from users where id = $1', [userId]))).rows[0]?.language ?? 'en';
  await dialogDb((db) => clearDialog(db, key));
  await ctx.editMessageText(t(lang, 'start.welcome', { org: org.rows[0]?.name ?? '' }));
  await ctx.reply(t(lang, 'start.welcome', { org: org.rows[0]?.name ?? '' }), { reply_markup: { remove_keyboard: true } });
  if (ctx.chat) await setAppMenuButton(ctx.api, ctx.chat.id, lang);
  // Одна кнопка к своему списку дел: иконка приложения на домашнем экране телефона. И кнопка прямо в
  // приложение (спека person-presence): кнопку слева от поля ввода не находят, а шаг 2 письма-
  // приглашения обещает именно эту — «Открыть приложение» сразу после входа.
  await ctx.reply(t(lang, 'menu.home_screen'), { reply_markup: openAppKeyboard(lang) });
  await ctx.answerCallbackQuery();
}

export async function handleLoginEmailText(ctx: Context, text: string): Promise<void> {
  const from = ctx.from!;
  const key = userKey(from.id);
  const lang = from.language_code ?? 'en';
  const email = text.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) { await ctx.reply(t(lang, 'start.email_invalid')); return; }
  if (!(await withGlobal((db) => mayEnter(db, email)))) { await ctx.reply(t(lang, 'start.closed')); return; }
  try {
    const code = await withGlobal((db) => issueLoginCode(db, email, 'bot'));
    await sendEmail(loginCodeMail(email, code, lang));
    await dialogDb((db) => saveDialog(db, key, { state: 'onboard_login_code', data: { email } }));
    await ctx.reply(t(lang, 'start.code_sent', { email }));
  } catch (e) {
    // Тексты ошибок сервера — английские (для агента); человеку в боте отвечаем на его языке.
    if (e instanceof AppError) { await ctx.reply(t(lang, 'start.code_wait')); return; }
    throw e;
  }
}

export async function handleLoginCodeText(ctx: Context, text: string): Promise<void> {
  const from = ctx.from!;
  const chat = ctx.chat!;
  const key = userKey(from.id);
  const dialog = await dialogDb((db) => loadDialog(db, key));
  const email = dialog.data.email as string;
  const lang = from.language_code ?? 'en';
  const code = text.trim().replace(/\s/g, '');
  const ok = await withGlobal((db) => verifyLoginCode(db, email, code, { purpose: 'bot' }));
  if (!ok) { await ctx.reply(t(lang, 'start.code_invalid')); return; }
  if (!(await withGlobal((db) => mayEnter(db, email)))) { await ctx.reply(t(lang, 'start.closed')); return; }
  const { user } = await withGlobal((db) => ensureUserByEmail(db, email, { verified: true }));
  try {
    await linkTelegramByLogin(user.id, from.id, chat.id);
  } catch (e) {
    await dialogDb((db) => clearDialog(db, key));
    await ctx.reply(e instanceof AppError ? t(lang, 'start.invite_conflict') : t(lang, 'error.generic'));
    return;
  }
  await dialogDb((db) => clearDialog(db, key));
  const person = await findByTelegramId(from.id);
  const personLang = person?.language ?? lang;
  await ctx.reply(t(personLang, 'start.linked', { email }), { reply_markup: { remove_keyboard: true } });
  if (ctx.chat) await setAppMenuButton(ctx.api, ctx.chat.id, personLang);
  // Вошедший по почте получает тот же совет с кнопкой в приложение, что и принявший приглашение.
  await ctx.reply(t(personLang, 'menu.home_screen'), { reply_markup: openAppKeyboard(personLang) });
}
