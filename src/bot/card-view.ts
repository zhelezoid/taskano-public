import type { Context } from 'grammy';
import type { InlineKeyboardMarkup, MessageEntity } from 'grammy/types';
import { withSystem, type Db } from '../db/pool.js';
import type { Task } from '../core/types.js';
import { groupPhotoCount, loadCardSources, movedLineKey, renderCardText } from './cards.js';
import { companyNameIfMany } from '../core/people.js';
import { taskKey, taskProject } from '../core/projects.js';
import { cardKeyboard } from './keyboards.js';
import { t } from '../i18n/index.js';

// Отправка/правка карточки задачи — общее между «Список»/«Сейчас»/«Ожидания» и обработчиками
// кнопок карточки (спека telegram-bot: «одно сообщение, правится на месте»).

async function planLabel(db: Db, task: Task): Promise<string | null> {
  if (!task.plan_id) return null;
  const r = await db.query('select goal from plans where id = $1', [task.plan_id]);
  return r.rows[0]?.goal ?? null;
}

/** Строка «Проект: …» (спека projects). Название проекта не переводится: его дал человек. */
async function projectLabel(db: Db, task: Task): Promise<string | null> {
  const project = await taskProject(db, task.project_id);
  if (!project) return null;
  // Обозначение дела внутри проекта: «Разное · NOR-012» (спека projects-stage2). По нему дело
  // называют вслух и ищут — в карточке оно должно быть видно рядом с проектом.
  const key = taskKey(project.key, task.number);
  return key ? `${project.name} · ${key}` : project.name;
}

async function isTimerRunning(db: Db, taskId: string): Promise<{ running: boolean; startedAt: Date | null }> {
  const r = await db.query(`select started_at from time_entries where task_id = $1 and ended_at is null and source = 'timer'`, [taskId]);
  return { running: !!r.rowCount, startedAt: r.rows[0]?.started_at ?? null };
}

/**
 * Учёт идёт по делу другой компании (спека multi-company-person, п.8): таймер у человека один на все
 * компании, а RLS этой транзакции чужой записи не покажет. Системным соединением узнаём только
 * название компании, где он идёт, — ни дела, ни времени. Личное пространство не называем: его имя —
 * служебное, а не то, что человек узнает (как в `companyNameIfMany`).
 */
async function timerCompanyElsewhere(userId: string, orgId: string): Promise<string | null> {
  return withSystem(async (sys) => (await sys.query(
    `select o.name from time_entries te join orgs o on o.id = te.org_id
      where te.user_id = $1 and te.ended_at is null and te.source = 'timer' and te.org_id <> $2
        and o.kind = 'company' limit 1`,
    [userId, orgId])).rows[0]?.name as string | undefined ?? null);
}

export interface BuiltCard { text: string; keyboard: ReturnType<typeof cardKeyboard>; translated: boolean }

/** `viewerUserId` — тот, кому карточка показывается: по нему решается, называть ли компанию. */
export interface CardOpts { sourceLang: string; personal: boolean; viewerUserId: string }

export async function buildCard(db: Db, task: Task, lang: string, opts: CardOpts): Promise<BuiltCard> {
  const plan = await planLabel(db, task);
  const project = await projectLabel(db, task);
  const groupPhotos = await groupPhotoCount(db, task.id);
  const sources = await loadCardSources(db, task.id);
  // Название компании — свойство смотрящего, а не дела (спека multi-company): у кого
  // компания одна, тот его не увидит. В личном пространстве называть нечего.
  const company = opts.personal ? null : await companyNameIfMany(db, opts.viewerUserId);
  const card = await renderCardText(db, task, lang, {
    sourceLang: opts.sourceLang, companyLabel: company, planLabel: plan, projectLabel: project, groupPhotos, sources,
  });
  const timer = await isTimerRunning(db, task.id);
  const moved = await movedLineKey(db, task.id);
  let text = card.text;
  if (timer.running && timer.startedAt) {
    const time = new Date(timer.startedAt).toISOString().slice(11, 16);
    text += `\n${t(lang, 'card.timer_running', { time })}`;
  } else if (!opts.personal && task.assignee_user_id === opts.viewerUserId) {
    // Иначе карточка молчала, а «Стоп» со старой карточки отвечал «таймера нет» — он шёл в другой компании.
    const elsewhere = await timerCompanyElsewhere(opts.viewerUserId, task.org_id);
    if (elsewhere) text += `\n${t(lang, 'card.timer_elsewhere', { org: elsewhere })}`;
  }
  const keyboard = cardKeyboard(lang, task, {
    // История карточки — та же кнопка «Как агент к этому пришёл»: переезд между пространствами
    // тоже её содержимое, поэтому у перенесённого дела кнопка есть и без обоснования.
    translated: card.translated, timerRunning: timer.running, hasRationale: !!(task.rationale || task.plan_id || moved), personal: opts.personal,
    groupPhotos,
  });
  return { text, keyboard, translated: card.translated };
}

export async function sendCard(ctx: Context, db: Db, task: Task, lang: string, opts: CardOpts): Promise<void> {
  const card = await buildCard(db, task, lang, opts);
  await ctx.reply(card.text, { reply_markup: card.keyboard });
}

export async function editCard(ctx: Context, db: Db, task: Task, lang: string, opts: CardOpts): Promise<void> {
  const card = await buildCard(db, task, lang, opts);
  try {
    await ctx.editMessageText(card.text, { reply_markup: card.keyboard });
  } catch {
    await ctx.reply(card.text, { reply_markup: card.keyboard });
  }
}

