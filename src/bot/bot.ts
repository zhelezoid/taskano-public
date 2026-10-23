import { restoreOrig } from './card-view.js';
import { setAppMenuButton } from './keyboards.js';
import { Bot, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { logger } from '../log.js';
import { detectLanguage } from '../ai/detect-language.js';
import { LANGS, t } from '../i18n/index.js';
import { dialogDb, getSticky, loadDialog, saveDialog, setSticky, userKey } from './dialog.js';
import { findByTelegramId } from './lookup.js';
import { touchBotSeen } from '../core/presence.js';
import { setDeliveryApi } from './deliver.js';
import { rateLimiter } from './limiter.js';
import { languageSwitchKeyboard } from './keyboards.js';
import {
  decodeAgent, decodeAnnouncement, decodeAnswer, decodeInvite, decodeLang, decodeOwnerTask, decodePhotoTask, decodePostpone, decodeProposal,
  decodeReminder, decodeShow, decodeTakePrompt, decodeTask, decodeTz, decodeVetoable, decodeWait, decodeWaitWhen, decodeWhichTask,
  CONSENT_OK, TZ_CHANGE, TZ_OK, UNIVERSAL_CANCEL,
} from './callbacks.js';
import {
  handleConsent, handleInviteDecision, handleLanguageCommand, handleLanguagePick, handleLoginCodeText,
  handleLoginEmailText, handleStartCommand, handleTimezoneChange, handleTimezoneOk, handleTimezonePick, startLoginByEmail,
} from './onboarding.js';
import {
  handleListCommand, handleNowCommand, handlePersonalCommand, handleShowCallback, handleWaitAction, handleWaitingCommand,
} from './lists.js';
import {
  cancelWaitAt, handleLoosePhoto, handlePhotoTaskCallback, handlePostponeCallback, handleTakePromptCallback, handleTaskCallback, handleWaitWhenCallback,
  handleWhichTaskCallback, routeTaskPhoto, routeTaskReply,
} from './task-actions.js';
import {
  handleAgentCallback, handleAgentsCommand, handleAnswerAckCallback, handleFeedCommand, handleOwnerAnswerText,
  handleOwnerReworkText, handleOwnerTaskCallback, handleProposalCallback, handleProposalChangeText, handleVetoableCallback,
} from './owner-flows.js';
import { handleReminderCallback, handleReminderCantText } from './reminders.js';
import { handleAnnouncementCallback } from './announcements.js';
import { decodeGroupPick, handleGroupPickCallback, handleMyChatMember, migrateGroupChat } from '../groups/link.js';
import { ingestGroupMessage } from '../groups/ingest.js';

// Сборка бота — спека telegram-bot. Все ответы — из src/i18n/*, состояние диалога — bot_dialogs.

export interface CreateBotOptions {
  token: string;
  botInfo?: UserFromGetMe;
}

const MENU_KEY_TO_ACTION: Record<string, 'now' | 'list' | 'waiting' | 'personal'> = {
  'menu.now': 'now', 'menu.list': 'list', 'menu.waiting': 'waiting', 'menu.personal': 'personal',
};

function menuAction(text: string): 'now' | 'list' | 'waiting' | 'personal' | null {
  for (const lang of LANGS) {
    for (const [key, action] of Object.entries(MENU_KEY_TO_ACTION)) if (text === t(lang, key)) return action;
  }
  return null;
}

function isLoginByEmailText(text: string): boolean {
  return LANGS.some((lang) => text === t(lang, 'btn.login_by_email'));
}

/** Пять сообщений подряд на другом (уверенно определённом) языке → один вопрос «переключить?». */
async function checkLanguageMismatch(ctx: Context, telegramUserId: number, personLang: string, text: string): Promise<void> {
  const key = userKey(telegramUserId);
  const detected = detectLanguage(text);
  if (!detected || detected === personLang) {
    await dialogDb((db) => setSticky(db, key, 'lang_count', 0));
    return;
  }
  const prevLang = await dialogDb((db) => getSticky(db, key, 'lang_lang'));
  const prevCount = ((await dialogDb((db) => getSticky(db, key, 'lang_count'))) as number | undefined) ?? 0;
  const count = prevLang === detected ? prevCount + 1 : 1;
  await dialogDb(async (db) => {
    await setSticky(db, key, 'lang_lang', detected);
    await setSticky(db, key, 'lang_count', count);
  });
  if (count >= 5) {
    await dialogDb((db) => setSticky(db, key, 'lang_count', 0));
    await ctx.reply(t(personLang, 'language.ask_switch'), { reply_markup: languageSwitchKeyboard(personLang, detected) });
  }
}

async function dispatchCallback(ctx: Context, data: string): Promise<void> {
  const task = decodeTask(data);
  if (task) return handleTaskCallback(ctx, task);
  const pp = decodePostpone(data);
  if (pp) return handlePostponeCallback(ctx, pp);
  const which = decodeWhichTask(data);
  if (which) return handleWhichTaskCallback(ctx, which.shortId);
  const photoTask = decodePhotoTask(data);
  if (photoTask) return handlePhotoTaskCallback(ctx, photoTask);
  const wfw = decodeWaitWhen(data);
  if (wfw) return handleWaitWhenCallback(ctx, wfw);
  const wait = decodeWait(data);
  if (wait) return handleWaitAction(ctx, wait.action, wait.shortId);
  const show = decodeShow(data);
  if (show) return handleShowCallback(ctx, show.shortId);
  const answer = decodeAnswer(data);
  if (answer) return handleAnswerAckCallback(ctx, answer.action, answer.shortId, answer.version);
  const owner = decodeOwnerTask(data);
  if (owner) return handleOwnerTaskCallback(ctx, owner.action, owner.shortId);
  const announcement = decodeAnnouncement(data);
  if (announcement) return handleAnnouncementCallback(ctx, announcement.announcementId);
  const proposal = decodeProposal(data);
  if (proposal) return handleProposalCallback(ctx, proposal.decision, proposal.shortId);
  const vetoable = decodeVetoable(data);
  if (vetoable) return handleVetoableCallback(ctx, vetoable.shortId);
  const agent = decodeAgent(data);
  if (agent) return handleAgentCallback(ctx, agent.action, agent.agentId);
  const takePrompt = decodeTakePrompt(data);
  if (takePrompt) return handleTakePromptCallback(ctx, takePrompt);
  const reminder = decodeReminder(data);
  if (reminder) return handleReminderCallback(ctx, reminder.action, reminder.shortId);
  const groupPick = decodeGroupPick(data);
  if (groupPick) return handleGroupPickCallback(ctx, groupPick);
  const invite = decodeInvite(data);
  if (invite) return handleInviteDecision(ctx, invite);
  const lang = decodeLang(data);
  if (lang) return handleLanguagePick(ctx, lang);
  if (data === TZ_OK) return handleTimezoneOk(ctx);
  if (data === TZ_CHANGE) return handleTimezoneChange(ctx);
  const tz = decodeTz(data);
  if (tz) return handleTimezonePick(ctx, tz);
  if (data === CONSENT_OK) return handleConsent(ctx);
  if (data === UNIVERSAL_CANCEL) return handleUniversalCancel(ctx);
  await ctx.answerCallbackQuery();
}

async function handleUniversalCancel(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const key = userKey(from.id);
  const dialog = await dialogDb((db) => loadDialog(db, key));
  // «Отмена» под карточкой дела снимает ожидание этой карточки, остальные начатые ответы ждут дальше.
  const cancelledWait = await cancelWaitAt(ctx, ctx.callbackQuery?.message?.message_id);
  if (!cancelledWait) {
    await dialogDb((db) => saveDialog(db, key, { state: 'idle', data: {} }));
    // Просьба владельца («Напишите ответ») отменена — исходному уведомлению возвращаются кнопки.
    if (dialog.state !== 'idle') await restoreOrig(ctx, dialog.data);
  }
  const person = await findByTelegramId(from.id);
  const lang = person?.language ?? from.language_code ?? 'en';
  if (dialog.state === 'idle' && !cancelledWait) { await ctx.answerCallbackQuery(); return; }
  try { await ctx.editMessageText(t(lang, 'generic.cancelled')); } catch { /* сообщение недоступно */ }
  await ctx.answerCallbackQuery();
}

// Ожидания ответа по делу исполнителя разбирает `routeTaskReply` (их может быть несколько сразу),
// здесь — диалоги, у которых ожидание одно: владелец, предложение агента, напоминание.
const TEXT_DIALOG_HANDLERS: Record<string, (ctx: Context, data: Record<string, unknown>, text: string) => Promise<void>> = {
  await_owner_rework: (ctx, d, text) => handleOwnerReworkText(ctx, d, text),
  await_owner_answer: (ctx, d, text) => handleOwnerAnswerText(ctx, d, text),
  await_proposal_change: (ctx, d, text) => handleProposalChangeText(ctx, d, text),
  await_reminder_cant: (ctx, d, text) => handleReminderCantText(ctx, d, text),
};

async function handleMessage(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from || ctx.chat?.type !== 'private') return;
  const key = userKey(from.id);
  const dialog = await dialogDb((db) => loadDialog(db, key));
  const text = ctx.message?.text ?? ctx.message?.caption ?? '';

  if (dialog.state === 'onboard_login_email') return handleLoginEmailText(ctx, text);
  if (dialog.state === 'onboard_login_code') return handleLoginCodeText(ctx, text);
  // Фото к делу (спека task-photos), чьё дело известно и без ожидания: следующее фото альбома и фото
  // ответом на карточку.
  if (await routeTaskPhoto(ctx)) return;
  // Ответ по делу — тому делу, о котором он (reply на карточку, последнее нажатие или вопрос «К какому делу?»).
  if (await routeTaskReply(ctx, dialog)) return;

  const handler = TEXT_DIALOG_HANDLERS[dialog.state];
  if (handler && text.trim()) { await handler(ctx, dialog.data, text); return; }
  // Фото или файл без ожидания: бот спрашивает, к какому делу прикрепить, а не молчит.
  if (await handleLoosePhoto(ctx)) return;
  if (handler || !text.trim()) return;
  const person = await findByTelegramId(from.id);
  if (!person) { await ctx.reply(t(from.language_code ?? 'en', 'start.unknown')); return; }

  const action = menuAction(text);
  if (action === 'now') return handleNowCommand(ctx);
  if (action === 'list') return handleListCommand(ctx);
  if (action === 'waiting') return handleWaitingCommand(ctx);
  if (action === 'personal') return handlePersonalCommand(ctx);
  if (isLoginByEmailText(text)) return startLoginByEmail(ctx);

  await checkLanguageMismatch(ctx, from.id, person.language, text);
  // Задачи ставит только агент (решение владельца 2026-09-19): свободный текст задачу не создаёт.
  await ctx.reply(t(person.language, 'hint.no_tasks_here'), { reply_markup: { remove_keyboard: true } });
  if (ctx.chat) await setAppMenuButton(ctx.api, ctx.chat.id, person.language);
}

