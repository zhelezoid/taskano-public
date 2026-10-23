import { InputFile, type Context } from 'grammy';
import { AppError } from '../core/errors.js';
import { transition } from '../core/lifecycle.js';
import { RESULT_MIN_LENGTH, requiresResult } from '../core/required-result.js';
import { stopTask, takeTask } from '../core/queue.js';
import { cancelTask } from '../core/tasks.js';
import { addHumanComment, canComment } from '../core/comments.js';
import { attachImage, CLOSED_STATUSES } from '../core/attachments.js';
import { addManual, parseDuration, startTimer, stopTimer } from '../core/time.js';
import { loadUserSchedule, localDate, localDatePlusDays } from '../core/calendar.js';
import { notify } from '../core/notify.js';
import { taskKey, taskProject } from '../core/projects.js';
import type { Task } from '../core/types.js';
import { t } from '../i18n/index.js';
import {
  choosePhotoBatch, closePhotoBatch, confirmPhotoBatch, countPhotoBatch, dialogDb, finishWait, holdMessage, joinPhotoBatch, loadWaits,
  openPhotoBatch, pushWait, takeHeldMessage, userKey, type DialogState, type HeldMessage, type PhotoRef, type TaskWait,
} from './dialog.js';
import { actInOrg, findByTelegramId, findTaskByShortId, inOrg, replyInvitedRefusal, taskOrgsOf } from './lookup.js';
import type { InvitedMode } from '../core/invitations.js';
import type { Db } from '../db/pool.js';
import { askSeparately, editCard, origOf, restoreOrig, editCardAt, editToConfirm, replyStale, sendCard } from './card-view.js';
import { cancelOnlyKeyboard, photoTaskKeyboard, postponeMenuKeyboard, waitForWhenKeyboard, whichTaskKeyboard } from './keyboards.js';
import { movedLineKey, renderOriginalText } from './cards.js';
import { parseDayMonth } from './date-input.js';
import { decodeTask, type PostponeCode, type TakePromptCallback, type TaskAction, type TaskCallback, type WaitWhenCode } from './callbacks.js';
import { clockTime, laterAt } from './take-prompt.js';
import { cleanImage, downloadTelegramFile, MAX_TELEGRAM_FILE_BYTES, mediaPath, UnsupportedImageError } from '../groups/media.js';
import { logger } from '../log.js';

// Кнопки карточки — спека telegram-bot, «Карточка задачи». Каждый colback проверяет по текущему
// состоянию в базе, что нажавший — исполнитель, задача ищется по short_id среди организаций
// пользователя под withOrg.

interface Resolved { userId: string; lang: string; orgId: string; orgStatus: string; task: Task; personal: boolean }

/** Дело нажатой карточки. Само нажатие ничего не принимает: приглашение принимает
 *  действие работы в своей транзакции — `act`. */
async function resolve(ctx: Context, shortId: string): Promise<Resolved | 'no_person' | 'no_task'> {
  const from = ctx.from;
  if (!from) return 'no_task';
  const person = await findByTelegramId(from.id);
  if (!person) return 'no_person';
  const found = await findTaskByShortId(person.userId, shortId);
  if (!found) return 'no_task';
  return {
    userId: person.userId, lang: person.language, orgId: found.orgId, orgStatus: found.orgStatus, task: found.task,
    personal: found.orgKind === 'personal',
  };
}

async function guard(ctx: Context, shortId: string, version?: number): Promise<Resolved | null> {
  const r = await resolve(ctx, shortId);
  if (r === 'no_person') { await ctx.answerCallbackQuery(); return null; }
  if (r === 'no_task') {
    await ctx.answerCallbackQuery();
    await ctx.reply(t(ctx.from?.language_code ?? 'en', 'start.task_not_found'));
    return null;
  }
  if (r.task.assignee_user_id !== r.userId) {
    await ctx.answerCallbackQuery();
    await ctx.reply(t(r.lang, 'error.not_your_task'));
    return null;
  }
  if (version !== undefined && r.task.version !== version) {
    await ctx.answerCallbackQuery();
    await replyStale(ctx, r.lang);
    await inOrg(r.orgId, r.userId, (db) => sendCard(ctx, db, r.task, r.lang, { sourceLang: r.task.source_language ?? 'ru', personal: r.personal, viewerUserId: r.userId }));
    return null;
  }
  return r;
}

function cardCtx(ctx: Context): { chatId: number; messageId: number } | null {
  const chatId = ctx.chat?.id ?? ctx.msg?.chat.id;
  const messageId = ctx.msgId;
  return chatId && messageId ? { chatId, messageId } : null;
}

async function refreshCard(ctx: Context, r: Resolved, taskId: string): Promise<void> {
  await inOrg(r.orgId, r.userId, async (db) => {
    const fresh = (await db.query('select * from tasks where id = $1', [taskId])).rows[0] as Task;
    await editCard(ctx, db, fresh, r.lang, { sourceLang: fresh.source_language ?? 'ru', personal: r.personal, viewerUserId: r.userId });
  });
}

/**
 * Действие по делу — в транзакции, где правило приглашённого применено к нему же:
 * действие работы принимает приглашение, отказ его отклоняет, прочее до входа недоступно.
 * `null` — отказано: дело исчезло (приглашение отозвали) или сначала надо войти; человеку уже сказано.
 */
/** Текст подтверждения по тому, чем кончилась сдача: своё дело и личное закрываются сразу, их никто
 *  не проверяет (спека skill-roles) — «ушло на проверку» было бы неправдой. */
function doneKey(task: Task): string {
  return task.status === 'done' ? 'done.done_personal' : 'done.submitted';
}

async function act<T>(ctx: Context, r: Resolved, mode: InvitedMode, fn: (db: Db) => Promise<T>): Promise<{ value: T } | null> {
  try {
    return { value: await actInOrg(r, r.userId, mode, fn) };
  } catch (e) {
    if (await replyInvitedRefusal(ctx, r.lang, e)) return null;
    throw e;
  }
}

/**
 * Начать ожидание текста по делу. Ожиданий может быть несколько — по одному на дело (спека
 * multi-company-person, п.1). Кроме правки карточки («Напиши вопрос» с кнопкой «Отмена») человеку
 * с двумя и больше компаниями бот шлёт короткую подсказку с `force_reply`: Telegram сам делает ответ человека ответом на неё, и текст
 * уходит ровно этому делу — сколько бы дел ни ждало ответа. `force_reply` к правке карточки не
 * приложить (правка допускает только inline-кнопки), поэтому подсказка — отдельным сообщением;
 * в ожидании хранятся оба id: и карточки (reply на неё тоже считается), и подсказки.
 */
async function awaitText(ctx: Context, r: Resolved, state: string, data: Record<string, unknown>, ask: string): Promise<void> {
  // Подсказка с force_reply нужна там, где дела разных компаний лежат в одном чате: Telegram сам
  // делает ответ ответом на неё, и текст уходит ровно этому делу. Человеку в одной компании ответ без
  // reply и так уходит последнему нажатию — ему просьба с «Отмена» (одна просьба на
  // нажатие, исходное сообщение не затирается). Мультикомпании просьба и есть подсказка: кнопки у
  // исходного не снимаем — «Отмены» у force_reply не бывает, — итог допишется под ним.
  const companies = (await taskOrgsOf(r.userId)).filter((o) => o.kind === 'company').length;
  let extra: Record<string, unknown> & { askId?: number };
  if (companies > 1) {
    const prompt = await ctx.reply(`${ask}\n${t(r.lang, 'dialog.reply_prompt', { task: await taskLabel(r) })}`, {
      reply_markup: { force_reply: true, selective: true },
    });
    extra = { ...origOf(ctx), askId: prompt.message_id, promptId: prompt.message_id };
  } else {
    extra = { ...(await askSeparately(ctx, ask, cancelOnlyKeyboard(r.lang))) };
  }
  await dialogDb((db) => pushWait(db, userKey(ctx.from!.id), state, { ...data, ...extra }));
}

/** Обозначение дела вслух: «NOR-012 · название» (спека projects-stage2). */
async function taskLabel(r: { orgId: string; userId: string; task: Task }): Promise<string> {
  return inOrg(r.orgId, r.userId, async (db) => {
    const project = await taskProject(db, r.task.project_id);
    const key = taskKey(project?.key, r.task.number);
    return key ? `${key} · ${r.task.title}` : r.task.title;
  });
}

