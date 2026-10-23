import { type Api, InlineKeyboard, Keyboard } from 'grammy';
import { env } from '../config/env.js';
import { t } from '../i18n/index.js';
import type { Task } from '../core/types.js';
import { canTransition, personActions, type PersonAction } from '../core/lifecycle.js';
import {
  CONSENT_OK, TZ_CHANGE, TZ_OK, UNIVERSAL_CANCEL, encodeAgent, encodeAnnouncement, encodeAnswer, encodeLang, encodeOwnerTask,
  encodePhotoTask, encodePostpone, encodeProposal, encodeReminder, encodeShow, encodeTakeLater, encodeTakePrompt, encodeTask, encodeTz,
  encodeVetoable, encodeWait, encodeWaitWhen, encodeWhichTask, type TakeLaterCode,
} from './callbacks.js';

// Клавиатуры бота — спека telegram-bot. Reply-клавиатура главного меню и inline-клавиатуры карточек.

/**
 * Кнопка слева от поля ввода (menu button Telegram) — открывает Mini App со списком дел.
 * Ставится на чат с текстом на языке человека; ошибка Telegram не мешает остальному ответу.
 */
export async function setAppMenuButton(api: Api, chatId: number, lang: string): Promise<void> {
  await api.setChatMenuButton({
    chat_id: chatId,
    menu_button: { type: 'web_app', text: t(lang, 'menu.app_button'), web_app: { url: `${env.publicUrl}/app/` } },
  }).catch(() => {});
}

/**
 * Кнопка прямо в приложение (спека person-presence). Кнопка слева от поля ввода есть, но её не
 * находят: человек входил в бота и так и не открывал приложения, где лежат все его дела.
 */
export function openAppKeyboard(lang: string): InlineKeyboard {
  return new InlineKeyboard().webApp(t(lang, 'btn.open_app'), `${env.publicUrl}/app/`);
}

/**
 * «Открыть задачу» — последней строкой под уведомлением о деле (спека unread-and-deeplink): уведомление
 * открывало чат, а приложение — на общем списке, и дело приходилось искать. Кнопки самого
 * уведомления остаются выше; у вида без своих кнопок клавиатура состоит из одной этой.
 * `web_app` в inline-клавиатуре работает только в личном чате — уведомления туда и идут.
 */
export function withOpenTask(keyboard: InlineKeyboard | undefined, lang: string, taskId: string | null): InlineKeyboard | undefined {
  if (!taskId) return keyboard;
  // Пустую хвостовую строку (`.row()` в конце) Telegram не примет — отбрасываем.
  const rows = (keyboard?.inline_keyboard ?? []).filter((row) => row.length > 0);
  return new InlineKeyboard([
    ...rows,
    [InlineKeyboard.webApp(t(lang, 'btn.open_task'), `${env.publicUrl}/app/?task=${encodeURIComponent(taskId)}`)],
  ]);
}

/** Одна кнопка под объявлением и его напоминанием (спека announcements). */
export function announcementKeyboard(lang: string, announcementId: string): InlineKeyboard {
  return new InlineKeyboard().text(t(lang, 'btn.announcement_confirm'), encodeAnnouncement(announcementId));
}

export function inviteConfirmKeyboard(lang: string): InlineKeyboard {
  return new InlineKeyboard().text(t(lang, 'btn.yes_its_me'), 'inv:yes').text(t(lang, 'btn.no'), 'inv:no');
}

/** «Похоже, вам удобнее на другом языке — переключить?» — пять сообщений подряд на другом языке. */
export function languageSwitchKeyboard(lang: string, targetLangCode: string): InlineKeyboard {
  return new InlineKeyboard().text(t(lang, 'btn.yes'), encodeLang(targetLangCode)).text(t(lang, 'btn.no'), UNIVERSAL_CANCEL);
}

export function languageKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🇷🇺 Русский', encodeLang('ru')).text('🇹🇷 Türkçe', encodeLang('tr')).row()
    .text('🇻🇳 Tiếng Việt', encodeLang('vi')).text('🇬🇧 English', encodeLang('en'));
}

export function timezoneConfirmKeyboard(lang: string): InlineKeyboard {
  return new InlineKeyboard().text(t(lang, 'btn.correct'), TZ_OK).text(t(lang, 'btn.change'), TZ_CHANGE);
}