/** Рабочая группа (спека group-intake): только приём в разбор, бот в группе молчит. */
async function handleGroupMessage(ctx: Context): Promise<void> {
  const msg = ctx.message ?? ctx.editedMessage;
  if (!msg) return;
  if (msg.migrate_to_chat_id) { await migrateGroupChat(msg.chat.id, msg.migrate_to_chat_id); return; }
  await ingestGroupMessage(msg, { edited: !ctx.message });
}

export function createBot(opts: CreateBotOptions): Bot {
  const bot = new Bot(opts.token, opts.botInfo ? { botInfo: opts.botInfo } : undefined);
  bot.api.config.use(rateLimiter);
  setDeliveryApi(bot.api);

  // Отметка «заходил в бота» (спека person-presence) — раньше всех обработчиков, чтобы её не
  // пропускал ни один путь. Только то, что человек делает руками в личном чате: сообщение, правка,
  // нажатие кнопки. В рабочую группу он пишет, не открывая бота, а `my_chat_member` приходит и тогда,
  // когда он бота блокирует, — обе отметки врали бы владельцу. Отметка — не повод терять апдейт:
  // ошибка записи уходит в лог, а сам апдейт обрабатывается дальше.
  bot.use(async (ctx, next) => {
    const byHand = Boolean(ctx.message || ctx.editedMessage || ctx.callbackQuery);
    if (byHand && ctx.from && ctx.chat?.type === 'private') {
      try {
        await touchBotSeen(ctx.from.id);
      } catch (e) {
        logger.warn({ err: e, update: ctx.update.update_id }, 'bot: отметка «заходил» не записалась');
      }
    }
    await next();
  });

  // Группы — раньше команд: /start@bot в группе не должен получить ответ в группу.
  bot.chatType(['group', 'supergroup']).on(['message', 'edited_message'], handleGroupMessage);
  bot.on('my_chat_member', handleMyChatMember);

  bot.command('start', (ctx) => handleStartCommand(ctx, String(ctx.match ?? '')));
  bot.command('language', handleLanguageCommand);
  bot.command('feed', handleFeedCommand);
  bot.command('agents', handleAgentsCommand);

  bot.on('callback_query:data', (ctx) => dispatchCallback(ctx, ctx.callbackQuery.data));
  bot.on('message', handleMessage);

  bot.catch((err) => {
    logger.error({ err: err.error, update: err.ctx.update.update_id }, 'bot: обработчик упал');
  });

  return bot;
}