export async function handleTaskCallback(ctx: Context, cb: TaskCallback): Promise<void> {
  // «Нет», «Фото», «Написать» и «Прикрепить фото» не меняют задачу — устаревшая версия карточки им не помеха.
  if (cb.action === 'mno') return handleMaybeDoneNo(ctx, cb.shortId);
  if (cb.action === 'gph') return handleShowGroupPhotos(ctx, cb.shortId);
  if (cb.action === 'cm') return handleCommentStart(ctx, cb.shortId);
  if (cb.action === 'ph') return handlePhotoStart(ctx, cb.shortId);
  const r = await guard(ctx, cb.shortId, cb.version);
  if (!r) return;
  const actor = { kind: 'user' as const, userId: r.userId };
  const pos = cardCtx(ctx);

  switch (cb.action as TaskAction) {
    case 'take': {
      try {
        if (!(await act(ctx, r, 'work', (db) => takeTask(db, r.task.id, actor, { expectedVersion: cb.version })))) { await ctx.answerCallbackQuery(); return; }
      } catch (e) {
        if (e instanceof AppError && e.code === 'stale_version') { await replyStale(ctx, r.lang); }
        else throw e;
      }
      await refreshCard(ctx, r, r.task.id);
      await ctx.answerCallbackQuery();
      return;
    }
    case 'stp': {
      // Та же остановка, что в приложении: ядро вернёт дело в очередь и закроет таймер учёта.
      try {
        if (!(await act(ctx, r, 'other', (db) => stopTask(db, r.task.id, r.userId, { expectedVersion: cb.version })))) { await ctx.answerCallbackQuery(); return; }
      } catch (e) {
        if (e instanceof AppError && e.code === 'stale_version') { await replyStale(ctx, r.lang); }
        else throw e;
      }
      await refreshCard(ctx, r, r.task.id);
      await ctx.answerCallbackQuery();
      return;
    }
    case 'done': {
      // «Завершить» сдаёт сразу, без «пришлите результат». Исключение — дело с обязательным
      // результатом (спека required-result): бот спрашивает его здесь же, в чате, где нажали, и сдаёт
      // следующим сообщением. Просьба в другом месте — то, на чём 134 когда-то споткнулся.
      let sub: { value: Task } | null;
      try {
        sub = await act(ctx, r, 'work', (db) => transition(db, r.task.id, 'submit', actor, { expectedVersion: cb.version }));
      } catch (e) {
        const need = resultRefusal(e);
        if (!need) throw e;
        await askResult(ctx, r, cb.shortId, cb.version, need);
        await ctx.answerCallbackQuery();
        return;
      }
      if (!sub) {
        await ctx.answerCallbackQuery();
        return;
      }
      await editToConfirm(ctx, pos?.chatId, pos?.messageId, t(r.lang, doneKey(sub.value)));
      await ctx.answerCallbackQuery();
      return;
    }
    case 'pp': {
      await ctx.editMessageReplyMarkup({ reply_markup: postponeMenuKeyboard(r.lang, cb.shortId, cb.version) });
      await ctx.answerCallbackQuery();
      return;
    }
    case 'q':
    case 'u': {
      await awaitText(ctx, r, 'await_question', { shortId: cb.shortId, version: cb.version, orgId: r.orgId, kind: cb.action, ...pos }, t(r.lang, cb.action === 'q' ? 'question.ask' : 'unclear.ask'));
      await ctx.answerCallbackQuery();
      return;
    }
    case 'dec': {
      await awaitText(ctx, r, 'await_decline_reason', { shortId: cb.shortId, version: cb.version, orgId: r.orgId, ...pos }, t(r.lang, 'decline.ask_reason'));
      await ctx.answerCallbackQuery();
      return;
    }
    case 'ts': {
      if (!(await act(ctx, r, 'other', (db) => startTimer(db, r.userId, r.task.id)))) { await ctx.answerCallbackQuery(); return; }
      await refreshCard(ctx, r, r.task.id);
      await ctx.answerCallbackQuery();
      return;
    }
    case 'te': {
      // Карточка могла устареть: таймер уже остановлен или идёт по делу другой компании. Тогда не
      // падаем с «таймера нет», а перерисовываем карточку — она скажет, где идёт учёт.
      let minutes: number | null = null;
      try {
        const done = await act(ctx, r, 'other', (db) => stopTimer(db, r.userId));
        if (!done) { await ctx.answerCallbackQuery(); return; }
        minutes = done.value;
      } catch (e) {
        if (!(e instanceof AppError && e.code === 'not_found')) throw e;
      }
      await refreshCard(ctx, r, r.task.id);
      await ctx.answerCallbackQuery(minutes === null ? undefined : t(r.lang, 'timer.stopped', { minutes }));
      return;
    }
    case 'at': {
      await awaitText(ctx, r, 'await_manual_time', { shortId: cb.shortId, version: cb.version, orgId: r.orgId, ...pos }, t(r.lang, 'add_time.ask'));
      await ctx.answerCallbackQuery();
      return;
    }
    case 'orig': {
      await ctx.reply(renderOriginalText(r.lang, r.task));
      await ctx.answerCallbackQuery();
      return;
    }
    case 'rat': {
      await inOrg(r.orgId, r.userId, async (db) => {
        const lines: string[] = [];
        // Откуда дело пришло (спека task-routing) — первой строкой: это его история, а не обоснование агента.
        const moved = await movedLineKey(db, r.task.id);
        if (moved) lines.push(t(r.lang, moved));
        if (r.task.rationale) lines.push(`${t(r.lang, 'rationale.header')} ${r.task.rationale}`);
        if (r.task.plan_id) {
          const decisions = await db.query(
            'select decision from plan_decisions where plan_id = $1 order by at desc limit 5', [r.task.plan_id],
          );
          if (decisions.rowCount) {
            lines.push(t(r.lang, 'rationale.decisions_header'));
            for (const d of decisions.rows) lines.push(`• ${d.decision}`);
          }
        }
        await ctx.reply(lines.length ? lines.join('\n') : t(r.lang, 'rationale.empty'));
      });
      await ctx.answerCallbackQuery();
      return;
    }
    case 'wf': {
      await awaitText(ctx, r, 'await_wait_who', { shortId: cb.shortId, version: cb.version, orgId: r.orgId, ...pos }, t(r.lang, 'wait_for.ask_who'));
      await ctx.answerCallbackQuery();
      return;
    }
    case 'myes': return handleMaybeDoneYes(ctx, r, cb);
    case 'cancel': {
      if (!(await act(ctx, r, 'other', (db) => cancelTask(db, r.task.id, actor, null)))) { await ctx.answerCallbackQuery(); return; }
      await editToConfirm(ctx, pos?.chatId, pos?.messageId, t(r.lang, 'personal.deleted'));
      await ctx.answerCallbackQuery();
      return;
    }
    default:
      await ctx.answerCallbackQuery();
  }
}

export async function handlePostponeCallback(ctx: Context, cb: { code: PostponeCode; shortId: string; version: number }): Promise<void> {
  const r = await guard(ctx, cb.shortId, cb.version);
  if (!r) return;
  const actor = { kind: 'user' as const, userId: r.userId };
  const pos = cardCtx(ctx);

  if (cb.code === 'pick') {
    await awaitText(ctx, r, 'await_postpone_date', { shortId: cb.shortId, version: cb.version, orgId: r.orgId, ...pos }, t(r.lang, 'postpone.ask_date'));
    await ctx.answerCallbackQuery();
    return;
  }

  const days = { tonight: 0, tomorrow: 1, dayafter: 2, week: 7 }[cb.code];
  // Перенос — это новый срок, названный самим человеком: действие работы.
  await act(ctx, r, 'work', async (db) => {
    const schedule = await loadUserSchedule(db, r.userId);
    const date = localDatePlusDays(schedule, new Date(), days);
    await transition(db, r.task.id, 'postpone', actor, { postponeTo: date, expectedVersion: cb.version });
    await editToConfirm(ctx, pos?.chatId, pos?.messageId, t(r.lang, 'postpone.done', { date }));
  });
  await ctx.answerCallbackQuery();
}

export async function handleWaitWhenCallback(ctx: Context, cb: { code: WaitWhenCode; shortId: string; version: number }): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const key = userKey(from.id);
  // Ждём срок именно по этому делу — среди всех начатых ответов, а не только последнего.
  const dialog = (await dialogDb((db) => loadWaits(db, key)))
    .find((w) => w.state === 'await_wait_when' && w.data.shortId === cb.shortId);
  if (!dialog) { await ctx.answerCallbackQuery(); return; }
  const r = await guard(ctx, cb.shortId, cb.version);
  if (!r) return;
  const actor = { kind: 'user' as const, userId: r.userId };
  const pos = cardCtx(ctx);
  const ms = { tomorrow: 86400000, '3d': 3 * 86400000, week: 7 * 86400000 }[cb.code];
  const checkAt = new Date(Date.now() + ms);
  const waited = await act(ctx, r, 'other', (db) => transition(db, r.task.id, 'wait_external', actor, {
    waitingFor: dialog.data.waitingFor as string, checkAt, expectedVersion: cb.version,
  }));
  if (!waited) { await ctx.answerCallbackQuery(); return; }
  await dialogDb((db) => finishWait(db, key, cb.shortId));
  const done = t(r.lang, 'wait_for.done', { date: checkAt.toISOString().slice(0, 10) });
  if (typeof dialog.data.origText === 'string') {
    // Итог — под исходной карточкой; выбор срока своё отслужил.
    await editToConfirm(ctx, dialog.data.chatId as number | undefined, dialog.data.messageId as number | undefined, done, dialog.data);
    try { await ctx.deleteMessage(); } catch { /* уже удалено */ }
  } else {
    await editToConfirm(ctx, pos?.chatId, pos?.messageId, done);
  }
  await ctx.answerCallbackQuery();
}