export function timezonePickerKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Europe/Istanbul', encodeTz('ist')).text('Asia/Ho_Chi_Minh', encodeTz('hcm')).row()
    .text('Europe/Moscow', encodeTz('msk')).text('UTC', encodeTz('utc'));
}

export function consentKeyboard(lang: string): InlineKeyboard {
  return new InlineKeyboard().text(t(lang, 'btn.consent'), CONSENT_OK);
}

export interface CardKeyboardOpts {
  translated: boolean;
  timerRunning: boolean;
  hasRationale: boolean;
  /** Личное пространство (`kind='personal'`): своя вёрстка — «Завершить», «Перенести», «Удалить». */
  personal: boolean;
  groupPhotos?: number;              // фото дела — из рабочей группы и прикреплённые людьми (спека task-photos)
}

/** Кнопки личного пространства — подмножество того, что разрешает ядро. */
const PERSONAL_ACTIONS: readonly PersonAction[] = ['done', 'postpone'];

/**
 * Кнопки карточки (спека telegram-bot, «Карточка задачи»). Что можно сделать с делом в этом
 * статусе, решает ядро (`personActions`) — тот же список получает приложение. Своей
 * таблицы переходов бот не держит: копия однажды разошлась с ядром, и у отложенного личного дела
 * клавиатура оказалась пустой, хотя ядро разрешало перенос.
 */
export function cardKeyboard(lang: string, task: Task, opts: CardKeyboardOpts): InlineKeyboard {
  const kb = new InlineKeyboard();
  const s = task.short_id;
  const v = task.version;
  const allowed = personActions(task, opts.personal);
  // «Завершить» в боте — сдача (`submit`): ожидание закрывают кнопки списка ожиданий, а не карточка.
  const can = (a: PersonAction): boolean => allowed.includes(a) && !(a === 'done' && task.kind === 'waiting');

  if (opts.personal) {
    const row: [string, string][] = [];
    for (const a of PERSONAL_ACTIONS) {
      if (!can(a)) continue;
      row.push(a === 'done' ? [t(lang, 'btn.done'), encodeTask('done', s, v)] : [t(lang, 'btn.postpone'), encodeTask('pp', s, v)]);
    }
    for (const [text, data] of row) kb.text(text, data);
    if (row.length) kb.row();
    // «Удалить» — отмена своего дела: ядро разрешает её из любого открытого статуса. По тому же
    // признаку «дело открыто» — и «Прикрепить фото» (спека task-photos).
    if (canTransition(task.status, 'cancel')) {
      kb.text(t(lang, 'btn.delete'), encodeTask('cancel', s, v)).row().text(t(lang, 'btn.attach_photo'), encodeTask('ph', s, v));
    }
    if (opts.groupPhotos) {
      if (kb.inline_keyboard.at(-1)?.length) kb.row();
      kb.text(t(lang, 'btn.show_photos', { count: opts.groupPhotos }), encodeTask('gph', s, v));
    }
    return kb;
  }

  // «Взять» и «Остановить» — пара и одно место в ряду, как в приложении: взятое дело останавливают,
  // невзятое берут. Раньше остановки в боте не было вовсе, и вернуть дело в очередь человек мог
  // только настоящим действием — сдать, отказаться, спросить.
  // Таймер — для дела в «Сейчас»: это не переход, в таблице ядра его нет.
  const canTimer = task.status === 'active' || task.status === 'in_progress';

  const row1: [string, string][] = [];
  if (can('take')) row1.push([t(lang, 'btn.take'), encodeTask('take', s, v)]);
  if (can('stop')) row1.push([t(lang, 'btn.stop'), encodeTask('stp', s, v)]);
  if (can('done')) row1.push([t(lang, 'btn.done'), encodeTask('done', s, v)]);
  for (const [text, data] of row1) kb.text(text, data);
  if (row1.length) kb.row();

  const row2: [string, string][] = [];
  if (can('postpone')) row2.push([t(lang, 'btn.postpone'), encodeTask('pp', s, v)]);
  if (can('question')) row2.push([t(lang, 'btn.question'), encodeTask('q', s, v)]);
  if (can('unclear')) row2.push([t(lang, 'btn.unclear'), encodeTask('u', s, v)]);
  for (const [text, data] of row2) kb.text(text, data);
  if (row2.length) kb.row();

  if (canTimer) {
    kb.text(opts.timerRunning ? t(lang, 'btn.timer_stop') : t(lang, 'btn.timer_start'), encodeTask(opts.timerRunning ? 'te' : 'ts', s, v));
    kb.text(t(lang, 'btn.add_time'), encodeTask('at', s, v)).row();
  }

  // «Написать» — реплика к делу, не блокирующая работу (спека task-comments): доступна всегда.
  // Рядом — фото к делу (спека task-photos), пока дело открыто: закрытому прикреплять не к чему.
  // Открытость — по ядру: отменить можно любое открытое дело, своей таблицы статусов бот не держит.
  kb.text(t(lang, 'btn.comment'), encodeTask('cm', s, v));
  if (canTransition(task.status, 'cancel')) kb.text(t(lang, 'btn.attach_photo'), encodeTask('ph', s, v));
  kb.row();

  if (can('wait')) { kb.text(t(lang, 'btn.wait_for'), encodeTask('wf', s, v)).row(); }
  if (can('decline')) { kb.text(t(lang, 'btn.decline'), encodeTask('dec', s, v)).row(); }

  const row3: [string, string][] = [];
  if (opts.translated) row3.push([t(lang, 'btn.original'), encodeTask('orig', s, v)]);
  if (opts.hasRationale) row3.push([t(lang, 'btn.rationale'), encodeTask('rat', s, v)]);
  for (const [text, data] of row3) kb.text(text, data);

  if (opts.groupPhotos) { if (row3.length) kb.row(); kb.text(t(lang, 'btn.show_photos', { count: opts.groupPhotos }), encodeTask('gph', s, v)); }

  return kb;
}