export async function replyStale(ctx: Context, lang: string): Promise<void> {
  await ctx.reply(t(lang, 'card.stale'));
}

/** Правка карточки по явным chat_id/message_id — когда ответ пришёл отдельным текстовым
 *  сообщением, а не нажатием на кнопку исходной карточки (диалоги «Готово», «Отказаться» и т.п.). */
export async function editCardAt(
  ctx: Context, chatId: number, messageId: number, db: Db, task: Task, lang: string, opts: CardOpts,
): Promise<void> {
  const card = await buildCard(db, task, lang, opts);
  try {
    await ctx.api.editMessageText(chatId, messageId, card.text, { reply_markup: card.keyboard });
  } catch {
    await ctx.reply(card.text, { reply_markup: card.keyboard });
  }
}

/**
 * Бот — журнал того, что приходило (07.10): уведомление и карточку кнопкой не затираем.
 * Было: «Ответить» превращало вопрос в «Напишите ответ», потом в «Ответ отправлен» — пуш на телефоне
 * показал вопрос, а в чате его уже не было. Теперь исходный текст остаётся, кнопки снимаются, итог
 * дописывается строкой «✓ …». Текст и разметку исходного берём из нажатия; для диалогов (ответ
 * приходит отдельным сообщением) они хранятся в данных ожидания.
 */
export interface Orig { origText?: string; origEntities?: MessageEntity[]; origMarkup?: InlineKeyboardMarkup }

const NO_BUTTONS: InlineKeyboardMarkup = { inline_keyboard: [] };
const CONFIRM_MARK = '✓';
const TEXT_LIMIT = 4096;

export function origOf(ctx: Context): Orig {
  const m = ctx.callbackQuery?.message;
  if (!m || !('text' in m) || !m.text) return {};
  return { origText: m.text, origEntities: m.entities, origMarkup: m.reply_markup };
}

/**
 * Просьба написать текст («Напишите ответ», «Почему отказ») — отдельным сообщением с «Отмена»; у
 * исходного снимаются кнопки, текст остаётся. Возвращает то, что надо положить в данные ожидания.
 */
export async function askSeparately(ctx: Context, text: string, keyboard: InlineKeyboardMarkup): Promise<Orig & { askId?: number }> {
  const orig = origOf(ctx);
  if (orig.origText) {
    try { await ctx.editMessageReplyMarkup({ reply_markup: NO_BUTTONS }); } catch { /* сообщение недоступно */ }
  }
  const m = await ctx.reply(text, { reply_markup: keyboard });
  return { ...orig, askId: m.message_id };
}

function origFromData(d: Record<string, unknown> | undefined): Orig {
  if (!d || typeof d.origText !== 'string') return {};
  return { origText: d.origText, origEntities: d.origEntities as MessageEntity[] | undefined, origMarkup: d.origMarkup as InlineKeyboardMarkup | undefined };
}

/** «Отмена» просьбы: исходному сообщению возвращаются его кнопки. */
export async function restoreOrig(ctx: Context, d: Record<string, unknown> | undefined): Promise<void> {
  const o = origFromData(d);
  const chatId = d?.chatId as number | undefined;
  const messageId = d?.messageId as number | undefined;
  if (!o.origMarkup || !chatId || !messageId) return;
  try { await ctx.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: o.origMarkup }); } catch { /* сообщение недоступно */ }
}

/**
 * Итог действия под исходным сообщением: текст остаётся, кнопки снимаются, внизу «✓ итог». `d` —
 * данные ожидания, когда итог пришёл отдельным сообщением (там исходный текст и id просьбы).
 * Исходного текста нет (старое ожидание, фото) — прежнее поведение: заменить подтверждением.
 */
export async function editToConfirm(
  ctx: Context, chatId: number | undefined, messageId: number | undefined, text: string, d?: Record<string, unknown>,
): Promise<void> {
  const o = d ? origFromData(d) : origOf(ctx);
  const chat = chatId ?? ctx.callbackQuery?.message?.chat.id;
  const msg = messageId ?? ctx.callbackQuery?.message?.message_id;
  const askId = d?.askId as number | undefined;
  if (askId && chat) {
    // Просьба своё отслужила; итог виден под исходным сообщением.
    try { await ctx.api.deleteMessage(chat, askId); } catch { /* уже удалено */ }
  }
  if (o.origText && chat && msg) {
    const full = `${o.origText}\n\n${CONFIRM_MARK} ${text}`;
    if (full.length <= TEXT_LIMIT) {
      try {
        await ctx.api.editMessageText(chat, msg, full, { entities: o.origEntities, reply_markup: NO_BUTTONS });
        return;
      } catch { /* сообщение недоступно — ответим отдельно */ }
    } else {
      try { await ctx.api.editMessageReplyMarkup(chat, msg, { reply_markup: NO_BUTTONS }); } catch { /* недоступно */ }
    }
    await ctx.reply(`${CONFIRM_MARK} ${text}`);
    return;
  }
  if (chatId && messageId) {
    try { await ctx.api.editMessageText(chatId, messageId, text); return; } catch { /* сообщение недоступно — просто ответим */ }
  } else {
    try { await ctx.editMessageText(text); return; } catch { /* нет callback-контекста */ }
  }
  await ctx.reply(text);
}