// ---------------------------------------------------------------- из рабочей группы (спека group-intake)

/**
 * «Да, готово» на «Похоже, готово — отметить?»: submit с результатом — текст = summary из разбора,
 * файлы = привязанные к задаче фото из группы. Результат не того типа (нужно число, нужно фото, а
 * его нет) — обычный путь «Готово»: бот просит нужное. У дела с замком на текст, число или файл
 * пересказ группы результатом не служит: человек называет его сам.
 */
async function handleMaybeDoneYes(ctx: Context, r: Resolved, cb: TaskCallback): Promise<void> {
  const pos = cardCtx(ctx);
  const { summary, mediaIds } = await inOrg(r.orgId, r.userId, async (db) => {
    const n = await db.query(
      `select payload from notifications where task_id = $1 and user_id = $2 and kind = 'maybe_done' order by created_at desc limit 1`,
      [r.task.id, r.userId]);
    // У дела с замком (спека required-result) фото группы считаются результатом, только если их прислал
    // сам исполнитель: чужое фото в общем чате не должно закрывать замок за него.
    const a = await db.query(
      `select a.media_id from task_attachments a left join group_messages m on m.id = a.message_id
        where a.task_id = $1 and ($2::boolean is false or coalesce(a.author_user_id, m.author_user_id) = $3)
        order by a.created_at`,
      [r.task.id, requiresResult(r.task), r.task.assignee_user_id]);
    return { summary: String(n.rows[0]?.payload?.summary ?? ''), mediaIds: a.rows.map((x) => x.media_id as string) };
  });
  // Пересказ разбора группы — не слова человека: у дела с текстовым, числовым или файловым замком
  // результат он называет сам (спека required-result). Пересказ годится только фото-делу, где текст — довесок.
  const own = requiresResult(r.task) && r.task.expected_result!.type !== 'photo';
  const result = { text: own ? undefined : summary || undefined, files: mediaIds.map((id) => ({ media_id: id, kind: 'photo' })) };

  let submitted: Task | undefined;
  try {
    const sub = await act(ctx, r, 'work', (db) => transition(db, r.task.id, 'submit', { kind: 'user', userId: r.userId }, { expectedVersion: cb.version, result }));
    if (!sub) {
      await ctx.answerCallbackQuery();
      return;
    }
    submitted = sub.value;
  } catch (e) {
    if (e instanceof AppError && (e.code === 'stale_version' || e.code === 'invalid_transition')) {
      await ctx.answerCallbackQuery();
      await replyStale(ctx, r.lang);
      return;
    }
    // Разбор группы не нашёл нужного результата — просим его так же, как при «Завершить».
    const need = resultRefusal(e);
    if (need) {
      await askResult(ctx, r, cb.shortId, cb.version, need);
      await ctx.answerCallbackQuery();
      return;
    }
    throw e;
  }
  await editToConfirm(ctx, pos?.chatId, pos?.messageId, t(r.lang, submitted ? doneKey(submitted) : 'done.submitted'));
  await ctx.answerCallbackQuery();
}

async function handleMaybeDoneNo(ctx: Context, shortId: string): Promise<void> {
  const r = await guard(ctx, shortId);
  if (!r) return;
  const pos = cardCtx(ctx);
  await editToConfirm(ctx, pos?.chatId, pos?.messageId, t(r.lang, 'maybe_done.dismissed'));
  await ctx.answerCallbackQuery();
}

// ---------------------------------------------------------------- реплика к делу (спека task-comments)

/**
 * «Написать» на карточке: ждём текст реплики. Версия карточки не важна — статус она не меняет.
 * Проверку «твоё ли это дело» здесь не делаем: писать может и постановщик-человек, и владелец
 * организации (спека task-comments), а права держит ядро — `addHumanComment`.
 */
async function handleCommentStart(ctx: Context, shortId: string): Promise<void> {
  const r = await resolve(ctx, shortId);
  if (r === 'no_person') { await ctx.answerCallbackQuery(); return; }
  if (r === 'no_task') {
    await ctx.answerCallbackQuery();
    await ctx.reply(t(ctx.from?.language_code ?? 'en', 'start.task_not_found'));
    return;
  }
  // Спрашиваем право ДО приглашения писать: иначе человек набирает текст и теряет его на отказе.
  if (!(await inOrg(r.orgId, r.userId, (db) => canComment(db, r.task, r.userId)))) {
    await ctx.answerCallbackQuery();
    await ctx.reply(t(r.lang, 'error.not_your_task'));
    return;
  }
  await awaitText(ctx, r, 'await_comment', { shortId, orgId: r.orgId, ...cardCtx(ctx) }, t(r.lang, 'comment.ask'));
  await ctx.answerCallbackQuery();
}

/**
 * Текст реплики: пустое сообщение — подсказка, диалог остаётся открытым. Фото прикрепляется к тому же
 * делу (спека task-photos): с подписью — реплика и фото, без подписи — только фото, без `comment.empty`.
 */
export async function handleCommentMessage(ctx: Context, dialogData: Record<string, unknown>, held: HeldMessage): Promise<void> {
  const text = held.text;
  const r = await resolve(ctx, dialogData.shortId as string);
  if (r === 'no_person' || r === 'no_task') { await endDialog(ctx, dialogData); return; }
  const incoming = imageOfHeld(held);
  if (typeof incoming === 'string') await ctx.reply(t(r.lang, incoming === 'too_big' ? 'photo.too_big' : 'photo.only_images'));
  // Пачку альбома заводим сразу: остальные фото альбома приходят, пока пишется реплика.
  const photo = await claimPhoto(ctx, r, held);
  if (!text.trim()) {
    if (photo) {
      const done = await attachClaimed(ctx, r, photo);
      if (done === 'retry') return;
      await endDialog(ctx, dialogData);
      if (done === 'ok') await refreshCardAt(ctx, r, dialogData);
      return;
    }
    if (!incoming) await ctx.reply(t(r.lang, 'comment.empty'));
    return;
  }
  try {
    if (!(await act(ctx, r, 'work', (db) => addHumanComment(db, r.task.id, r.userId, text)))) { await endDialog(ctx, dialogData); return; }
  } catch (e) {
    if (e instanceof AppError && e.code === 'limit_exceeded') { await endDialog(ctx, dialogData); await ctx.reply(t(r.lang, 'comment.limit')); return; }
    if (e instanceof AppError && e.code === 'forbidden') { await endDialog(ctx, dialogData); await ctx.reply(t(r.lang, 'error.not_your_task')); return; }
    if (e instanceof AppError && e.code === 'validation_failed') { await ctx.reply(t(r.lang, 'comment.too_long')); return; }
    throw e;
  }
  if (photo) await attachClaimed(ctx, r, photo);
  await endDialog(ctx, dialogData);
  // Реплика задачу не закрывает — возвращаем карточку на место (как «Время»), подтверждение отдельным ответом.
  await refreshCardAt(ctx, r, dialogData);
  await ctx.reply(t(r.lang, 'comment.sent'));
}

/** Карточка, по которой шёл диалог, — на место, со свежим состоянием и кнопками. */
async function refreshCardAt(ctx: Context, r: Resolved, dialogData: Record<string, unknown>): Promise<void> {
  const chatId = (dialogData.chatId as number | undefined) ?? ctx.chat?.id;
  const messageId = dialogData.messageId as number | undefined;
  if (!chatId || !messageId) return;
  await inOrg(r.orgId, r.userId, async (db) => {
    const fresh = (await db.query('select * from tasks where id = $1', [r.task.id])).rows[0] as Task;
    await editCardAt(ctx, chatId, messageId, db, fresh, r.lang, { sourceLang: fresh.source_language ?? 'ru', personal: r.personal, viewerUserId: r.userId });
  });
}

const MAX_ALBUM = 10;   // предел sendMediaGroup
// Все фото дела, но не бесконечно: пять альбомов — больше человек в чате не листает.
const MAX_SHOWN_PHOTOS = 50;

/**
 * «Фото (N)»: все фото дела — из группы и прикреплённые людьми (спека task-photos) — альбомами по
 * десять, с диска (file_id группы боту для отправки не нужен).
 */