/** «Похоже, готово — отметить?» из рабочей группы (спека group-intake). */
export function maybeDoneKeyboard(lang: string, shortId: string, version: number): InlineKeyboard {
  return new InlineKeyboard().text(t(lang, 'btn.maybe_done_yes'), encodeTask('myes', shortId, version))
    .text(t(lang, 'btn.no'), encodeTask('mno', shortId, version));
}

export function postponeMenuKeyboard(lang: string, shortId: string, version: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(lang, 'btn.postpone_tonight'), encodePostpone('tonight', shortId, version)).row()
    .text(t(lang, 'btn.postpone_tomorrow'), encodePostpone('tomorrow', shortId, version)).row()
    .text(t(lang, 'btn.postpone_dayafter'), encodePostpone('dayafter', shortId, version)).row()
    .text(t(lang, 'btn.postpone_week'), encodePostpone('week', shortId, version)).row()
    .text(t(lang, 'btn.postpone_pick'), encodePostpone('pick', shortId, version));
}

export function waitForWhenKeyboard(lang: string, shortId: string, version: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(lang, 'btn.check_tomorrow'), encodeWaitWhen('tomorrow', shortId, version))
    .text(t(lang, 'btn.check_3d'), encodeWaitWhen('3d', shortId, version))
    .text(t(lang, 'btn.check_week'), encodeWaitWhen('week', shortId, version));
}

export function waitingItemKeyboard(lang: string, shortId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(lang, 'btn.no_change'), encodeWait('nochange', shortId)).text(t(lang, 'btn.arrived'), encodeWait('arrived', shortId)).row()
    .text(t(lang, 'btn.push_1d'), encodeWait('push1', shortId)).text(t(lang, 'btn.push_3d'), encodeWait('push3', shortId))
    .text(t(lang, 'btn.push_1w'), encodeWait('push1w', shortId)).row()
    .text(t(lang, 'btn.stop_waiting'), encodeWait('stop', shortId));
}

export function listRowKeyboard(shortId: string): InlineKeyboard {
  return new InlineKeyboard().text('→', encodeShow(shortId));
}

export function answerKeyboard(lang: string, shortId: string, version: number): InlineKeyboard {
  return new InlineKeyboard().text(t(lang, 'btn.understood'), encodeAnswer('understood', shortId, version))
    .text(t(lang, 'btn.more_question'), encodeAnswer('more', shortId, version));
}