async function handleShowGroupPhotos(ctx: Context, shortId: string): Promise<void> {
  const r = await resolve(ctx, shortId);
  if (r === 'no_person' || r === 'no_task') { await ctx.answerCallbackQuery(); return; }
  const paths = await inOrg(r.orgId, r.userId, async (db) => (await db.query(
    `select m.path from task_attachments a join media m on m.id = a.media_id where a.task_id = $1 order by a.created_at desc limit $2`,
    [r.task.id, MAX_SHOWN_PHOTOS])).rows.map((x) => x.path as string));
  await ctx.answerCallbackQuery();
  for (let i = 0; i < paths.length; i += MAX_ALBUM) {
    const chunk = paths.slice(i, i + MAX_ALBUM);
    if (chunk.length === 1) await ctx.replyWithPhoto(new InputFile(mediaPath(chunk[0]!)));
    else await ctx.replyWithMediaGroup(chunk.map((p) => ({ type: 'photo' as const, media: new InputFile(mediaPath(p)) })));
  }
}

// ---------------------------------------------------------------- продолжения диалогов текстом

/** Ответ по делу получен (или дела больше нет): снимаем его ожидание, остальные ждут дальше. */
async function endDialog(ctx: Context, dialogData: Record<string, unknown>): Promise<void> {
  await dialogDb((db) => finishWait(db, userKey(ctx.from!.id), dialogData.shortId));
  // Просьба («Напишите…») своё отслужила — её убираем; исходное сообщение остаётся.
  const askId = dialogData.askId as number | undefined;
  const chatId = (dialogData.chatId as number | undefined) ?? ctx.chat?.id;
  if (askId && chatId) {
    try { await ctx.api.deleteMessage(chatId, askId); } catch { /* уже удалено */ }
  }
}


/** Что человек прислал — текстом, фото или файлом: для результата, который ждёт своего дела. */
export function heldFrom(ctx: Context): HeldMessage {
  const msg = ctx.message;
  const text = msg?.text ?? msg?.caption ?? '';
  const mediaGroupId = msg?.media_group_id;
  if (msg?.photo?.length) {
    const largest = msg.photo[msg.photo.length - 1]!;
    return { text, photoFileId: largest.file_id, photoUniqueId: largest.file_unique_id, mediaGroupId };
  }
  if (msg?.document) {
    return {
      text, documentFileId: msg.document.file_id, documentName: msg.document.file_name, documentUniqueId: msg.document.file_unique_id,
      documentMime: msg.document.mime_type, documentSize: msg.document.file_size, mediaGroupId,
    };
  }
  return { text };
}

/** Вопрос и «Неясно»: подпись фото — текст вопроса, само фото прикрепляется к делу (спека task-photos). */
export async function handleQuestionMessage(ctx: Context, dialogData: Record<string, unknown>, held: HeldMessage): Promise<void> {
  const text = held.text;
  const r = await resolve(ctx, dialogData.shortId as string);
  if (r === 'no_person' || r === 'no_task') { await endDialog(ctx, dialogData); return; }
  // Фото к вопросу дело не начинает (спека auto-start): вопрос — как раз «делать пока не могу».
  const photo = await claimPhoto(ctx, r, held, { withoutStart: true });
  // Фото без подписи — ещё не вопрос: прикрепляем и ждём текст дальше.
  if (photo && !text.trim()) { await attachClaimed(ctx, r, photo); return; }
  const kind = dialogData.kind as 'q' | 'u';
  const chatId = dialogData.chatId as number | undefined;
  const messageId = dialogData.messageId as number | undefined;
  try {
    if (!(await act(ctx, r, 'work', (db) => transition(db, r.task.id, kind === 'q' ? 'question' : 'unclear', { kind: 'user', userId: r.userId }, {
      expectedVersion: dialogData.version as number, text,
    })))) { await endDialog(ctx, dialogData); return; }
  } catch (e) {
    if (e instanceof AppError && e.code === 'stale_version') { await endDialog(ctx, dialogData); await replyStale(ctx, r.lang); return; }
    throw e;
  }
  await endDialog(ctx, dialogData);
  await editToConfirm(ctx, chatId, messageId, t(r.lang, kind === 'q' ? 'question.sent' : 'unclear.sent'), dialogData);
  if (photo) await attachClaimed(ctx, r, photo);
}

// ---------------------------------------------------------------- обязательный результат (спека required-result)

type ResultType = NonNullable<Task['expected_result']>['type'];

/** Отказ ядра «нужен результат»: какого вида (и, если число написано неоднозначно, подсказка) — в деталях ошибки. `null` — это другая ошибка. */
function resultRefusal(e: unknown): Need | null {
  if (!(e instanceof AppError) || e.code !== 'validation_failed') return null;
  const d = e.details as { reason?: string; type?: ResultType; hint?: string } | undefined;
  if (d?.reason !== 'result_required' || !d.type) return null;
  return { type: d.type, plainNumber: d.hint === 'number_format' };
}

interface Need { type: ResultType; plainNumber?: boolean }

// Файл в боте закрывается фото или текстом (где лежит файл, ссылка): документы не качаем (спека required-result).
const RESULT_ASK: Record<ResultType, string> = {
  text: 'result.ask_text', number: 'result.ask_number', photo: 'result.ask_photo', file: 'result.ask_file',
};

const resultAsk = (lang: string, need: Need): string =>
  t(lang, need.plainNumber ? 'result.ask_number_plain' : RESULT_ASK[need.type], { min: RESULT_MIN_LENGTH });

/** Каким видом результата просить, когда отказа ядра ещё не было (голос, стикер, вопрос вместо ответа). */
const needOf = (task: Task): Need => ({ type: task.expected_result?.type ?? 'text' });

/** Показать в подтверждении принятый результат: ошибочно пойманную фразу видно сразу, а не на приёмке. */
const RESULT_ECHO_MAX = 200;
const clip = (s: string): string => (s.length > RESULT_ECHO_MAX ? `${s.slice(0, RESULT_ECHO_MAX)}…` : s);

/** Спросить результат там, где нажали «Завершить»: следующее сообщение человека станет результатом. */
async function askResult(ctx: Context, r: Resolved, shortId: string, version: number, need: Need): Promise<void> {
  await awaitText(ctx, r, 'await_result', { shortId, version, orgId: r.orgId, ...cardCtx(ctx) }, resultAsk(r.lang, need));
}

/**
 * Ответ на «пришлите результат»: текст или число — результат, фото прикрепляется к делу и закрывает
 * замок вложением. Не хватило (короткий текст, слова вместо числа) — та же просьба ещё раз, ожидание
 * остаётся; дело не сдано, пока ядро не согласится. Не результат и вопрос вместо ответа («а что писать?»),
 * голос, стикер, документ — тоже просьба ещё раз: молчать нельзя, человек решит, что бот завис.
 */
export async function handleResultMessage(ctx: Context, dialogData: Record<string, unknown>, held: HeldMessage): Promise<void> {
  const r = await resolve(ctx, dialogData.shortId as string);
  if (r === 'no_person' || r === 'no_task') { await endDialog(ctx, dialogData); return; }
  const key = userKey(ctx.from!.id);
  // Просьбу повторяем, а ожидание продлеваем: иначе ответ на повторную просьбу попал бы под «К какому делу?».
  const askAgain = async (need: Need): Promise<void> => {
    const ask = resultAsk(r.lang, need);
    let data = dialogData;
    if (dialogData.promptId === undefined) {
      // Просьба первого раза шла с «Отмена» (человек в одной компании) — повторная тоже: иначе отменить
      // можно только кнопкой выше, до которой уже не долистать. Прежнюю убираем, чтобы кнопок не стало две.
      const m = await ctx.reply(ask, { reply_markup: cancelOnlyKeyboard(r.lang) });
      const oldAsk = dialogData.askId as number | undefined;
      const chatId = (dialogData.chatId as number | undefined) ?? ctx.chat?.id;
      if (oldAsk && chatId) {
        try { await ctx.api.deleteMessage(chatId, oldAsk); } catch { /* уже удалено */ }
      }
      data = { ...dialogData, askId: m.message_id };
    } else {
      // Мультикомпания: первая просьба — подсказка с force_reply, «Отмены» у неё не бывает.
      await ctx.reply(ask);
    }
    await dialogDb((db) => pushWait(db, key, 'await_result', data));
  };
  const incoming = imageOfHeld(held);
  if (incoming === 'too_big') { await ctx.reply(t(r.lang, 'photo.too_big')); return; }
  // Документ не картинка: скачивать его мы не берёмся — результатом он не станет.
  if (incoming === 'not_image') { await askAgain(needOf(r.task)); return; }
  const text = held.text.trim();
  // Вопрос — не результат: людям свойственно переспрашивать, что именно писать.
  const question = /[?？]$/.test(text);
  if (!incoming && (!text || question)) { await askAgain(needOf(r.task)); return; }
  // Пачку альбома заводим сразу: остальные фото альбома придут, пока дело сдаётся. Фото — результат
  // сдачи ниже: дело начнёт сама сдача (спека auto-start), и версия карточки не сдвинется.
  const photo = await claimPhoto(ctx, r, held, { withoutStart: true });
  if (photo && !photo.skip) {
    const attached = await attachOne(ctx, r, photo.ref, { withoutStart: true });
    if (!attached.ok) {
      if (attached.say) await ctx.reply(t(r.lang, attached.say));
      return;
    }
  }
  const resultText = question ? '' : text;
  try {
    const sub = await act(ctx, r, 'work', (db) => transition(db, r.task.id, 'submit', { kind: 'user', userId: r.userId }, {
      expectedVersion: dialogData.version as number, result: resultText ? { text: resultText } : undefined,
    }));
    if (!sub) { await endDialog(ctx, dialogData); return; }
    await endDialog(ctx, dialogData);
    // Принятое повторяем: если бот поймал не ту фразу, человек видит это сразу.
    const echo = resultText ? `\n${t(r.lang, 'result.accepted', { result: clip(resultText) })}` : '';
    await editToConfirm(ctx, dialogData.chatId as number | undefined, dialogData.messageId as number | undefined, `${t(r.lang, doneKey(sub.value))}${echo}`, dialogData);
  } catch (e) {
    const need = resultRefusal(e);
    if (need) { await askAgain(need); return; }
    if (e instanceof AppError && (e.code === 'stale_version' || e.code === 'invalid_transition')) {
      // Остальные фото альбома приходят уже после сдачи: им «карточка устарела» не нужна.
      await endDialog(ctx, dialogData);
      if (!held.mediaGroupId) await replyStale(ctx, r.lang);
      return;
    }
    throw e;
  }
}

export async function handleDeclineMessage(ctx: Context, dialogData: Record<string, unknown>, text: string): Promise<void> {
  const r = await resolve(ctx, dialogData.shortId as string);
  if (r === 'no_person' || r === 'no_task') { await endDialog(ctx, dialogData); return; }
  const chatId = dialogData.chatId as number | undefined;
  const messageId = dialogData.messageId as number | undefined;
  try {
    // Отказ от дела компании, куда лишь позвали, — не вход: приглашение отклоняется.
    if (!(await act(ctx, r, 'decline', (db) => transition(db, r.task.id, 'decline', { kind: 'user', userId: r.userId }, {
      expectedVersion: dialogData.version as number, text,
    })))) { await endDialog(ctx, dialogData); return; }
  } catch (e) {
    if (e instanceof AppError && e.code === 'stale_version') { await endDialog(ctx, dialogData); await replyStale(ctx, r.lang); return; }
    throw e;
  }
  await endDialog(ctx, dialogData);
  await editToConfirm(ctx, chatId, messageId, t(r.lang, 'decline.sent'), dialogData);
}

export async function handlePostponeDateMessage(ctx: Context, dialogData: Record<string, unknown>, text: string): Promise<void> {
  const r = await resolve(ctx, dialogData.shortId as string);
  if (r === 'no_person' || r === 'no_task') { await endDialog(ctx, dialogData); return; }
  const chatId = dialogData.chatId as number | undefined;
  const messageId = dialogData.messageId as number | undefined;
  const date = await inOrg(r.orgId, r.userId, async (db) => {
    const schedule = await loadUserSchedule(db, r.userId);
    return parseDayMonth(text, schedule, new Date());
  });
  if (!date) { await ctx.reply(t(r.lang, 'postpone.bad_date')); return; }
  try {
    if (!(await act(ctx, r, 'work', (db) => transition(db, r.task.id, 'postpone', { kind: 'user', userId: r.userId }, {
      postponeTo: date, expectedVersion: dialogData.version as number,
    })))) { await endDialog(ctx, dialogData); return; }
  } catch (e) {
    if (e instanceof AppError && e.code === 'stale_version') { await endDialog(ctx, dialogData); await replyStale(ctx, r.lang); return; }
    throw e;
  }
  await endDialog(ctx, dialogData);
  await editToConfirm(ctx, chatId, messageId, t(r.lang, 'postpone.done', { date }), dialogData);
}

export async function handleWaitWhoMessage(ctx: Context, dialogData: Record<string, unknown>, text: string): Promise<void> {
  const r = await resolve(ctx, dialogData.shortId as string);
  if (r === 'no_person' || r === 'no_task') { await endDialog(ctx, dialogData); return; }
  await dialogDb((db) => pushWait(db, userKey(ctx.from!.id), 'await_wait_when', { ...dialogData, waitingFor: text }));
  const version = dialogData.version as number;
  await ctx.reply(t(r.lang, 'wait_for.ask_when'), { reply_markup: waitForWhenKeyboard(r.lang, dialogData.shortId as string, version) });
}

export async function handleManualTimeMessage(ctx: Context, dialogData: Record<string, unknown>, text: string): Promise<void> {
  const r = await resolve(ctx, dialogData.shortId as string);
  if (r === 'no_person' || r === 'no_task') { await endDialog(ctx, dialogData); return; }
  const minutes = parseDuration(text);
  if (minutes === null) { await ctx.reply(t(r.lang, 'add_time.bad')); return; }
  const chatId = (dialogData.chatId as number | undefined) ?? ctx.chat?.id;
  const messageId = dialogData.messageId as number | undefined;
  const added = await act(ctx, r, 'other', async (db) => {
    await addManual(db, r.userId, r.task.id, minutes);
    if (chatId && messageId) {
      const fresh = (await db.query('select * from tasks where id = $1', [r.task.id])).rows[0] as Task;
      await editCardAt(ctx, chatId, messageId, db, fresh, r.lang, { sourceLang: fresh.source_language ?? 'ru', personal: r.personal, viewerUserId: r.userId });
    }
  });
  await endDialog(ctx, dialogData);
  if (added) await ctx.reply(t(r.lang, 'add_time.done', { minutes }));
}

// ---------------------------------------------------------------- какому делу этот текст

/**
 * Ожидания, которые ждут именно текста (или файла результата). «Когда проверить» у ожидания
 * отвечается кнопками — текст туда не идёт.
 */
const TEXT_WAITS: Record<string, (ctx: Context, data: Record<string, unknown>, held: HeldMessage) => Promise<void>> = {
  await_question: (ctx, d, h) => handleQuestionMessage(ctx, d, h),
  await_decline_reason: (ctx, d, h) => handleDeclineMessage(ctx, d, h.text),
  await_postpone_date: (ctx, d, h) => handlePostponeDateMessage(ctx, d, h.text),
  await_wait_who: (ctx, d, h) => handleWaitWhoMessage(ctx, d, h.text),
  // Результат бывает числом, текстом или фото без подписи (спека required-result).
  await_result: (ctx, d, h) => handleResultMessage(ctx, d, h),
  await_manual_time: (ctx, d, h) => handleManualTimeMessage(ctx, d, h.text),
  // Результат бывает фото или файлом без подписи, реплика без текста получает подсказку — им пустое
  // сообщение отдаём как есть (спека task-comments).
  await_comment: (ctx, d, h) => handleCommentMessage(ctx, d, h),
  // «📎 Прикрепить фото» (спека task-photos): ждём изображение, на текст — подсказка.
  await_photo: (ctx, d, h) => handlePhotoMessage(ctx, d, h),
};
const TAKES_EMPTY = new Set(['await_comment', 'await_photo', 'await_result']);

/** Ожидание старше суток не ловит текст: о начатом вчера ответе человек уже не помнит. */
const WAIT_TTL_MS = 24 * 3600_000;
/** Окно «нажимал в разных компаниях только что»: за ним ответ без reply идёт последнему нажатию. */
const ASK_WINDOW_MS = 10 * 60_000;
/**
 * Ожидания, ответ на которые меняет дело (статус, срок): без reply они применяются, только если
 * нажатие было недавно, — иначе полчаса спустя случайная фраза стала бы отказом от дела.
 */
const DESTRUCTIVE = new Set(['await_question', 'await_decline_reason', 'await_postpone_date', 'await_result']);
const DESTRUCTIVE_WINDOW_MS = 30 * 60_000;
/** Окно покороче для результата: он сдаёт дело, а спустя четверть часа случайная фраза — не результат. */
const CONFIRM_WINDOW_MS: Record<string, number> = { await_result: 10 * 60_000 };

function isTextWait(state: string): boolean {
  return Object.prototype.hasOwnProperty.call(TEXT_WAITS, state);
}

async function dispatchWait(ctx: Context, wait: Pick<TaskWait, 'state' | 'data'>, held: HeldMessage): Promise<void> {
  if (!held.text.trim() && !held.photoFileId && !held.documentFileId && !TAKES_EMPTY.has(wait.state)) return;
  await TEXT_WAITS[wait.state]!(ctx, wait.data, held);
}

/**
 * Куда отдать пришедшее сообщение (спека multi-company-person, п.1):
 *
 * - reply на подсказку или на карточку, ждущую ответа, — её делу;
 * - reply на что-то другое — не угадываем: при нескольких ожиданиях спрашиваем «К какому делу?»,
 *   при одном — говорим, что на это сообщение бот ответа не ждёт;
 * - без reply — делу последнего нажатия; если за 10 минут нажимали в делах разных компаний —
 *   «К какому делу?» (внутри одной компании последнее нажатие и есть ответ, как было всегда);
 *   ответ, меняющий дело, по нажатию старше 30 минут (результат — старше 10) — только после
 *   подтверждения тем же вопросом.
 *
 * Ожидания старше суток не считаются. `false` — живых ожиданий нет, сообщение идёт прежним путём.
 */