export function ownerSubmittedKeyboard(lang: string, shortId: string): InlineKeyboard {
  return new InlineKeyboard().text(t(lang, 'owner_task.accept'), encodeOwnerTask('accept', shortId))
    .text(t(lang, 'owner_task.rework'), encodeOwnerTask('rework', shortId));
}

export function ownerAnswerKeyboard(lang: string, shortId: string): InlineKeyboard {
  return new InlineKeyboard().text(t(lang, 'owner_task.answer_btn'), encodeOwnerTask('answer', shortId));
}

export function proposalKeyboard(lang: string, shortId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(lang, 'btn.proposal_go'), encodeProposal('accept', shortId))
    .text(t(lang, 'btn.proposal_later'), encodeProposal('reject', shortId))
    .text(t(lang, 'btn.proposal_own'), encodeProposal('change', shortId));
}

export function vetoableKeyboard(lang: string, shortId: string): InlineKeyboard {
  return new InlineKeyboard().text(t(lang, 'btn.rollback'), encodeVetoable(shortId));
}

export function agentKeyboard(lang: string, agentId: string, status: 'active' | 'paused'): InlineKeyboard {
  return status === 'paused'
    ? new InlineKeyboard().text(t(lang, 'btn.resume'), encodeAgent('resume', agentId))
    : new InlineKeyboard().text(t(lang, 'btn.pause'), encodeAgent('pause', agentId));
}

export function cancelOnlyKeyboard(lang: string): InlineKeyboard {
  return new InlineKeyboard().text(t(lang, 'btn.cancel'), UNIVERSAL_CANCEL);
}

export function reminderKeyboard(lang: string, shortId: string, opts: { withNoChange?: boolean } = {}): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text(t(lang, 'btn.reminder_today'), encodeReminder('today', shortId))
    .text(t(lang, 'btn.reminder_tomorrow'), encodeReminder('tomorrow', shortId)).row();
  if (opts.withNoChange) kb.text(t(lang, 'btn.reminder_nochange'), encodeReminder('nochange', shortId));
  kb.text(t(lang, 'btn.reminder_cant'), encodeReminder('cant', shortId)).text(t(lang, 'btn.reminder_not_today'), encodeReminder('nottoday', shortId));
  return kb;
}

/**
 * «Берёшь сейчас?» (спека auto-start): «Взять» и варианты «Позже» с итоговым временем на кнопке —
 * человек видит, когда бот позовёт снова, а не «через час», который ночью значит утро.
 */
export function takePromptKeyboard(lang: string, shortId: string, later: { code: TakeLaterCode; time: string }[]): InlineKeyboard {
  const kb = new InlineKeyboard().text(t(lang, 'btn.take'), encodeTakePrompt(shortId)).row();
  for (const c of later) {
    kb.text(c.code === 'tm' ? t(lang, 'btn.take_tomorrow') : t(lang, 'btn.take_later', { time: c.time }), encodeTakeLater(c.code, shortId));
  }
  return kb;
}

/** «Пора браться» — одна кнопка: позже уже выбрано. */
export function takeReminderKeyboard(lang: string, shortId: string): InlineKeyboard {
  return new InlineKeyboard().text(t(lang, 'btn.take'), encodeTakePrompt(shortId));
}

export function personalItemKeyboard(lang: string, shortId: string, version: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(lang, 'btn.done'), encodeTask('done', shortId, version)).text(t(lang, 'btn.postpone'), encodeTask('pp', shortId, version)).row()
    .text(t(lang, 'btn.delete'), encodeTask('cancel', shortId, version));
}

/** «К какому делу прикрепить?» — открытые дела человека и «Отмена» (спека task-photos). */
export function photoTaskKeyboard(lang: string, batch: string, options: { shortId: string; label: string }[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const o of options) kb.text(o.label.length > 60 ? `${o.label.slice(0, 57)}…` : o.label, encodePhotoTask(o.shortId, batch)).row();
  return kb.text(t(lang, 'btn.cancel'), encodePhotoTask('x', batch));
}

/** «К какому делу?» — по кнопке на дело, подпись «NOR-012 · название» (Telegram режет длинное сам не всегда). */
export function whichTaskKeyboard(options: { shortId: string; label: string }[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const o of options) kb.text(o.label.length > 60 ? `${o.label.slice(0, 57)}…` : o.label, encodeWhichTask(o.shortId)).row();
  return kb;
}