export async function routeTaskReply(ctx: Context, dialog: DialogState & { updatedAt?: Date }): Promise<boolean> {
  const key = userKey(ctx.from!.id);
  const now = Date.now();
  let waits = (await dialogDb((db) => loadWaits(db, key))).filter((w) => isTextWait(w.state));
  // Строка, записанная до списка ожиданий: единственное ожидание — в самом состоянии.
  if (!waits.length && isTextWait(dialog.state)) {
    waits = [{ state: dialog.state, data: dialog.data, at: (dialog.updatedAt ?? new Date(0)).toISOString() }];
  }
  waits = waits.filter((w) => now - Date.parse(w.at) <= WAIT_TTL_MS);
  if (!waits.length) return false;
  const held = heldFrom(ctx);

  const replyTo = ctx.message?.reply_to_message?.message_id;
  if (replyTo !== undefined) {
    const target = waits.find((w) => w.data.messageId === replyTo || w.data.promptId === replyTo || w.data.askId === replyTo);
    if (target) { await dispatchWait(ctx, target, held); return true; }
    if (new Set(waits.map((w) => w.data.shortId)).size >= 2) { await askWhichTask(ctx, waits, held); return true; }
    const person = await findByTelegramId(ctx.from!.id);
    await ctx.reply(t(person?.language ?? ctx.from?.language_code ?? 'en', 'dialog.not_awaited'));
    return true;
  }

  // Последним нажали не карточку исполнителя (например, «Ответить» владельца) — текст его.
  if (dialog.state !== 'idle' && !isTextWait(dialog.state)) return false;

  const recent = waits.filter((w) => now - Date.parse(w.at) <= ASK_WINDOW_MS);
  if (new Set(recent.map((w) => w.data.orgId)).size >= 2) {
    await askWhichTask(ctx, recent, held);
    return true;
  }
  const last = (isTextWait(dialog.state) && waits.find((w) => w.data.shortId === dialog.data.shortId)) || waits.at(-1)!;
  if (DESTRUCTIVE.has(last.state) && now - Date.parse(last.at) > (CONFIRM_WINDOW_MS[last.state] ?? DESTRUCTIVE_WINDOW_MS)) {
    await askWhichTask(ctx, [last], held, { confirm: true });
    return true;
  }
  await dispatchWait(ctx, last, held);
  return true;
}

/**
 * «К какому делу?» — кнопки с обозначением и названием дел, сообщение ждёт выбора. `confirm` — дело
 * одно, но ответ изменит его, а нажимали давно: та же кнопка — подтверждение.
 */
async function askWhichTask(ctx: Context, waits: TaskWait[], held: HeldMessage, opts: { confirm?: boolean } = {}): Promise<void> {
  const person = await findByTelegramId(ctx.from!.id);
  if (!person) return;
  const options: { shortId: string; label: string }[] = [];
  for (const w of [...waits].reverse()) {
    const shortId = String(w.data.shortId);
    // Взгляд, а не действие: приглашение этим списком не принимается.
    const found = await findTaskByShortId(person.userId, shortId);
    if (!found) continue;
    if (options.some((o) => o.shortId === shortId)) continue;
    options.push({ shortId, label: await taskLabel({ orgId: found.orgId, userId: person.userId, task: found.task }) });
  }
  if (!options.length) { await ctx.reply(t(person.language, 'start.task_not_found')); return; }
  // Спрашивать не о чем: живое дело осталось одно — ему, если это не подтверждение давнего нажатия.
  if (options.length < 2 && !opts.confirm) {
    await dispatchWait(ctx, waits.find((w) => String(w.data.shortId) === options[0]!.shortId)!, held);
    return;
  }
  await dialogDb((db) => holdMessage(db, userKey(ctx.from!.id), held));
  await ctx.reply(t(person.language, 'dialog.which_task'), { reply_markup: whichTaskKeyboard(options) });
}

/** Выбор дела на «К какому делу?»: отложенное сообщение уходит ровно ему. */
export async function handleWhichTaskCallback(ctx: Context, shortId: string): Promise<void> {
  const key = userKey(ctx.from!.id);
  const wait = (await dialogDb((db) => loadWaits(db, key)))
    .find((w) => String(w.data.shortId) === shortId && isTextWait(w.state) && Date.now() - Date.parse(w.at) <= WAIT_TTL_MS);
  const held = wait ? await dialogDb((db) => takeHeldMessage(db, key)) : null;
  await ctx.answerCallbackQuery();
  if (!wait || !held) return;
  try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch { /* сообщение недоступно */ }
  await dispatchWait(ctx, wait, held);
}

/**
 * «Отмена» под подсказкой: снимается ожидание той карточки, под которой нажали, остальные ждут
 * дальше. `false` — под этой карточкой ожидания по делу не было.
 */
export async function cancelWaitAt(ctx: Context, messageId: number | undefined): Promise<boolean> {
  if (messageId === undefined) return false;
  const key = userKey(ctx.from!.id);
  const wait = (await dialogDb((db) => loadWaits(db, key))).find((w) => w.data.messageId === messageId || w.data.askId === messageId);
  if (!wait) return false;
  await dialogDb((db) => finishWait(db, key, wait.data.shortId));
  // «Отмена» под просьбой: исходной карточке возвращаются кнопки.
  await restoreOrig(ctx, wait.data);
  return true;
}

// ---------------------------------------------------------------- фото к делу (спека task-photos)

const CONFIRM_MARK = '✓';
/** Сколько дел предлагает «К какому делу прикрепить?» — больше в один экран кнопок не помещается. */
const MAX_PHOTO_OPTIONS = 8;

/** Вложение сообщения: фото или файл-изображение — ссылка на скачивание; другой файл — отказ словами. */
type Incoming = PhotoRef | 'not_image' | 'too_big' | null;

function imageOfHeld(h: HeldMessage): Incoming {
  if (h.photoFileId) return { fileId: h.photoFileId, uniqueId: h.photoUniqueId };
  if (!h.documentFileId) return null;
  if (!h.documentMime?.startsWith('image/')) return 'not_image';
  if ((h.documentSize ?? 0) > MAX_TELEGRAM_FILE_BYTES) return 'too_big';
  return { fileId: h.documentFileId, uniqueId: h.documentUniqueId };
}

/** Чем кончилось прикрепление: `retry` — Telegram не отдал файл, человек пришлёт ещё раз. */
type Outcome = 'ok' | 'retry' | 'failed';
type Attached = { ok: true } | { ok: false; retry: boolean; say: string | null };

/** Отказ ядра словами человеку; `null` — ошибка не из отказов, её не прячем. */
function photoRefusal(e: unknown): string | null {
  if (e instanceof UnsupportedImageError) return 'photo.unsupported';
  if (!(e instanceof AppError)) return null;
  if (e.code === 'limit_exceeded') return 'photo.limit';
  if (e.code === 'forbidden') return 'error.not_your_task';
  if (e.code === 'not_found') return 'start.task_not_found';
  if (e.code === 'validation_failed') return 'photo.closed';
  return null;
}

/** Скачать фото из Telegram (вне транзакции — сеть) и прикрепить к делу. Приглашение принимается, как у реплики. */
async function attachOne(ctx: Context, r: Resolved, ref: PhotoRef, opts: { withoutStart?: boolean } = {}): Promise<Attached> {
  let image: Buffer;
  try {
    image = await downloadTelegramFile(ref.fileId);
  } catch (e) {
    logger.warn({ err: e, task: r.task.id }, 'bot: фото к делу не скачалось из Telegram');
    return { ok: false, retry: true, say: 'photo.fetch_failed' };
  }
  try {
    // Разбор — до транзакции, как в Mini App: очередь декодера не держит соединение базы.
    const img = await cleanImage(image);
    const done = await act(ctx, r, 'work', (db) => attachImage(db, {
      taskId: r.task.id, userId: r.userId, image: img, now: new Date(), fileUniqueId: ref.uniqueId ?? null, withoutStart: opts.withoutStart,
    }));
    // `null` — правило приглашённого отказало, и человеку это уже сказано.
    return done ? { ok: true } : { ok: false, retry: false, say: null };
  } catch (e) {
    const say = photoRefusal(e);
    if (!say) throw e;
    return { ok: false, retry: false, say };
  }
}

/**
 * Фото сообщения, уже связанное с делом. `batchKey` — пачка альбома (подтверждение одно на альбом);
 * `speak` — отказ говорит только первое фото пачки, остальные молчат; `skip` — фото держит другая
 * пачка (ждёт выбора дела) или пачке отказано.
 */
interface PhotoTicket { ref: PhotoRef; batchKey?: string; speak: boolean; shortId?: string; skip?: boolean; withoutStart?: boolean }

/**
 * Заявить фото сообщения за делом `r`. Для альбома — завести пачку под замком строки диалога: соседи
 * по альбому, пришедшие следом (или параллельно), найдут её и пойдут к тому же делу.
 */
async function claimPhoto(ctx: Context, r: Resolved, held: HeldMessage, opts: { withoutStart?: boolean } = {}): Promise<PhotoTicket | null> {
  const ref = imageOfHeld(held);
  if (!ref || typeof ref === 'string') return null;
  const withoutStart = opts.withoutStart || undefined;
  if (!held.mediaGroupId) return { ref, speak: true, withoutStart };
  const batchKey = String(ctx.message?.message_id ?? ctx.callbackQuery?.message?.message_id ?? Date.now());
  // Пачка помнит, что её фото — часть сдачи или вопроса: соседи по альбому приходят мимо ожидания
  // (routeTaskPhoto) и иначе начинали бы дело, сдвигая версию, по которой идёт сдача.
  const opened = await dialogDb((db) => openPhotoBatch(db, userKey(ctx.from!.id), {
    key: batchKey, mediaGroupId: held.mediaGroupId, shortId: r.task.short_id, files: [], withoutStart,
  }, ref));
  if (opened.created) return { ref, batchKey, speak: true, withoutStart };
  if (opened.kind === 'attach') {
    return { ref, batchKey: opened.batch.key, speak: false, shortId: opened.batch.shortId, withoutStart: withoutStart || opened.batch.withoutStart };
  }
  return { ref, speak: false, skip: true };
}

async function attachClaimed(ctx: Context, r: Resolved, tk: PhotoTicket): Promise<Outcome> {
  if (tk.skip) return 'ok';
  let target = r;
  if (tk.shortId && tk.shortId !== r.task.short_id) {
    const other = await resolve(ctx, tk.shortId);
    if (typeof other === 'string') return 'failed';
    target = other;
  }
  const done = await attachOne(ctx, target, tk.ref, { withoutStart: tk.withoutStart });
  if (!done.ok) {
    if (tk.speak && done.say) await ctx.reply(t(target.lang, done.say));
    // Отказ первому фото альбома — отказ всем: десять одинаковых «дело закрыто» человеку не нужны.
    if (tk.speak && tk.batchKey && !done.retry) await dialogDb((db) => closePhotoBatch(db, userKey(ctx.from!.id), tk.batchKey!));
    return done.retry ? 'retry' : 'failed';
  }
  if (!tk.batchKey) {
    await ctx.reply(`${CONFIRM_MARK} ${t(target.lang, 'photo.attached', { task: await taskLabel(target), count: 1 })}`);
    return 'ok';
  }
  await reportBatch(ctx, target, tk.batchKey, 1);
  return 'ok';
}

/**
 * Подтверждение пачки — одно на альбом: отправляет его тот, кто первым досчитал до прикреплённого,
 * остальные правят в нём число. `editId` — превратить в подтверждение это сообщение (вопрос «К какому
 * делу прикрепить?»), а не слать новое.
 */
async function reportBatch(ctx: Context, r: Resolved, batchKey: string, n: number, editId?: number): Promise<void> {
  const key = userKey(ctx.from!.id);
  const counted = await dialogDb((db) => countPhotoBatch(db, key, batchKey, n));
  const label = await taskLabel(r);
  const text = (count: number): string => `${CONFIRM_MARK} ${t(r.lang, 'photo.attached', { task: label, count })}`;
  const chatId = ctx.chat?.id ?? ctx.from!.id;
  const edit = async (messageId: number, count: number): Promise<boolean> => {
    try { await ctx.api.editMessageText(chatId, messageId, text(count)); return true; } catch { return false; }
  };
  if (counted.send) {
    const id = editId && (await edit(editId, counted.count)) ? editId : (await ctx.reply(text(counted.count))).message_id;
    // Пока подтверждение шло, соседи по альбому могли прикрепить своё — догоняем число.
    const latest = await dialogDb((db) => confirmPhotoBatch(db, key, batchKey, id));
    if (latest !== counted.count) await edit(id, latest);
  } else if (counted.confirmId) {
    await edit(counted.confirmId, counted.count);
  }
}

/** «📎 Прикрепить фото»: право и открытость дела — до просьбы, чтобы человек не слал фото впустую. */
async function handlePhotoStart(ctx: Context, shortId: string): Promise<void> {
  const r = await resolve(ctx, shortId);
  if (r === 'no_person') { await ctx.answerCallbackQuery(); return; }
  if (r === 'no_task') {
    await ctx.answerCallbackQuery();
    await ctx.reply(t(ctx.from?.language_code ?? 'en', 'start.task_not_found'));
    return;
  }
  if (CLOSED_STATUSES.includes(r.task.status)) {
    await ctx.answerCallbackQuery();
    await ctx.reply(t(r.lang, 'photo.closed'));
    return;
  }
  if (!(await inOrg(r.orgId, r.userId, (db) => canComment(db, r.task, r.userId)))) {
    await ctx.answerCallbackQuery();
    await ctx.reply(t(r.lang, 'error.not_your_task'));
    return;
  }
  await awaitText(ctx, r, 'await_photo', { shortId, orgId: r.orgId, ...cardCtx(ctx) }, t(r.lang, 'photo.ask'));
  await ctx.answerCallbackQuery();
}

/**
 * Фото в ожидании «📎»: прикрепляется, подтверждение закрывает ожидание. Не тот файл — подсказка,
 * ожидание остаётся. Просто текст — ожидание снимается: иначе сутки любое сообщение, даже кнопка
 * меню, натыкалось бы на «только фото».
 */
export async function handlePhotoMessage(ctx: Context, dialogData: Record<string, unknown>, held: HeldMessage): Promise<void> {
  const r = await resolve(ctx, dialogData.shortId as string);
  if (r === 'no_person' || r === 'no_task') { await endDialog(ctx, dialogData); return; }
  const incoming = imageOfHeld(held);
  if (incoming === 'too_big') { await ctx.reply(t(r.lang, 'photo.too_big')); return; }
  if (incoming === 'not_image') { await ctx.reply(t(r.lang, 'photo.only_images')); return; }
  if (!incoming) {
    await endDialog(ctx, dialogData);
    await refreshCardAt(ctx, r, dialogData);
    await ctx.reply(t(r.lang, 'photo.only_images'));
    return;
  }
  const done = await attachClaimed(ctx, r, (await claimPhoto(ctx, r, held))!);
  if (done === 'retry') return;
  await endDialog(ctx, dialogData);
  if (done === 'ok') await refreshCardAt(ctx, r, dialogData);
}

/** Дело карточки, на которую ответили: оно в кнопках (`a:<действие>:<short_id>:<версия>`). */
function cardShortId(markup: unknown): string | null {
  const rows = (markup as { inline_keyboard?: { callback_data?: string }[][] } | undefined)?.inline_keyboard ?? [];
  for (const b of rows.flat()) {
    const cb = b.callback_data ? decodeTask(b.callback_data) : null;
    if (cb) return cb.shortId;
  }
  return null;
}

/**
 * Фото, чьё дело известно без ожидания: следующее фото альбома, у которого пачка уже есть, и фото
 * ответом на карточку дела. Ответ на карточку, которая сама ждёт текста, разбирает `routeTaskReply`.
 * `false` — не этот случай.
 */
export async function routeTaskPhoto(ctx: Context): Promise<boolean> {
  const held = heldFrom(ctx);
  const ref = imageOfHeld(held);
  if (!ref || typeof ref === 'string') return false;
  const key = userKey(ctx.from!.id);

  if (held.mediaGroupId) {
    const joined = await dialogDb((db) => joinPhotoBatch(db, key, held.mediaGroupId!, ref));
    if (joined) {
      if (joined.kind === 'attach') {
        const r = await resolve(ctx, joined.batch.shortId!);
        if (typeof r !== 'string') await attachClaimed(ctx, r, { ref, batchKey: joined.batch.key, speak: false, withoutStart: joined.batch.withoutStart });
      }
      return true;
    }
  }

  const reply = ctx.message?.reply_to_message;
  const shortId = reply ? cardShortId(reply.reply_markup) : null;
  if (!reply || !shortId) return false;
  const waits = await dialogDb((db) => loadWaits(db, key));
  if (waits.some((w) => w.data.messageId === reply.message_id || w.data.promptId === reply.message_id || w.data.askId === reply.message_id)) return false;
  const r = await resolve(ctx, shortId);
  if (r === 'no_person') return false;
  if (r === 'no_task') { await ctx.reply(t(ctx.from?.language_code ?? 'en', 'start.task_not_found')); return true; }
  await attachClaimed(ctx, r, (await claimPhoto(ctx, r, held))!);
  return true;
}

/** Открытые дела человека для «К какому делу прикрепить?»: «Сейчас» первым, затем назначенные ему, затем поставленные им. */
async function photoTaskOptions(userId: string): Promise<{ shortId: string; label: string }[]> {
  const rows: { rank: number; due: string | null; created: number; shortId: string; label: string }[] = [];
  for (const o of await taskOrgsOf(userId)) {
    await inOrg(o.id, userId, async (db) => {
      const r = await db.query(
        `select t.short_id::text, t.number, t.title, t.due_date, t.created_at, p.key,
                case when t.assignee_user_id = $1 and t.status = 'in_progress' then 0
                     when t.assignee_user_id = $1 and t.status = 'active' then 1
                     when t.assignee_user_id = $1 then 2 else 3 end as rank
           from tasks t left join projects p on p.id = t.project_id
          where (t.assignee_user_id = $1 or (t.author_user_id = $1 and t.author_agent_id is null))
            and t.status <> all($2) and t.status <> 'draft'
          order by rank, t.due_date nulls last, t.created_at desc limit $3`,
        [userId, CLOSED_STATUSES, MAX_PHOTO_OPTIONS]);
      for (const x of r.rows) {
        const key = taskKey(x.key, x.number);
        rows.push({
          rank: x.rank as number, due: x.due_date as string | null, created: new Date(x.created_at).getTime(),
          shortId: x.short_id as string, label: key ? `${key} · ${x.title}` : x.title as string,
        });
      }
    });
  }
  rows.sort((a, b) => a.rank - b.rank || (a.due ?? '9999').localeCompare(b.due ?? '9999') || b.created - a.created);
  return rows.slice(0, MAX_PHOTO_OPTIONS).map(({ shortId, label }) => ({ shortId, label }));
}

/**
 * Фото или файл без контекста — нет ожидания, не ответ на карточку: «К какому делу прикрепить?».
 * Фото держатся в пачке до выбора; альбом — один вопрос. `false` — в сообщении нет вложения.
 */
export async function handleLoosePhoto(ctx: Context): Promise<boolean> {
  const held = heldFrom(ctx);
  const incoming = imageOfHeld(held);
  if (!incoming) return false;
  const person = await findByTelegramId(ctx.from!.id);
  if (!person) return false;
  if (incoming === 'not_image' || incoming === 'too_big') {
    await ctx.reply(t(person.language, incoming === 'too_big' ? 'photo.too_big' : 'photo.only_images'));
    return true;
  }
  const key = userKey(ctx.from!.id);
  const batchKey = String(ctx.message!.message_id);
  const opened = await dialogDb((db) => openPhotoBatch(db, key, { key: batchKey, mediaGroupId: held.mediaGroupId, files: [incoming] }, incoming));
  if (!opened.created) {
    if (opened.kind === 'attach') {
      const r = await resolve(ctx, opened.batch.shortId!);
      if (typeof r !== 'string') await attachClaimed(ctx, r, { ref: incoming, batchKey: opened.batch.key, speak: false, withoutStart: opened.batch.withoutStart });
    }
    return true;
  }
  const options = await photoTaskOptions(person.userId);
  if (!options.length) {
    await dialogDb((db) => closePhotoBatch(db, key, batchKey));
    await ctx.reply(t(person.language, 'photo.no_open_tasks'));
    return true;
  }
  await ctx.reply(t(person.language, 'photo.which_task'), { reply_markup: photoTaskKeyboard(person.language, batchKey, options) });
  return true;
}

/** Выбор на «К какому делу прикрепить?»: фото пачки — этому делу, вопрос становится подтверждением. */
export async function handlePhotoTaskCallback(ctx: Context, cb: { shortId: string | null; batch: string }): Promise<void> {
  const key = userKey(ctx.from!.id);
  await ctx.answerCallbackQuery();
  if (!cb.shortId) {
    await dialogDb((db) => closePhotoBatch(db, key, cb.batch));
    const person = await findByTelegramId(ctx.from!.id);
    try { await ctx.editMessageText(t(person?.language ?? ctx.from?.language_code ?? 'en', 'generic.cancelled')); } catch { /* недоступно */ }
    return;
  }
  const r = await resolve(ctx, cb.shortId);
  if (r === 'no_person') return;
  if (r === 'no_task') { await ctx.reply(t(ctx.from?.language_code ?? 'en', 'start.task_not_found')); return; }
  // Забрать фото пачки один раз: второе нажатие (или нажатие по другому делу) их уже не найдёт.
  const files = await dialogDb((db) => choosePhotoBatch(db, key, cb.batch, cb.shortId!));
  if (!files) {
    try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch { /* недоступно */ }
    return;
  }
  let attached = 0;
  let refusal: string | null = null;
  for (const f of files) {
    const done = await attachOne(ctx, r, f);
    if (done.ok) attached += 1;
    else refusal ??= done.say;
  }
  const questionId = ctx.callbackQuery?.message?.message_id;
  if (attached) { await reportBatch(ctx, r, cb.batch, attached, questionId); return; }
  await dialogDb((db) => closePhotoBatch(db, key, cb.batch));
  if (!refusal) return;
  try { await ctx.editMessageText(t(r.lang, refusal)); } catch { await ctx.reply(t(r.lang, refusal)); }
}

// ---------------------------------------------------------------- «Берёшь сейчас?» (спека auto-start)

/**
 * Кнопки вопроса «Берёшь сейчас?» и напоминания «Пора браться». Нажать может только исполнитель —
 * тот же `guard`, что у кнопок карточки, но без версии: за минуту карточка могла смениться, а
 * «Взять» от этого не перестаёт быть «Взять».
 */
export async function handleTakePromptCallback(ctx: Context, cb: TakePromptCallback): Promise<void> {
  const r = await guard(ctx, cb.shortId);
  if (!r) return;
  const pos = cardCtx(ctx);
  if (cb.action === 'take') {
    // Взято или закрыто, пока вопрос шёл, — сказать как есть, без ошибки.
    if (r.task.status === 'in_progress' || CLOSED_STATUSES.includes(r.task.status)) {
      await editToConfirm(ctx, pos?.chatId, pos?.messageId, t(r.lang, r.task.status === 'in_progress' ? 'take_prompt.already_taken' : 'take_prompt.closed'));
      await ctx.answerCallbackQuery();
      return;
    }
    try {
      if (!(await act(ctx, r, 'work', (db) => takeTask(db, r.task.id, { kind: 'user', userId: r.userId })))) { await ctx.answerCallbackQuery(); return; }
    } catch (e) {
      // Дело ушло из очереди иначе (вопрос, ожидание, сдача) — показать, где оно теперь.
      if (!(e instanceof AppError && e.code === 'invalid_transition')) throw e;
      await ctx.answerCallbackQuery();
      await replyStale(ctx, r.lang);
      await inOrg(r.orgId, r.userId, async (db) => {
        const fresh = (await db.query('select * from tasks where id = $1', [r.task.id])).rows[0] as Task;
        await sendCard(ctx, db, fresh, r.lang, { sourceLang: fresh.source_language ?? 'ru', personal: r.personal, viewerUserId: r.userId });
      });
      return;
    }
    // Ответ — карточка дела, как после «Взять» на карточке.
    await refreshCard(ctx, r, r.task.id);
    await ctx.answerCallbackQuery();
    return;
  }

  // «Позже»: одно ждущее напоминание на дело. Ещё не пришло — второе не ставим, а говорим, на когда
  // стоит первое; уже пришло (или его время прошло) — «позже» снова честно. Время — от отправки
  // вопроса, как на кнопке; нажали так поздно, что оно уже прошло, — от нажатия. Напоминание себе — не
  // действие в компании: правило приглашённого здесь ни при чём.
  const now = new Date();
  const sentAt = ctx.callbackQuery?.message?.date ? new Date(ctx.callbackQuery.message.date * 1000) : now;
  const reply = await inOrg(r.orgId, r.userId, async (db) => {
    const schedule = await loadUserSchedule(db, r.userId);
    const pending = await db.query(
      `select deliver_after from notifications
        where kind = 'take_reminder' and task_id = $1 and user_id = $2 and delivered_at is null and deliver_after > $3
        order by deliver_after limit 1`,
      [r.task.id, r.userId, now]);
    if (pending.rowCount) {
      return t(r.lang, 'take_prompt.later_exists', { time: clockTime(new Date(pending.rows[0].deliver_after), schedule.tz) });
    }
    let at = laterAt(schedule, cb.code, sentAt);
    if (at <= now) at = laterAt(schedule, cb.code, now);
    // Ключ — дело и время напоминания: двойное нажатие одной кнопки даёт одно напоминание.
    await notify(db, {
      userId: r.userId, kind: 'take_reminder', level: 'work', taskId: r.task.id, deliverAfter: at, createdAt: now,
      dedupeKey: `take_reminder:${r.task.id}:${localDate(at, schedule.tz)}:${clockTime(at, schedule.tz)}`,
    });
    return t(r.lang, 'take_prompt.later_done', { time: clockTime(at, schedule.tz) });
  });
  await editToConfirm(ctx, pos?.chatId, pos?.messageId, reply);
  await ctx.answerCallbackQuery();
}
