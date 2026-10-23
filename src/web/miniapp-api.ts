import { createHmac, timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { withGlobal, withOrg, type Db } from '../db/pool.js';
import { AppError } from '../core/errors.js';
import { companyNameIfMany, ensurePersonalOrg, userOrgs } from '../core/people.js';
import { setTaskShare } from '../core/sharing.js';
import { addHumanComment, COMMENT_DAILY_LIMIT, COMMENT_MAX_LENGTH } from '../core/comments.js';
import { RESULT_MIN_LENGTH } from '../core/required-result.js';
import { attachImage, CLOSED_STATUSES } from '../core/attachments.js';
import { cleanImage, readMediaFile, UnsupportedImageError } from '../groups/media.js';
import { holdsSlot, personActions, transition, type PersonAction } from '../core/lifecycle.js';
import { loadUserSchedule, localDatePlusDays } from '../core/calendar.js';
import { stopTask, takeTask } from '../core/queue.js';
import { mayRequestDue, maySetDue, openDueRequest, requestDue, setDueDate } from '../core/due.js';
import { taskKey } from '../core/projects.js';
import { applyInvitedMode, workingOrgs, type InvitedMode } from '../core/invitations.js';
import type { Task } from '../core/types.js';
import { env } from '../config/env.js';
import { translateField, warmTranslations, type TranslateFieldInput } from '../ai/translate.js';
import { countLlmCalls } from '../ai/llm.js';
import { CARD_NOTES_LIMIT, CARD_NOTES_SQL } from '../worker/translate.js';
import { authorLabel } from '../bot/cards.js';
import { logger } from '../log.js';
import { touchAppSeen } from '../core/presence.js';
import { issueReadToken, listReadTokens, revokeReadToken } from '../core/read-tokens.js';
import { issueAgentToken, listAgentTokens, revokeAgentToken } from '../core/agent-tokens.js';
import { confirmAnnouncementForUser, openAnnouncements } from '../core/announcements.js';
import { companyRoutes } from './company-api.js';
import { handleError } from './http-errors.js';
import { clientKey, rateLimit } from './rate-limit.js';

// Mini App: список дел (спека mini-app). Авторизация — Telegram WebApp initData, не OAuth.
// Название и «зачем» — на языке человека (тот же кэш переводов, что у бота); ошибка перевода → оригинал.

declare global {
  namespace Express {
    interface Request {
      miniappUser?: { userId: string; language: string };
    }
  }
}

export interface MiniappOptions {
  botToken?: string;
}

interface VerifiedInitData {
  telegramUserId: number;
}

/** Проверка подписи Telegram WebApp initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app). */
export function verifyInitData(initData: string, botToken: string, now: Date): VerifiedInitData | null {
  if (!initData || !botToken) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  // Срок годности подписи несимметричен. Назад — сутки: строку Telegram выдаёт при запуске
  // приложения и больше не обновляет, поэтому короткое окно выкидывало бы человека из открытой
  // вкладки. Вперёд — пять минут на расхождение часов: раньше стояло `Math.abs`, и подпись «из
  // будущего» принималась те же сутки, то есть окно приёма было двое суток вместо одних.
  const authDateRaw = params.get('auth_date');
  const authDate = authDateRaw ? Number(authDateRaw) : NaN;
  if (!Number.isFinite(authDate)) return null;
  const age = now.getTime() - authDate * 1000;
  if (age > 24 * 3600 * 1000 || age < -5 * 60 * 1000) return null;

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  try {
    const a = Buffer.from(computed, 'hex');
    const b = Buffer.from(hash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  const userJson = params.get('user');
  if (!userJson) return null;
  try {
    const user = JSON.parse(userJson) as { id?: unknown };
    if (typeof user.id !== 'number') return null;
    return { telegramUserId: user.id };
  } catch {
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TaskSource {
  id: string;
  kind: string;
  title: string;
  url: string | null;
  status: string | null;             // статус из слепка внешней системы
  quote: string | null;              // цитата-основание: слова людей, показываются цитатой
}

/** Проект дела (спека projects): по нему список сгруппирован, у закрытого — замок. */
interface TaskProject {
  id: string;
  name: string;
  private: boolean;
  /** Ключ проекта: из него и номера дела складывается обозначение «NOR-001». */
  key: string;
}

/** Дело, которое человек взял: шапка показывает его на любом экране приложения. */
export interface InProgress {
  task_id: string;
  title: string;
  /** Начало текущего отрезка работы. */
  started_at: string;
  /** Сколько уже наработано по делу до этого отрезка, секунды. */
  worked_seconds: number;
  /** Название компании — только когда компаний у человека больше одной. */
  company: string | null;
}

interface TaskCard {
  id: string;
  short_id: string;
  title: string;
  due_date: string | null;
  status: string;
  version: number;
  requires_result: boolean;
  /** Какой результат просит автор; приложение по нему рисует поле до нажатия «Завершить» (спека required-result). */
  expected_result: { type: 'text' | 'number' | 'file' | 'photo'; required: boolean; min_length: number } | null;
  is_translated: boolean;
  why: string | null;
  done_criteria: string | null;      // по чему человек поймёт, что закончил; только на карточке дела
  description: string | null;        // «как это делается» — объяснение для того, кто не читал разговор
  bot_link: string;                  // карточка задачи в боте — все кнопки (вопрос, перенос, время)
  important: boolean;                // личное: звёздочка (priority = urgent)
  category: 'do' | 'decide' | 'someday' | null;
  waiting_for: string | null;        // личное ожидание: кого/чего ждём
  next_check_at: string | null;
  photos: number;                    // фото дела: из рабочих групп и прикреплённые людьми (спеки group-intake, task-photos)
  sources: TaskSource[];             // материалы дела: откуда оно и что известно (спека task-context)
  shared_with: { org_id: string; name: string } | null;   // личное с пометкой «рабочее» (спека owner-feedback)
  project: TaskProject | null;       // папка по теме, в которой лежит дело (спека projects)
  key: string | null;                // обозначение дела для человека: «NOR-001» (спека projects-stage2)
  created_at?: string;               // когда дело поставили — только на карточке, мелким шрифтом
  unread?: boolean;                  // есть новое для смотрящего — синяя точка в строке (спека unread-and-deeplink)
  // Только на карточке (спека self-set-due): срок — кнопкой-календарём, просьба назвать срок.
  can_set_due?: boolean;             // смотрящий вправе поставить срок: исполнитель, автор, owner/admin
  can_request_due?: boolean;         // смотрящий вправе попросить исполнителя назвать срок
  due_request?: { requested_at: string; by_name: string; to_me: boolean; text: string | null } | null;   // открытая просьба
  // Только на карточке (спека task-reviewer): кто в деле и что сдано.
  people?: TaskPeople;
  result?: TaskResult | null;
  // Только на карточке (спека auto-start): начато без «Взять» — чем и когда.
  auto_started?: { via: 'comment' | 'attachment' | 'submit'; at: string } | null;
}

/** Стороны дела и роль смотрящего: все трое видят друг друга (спека task-reviewer). */
interface TaskPeople {
  author: string;
  assignee: string;
  reviewer: string | null;
  my_role: 'author' | 'assignee' | 'reviewer' | 'manager';
}

/** Последний сданный результат: по нему принимают, и о нём же итог постановщику. */
interface TaskResult { text: string | null; number: number | null; files: number }

async function taskPeople(db: Db, t: Task, userId: string, lang: string): Promise<TaskPeople> {
  const ids = [t.assignee_user_id, t.reviewer_user_id].filter((x): x is string => !!x);
  const r = await db.query('select id, display_name from users where id = any($1::uuid[])', [ids]);
  const name = (id: string) => (r.rows.find((u) => u.id === id)?.display_name as string | undefined) ?? '';
  // Роль смотрящего: исполнитель и проверяющий — по делу; автор — тот, кто поставил (у дела агента —
  // его хозяин); остальные открывают карточку по праву роли в компании.
  const my_role = userId === t.assignee_user_id ? 'assignee'
    : userId === t.reviewer_user_id ? 'reviewer'
      : userId === t.author_user_id ? 'author' : 'manager';
  return {
    author: await authorLabel(db, t, lang), assignee: name(t.assignee_user_id),
    reviewer: t.reviewer_user_id ? name(t.reviewer_user_id) : null, my_role,
  };
}

async function taskResult(db: Db, t: Task): Promise<TaskResult | null> {
  if (!['submitted', 'done'].includes(t.status)) return null;
  const r = await db.query(
    `select text, number, coalesce(jsonb_array_length(files), 0)::int as files from task_results
      where task_id = $1 order by created_at desc limit 1`, [t.id]);
  const row = r.rows[0] as { text: string | null; number: string | null; files: number } | undefined;
  return row ? { text: row.text, number: row.number == null ? null : Number(row.number), files: row.files } : null;
}

async function tr(db: Db, t: Task, field: 'title' | 'why' | 'done_criteria' | 'description', text: string | null, lang: string, cacheOnly = false): Promise<{ text: string | null; translated: boolean }> {
  const source = t.source_language ?? 'ru';
  if (!text || source === lang) return { text, translated: false };
  try {
    const r = await translateField(db, { objectType: 'task', objectId: t.id, field, text, sourceLang: source, targetLang: lang, cacheOnly });
    return { text: r.text, translated: r.translated };
  } catch (e) {
    logger.warn({ err: e, taskId: t.id }, 'mini app: перевод не удался, показываем оригинал');
    return { text, translated: false };
  }
}

/** Что кладём в карточку сверх строки списка. Перевод стоит денег и времени, поэтому «зачем» и
 *  критерий готовности переводятся только там, где их показывают. */
interface CardParts {
  withWhy?: boolean;
  withDoneCriteria?: boolean;
  /** Объяснение «как это делается» — только в карточке: в строке списка ему не место. */
  withDescription?: boolean;
  /** Дата постановки — метаданные карточки; в строке списка её нет (спека miniapp-task-card). */
  withCreatedAt?: boolean;
  /** Только из кэша, без модели: карточка дела прогревает перевод заранее, вне своей транзакции
   *  (спека translation-prefetch). */
  cacheOnly?: boolean;
  photos?: number;
  sharedWith?: TaskCard['shared_with'];
  sources?: TaskSource[];
  project?: TaskProject | null;
  unread?: boolean;
}

const NOT_SHOWN = { text: null, translated: false };

/**
 * Результат из тела «Завершить» (спека required-result): поле карточки, у дела без замка тоже допустимо.
 * Типы проверяются строго — `Number(true)` и «42» вместо числа не принимаем. Предел текста тот же, что у
 * реплики: результат читают агент и проверяющий, и простыня им так же не нужна.
 */
function readResult(raw: unknown): { text?: string; number?: number } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('validation_failed', 'result must be an object');
  const { text, number } = raw as { text?: unknown; number?: unknown };
  if (text !== undefined && typeof text !== 'string') throw new AppError('validation_failed', 'result.text must be a string');
  if (number !== undefined && (typeof number !== 'number' || !Number.isFinite(number))) {
    throw new AppError('validation_failed', 'result.number must be a finite number');
  }
  if (typeof text === 'string' && text.length > COMMENT_MAX_LENGTH) {
    throw new AppError('validation_failed', `A result is longer than ${COMMENT_MAX_LENGTH} characters`, { length: text.length });
  }
  // Пустое поле — не результат: иначе у дела без замка в «сдано» легла бы пустая запись.
  const body = typeof text === 'string' && text.trim() ? text.trim() : undefined;
  if (body === undefined && number === undefined) return undefined;
  return { text: body, number: number as number | undefined };
}

/** Дело сдают с результатом (файл, число, текст). Признак карточки `requires_result` и расчёт
 *  разрешённых действий смотрят на одно и то же место — иначе кнопка «Завершить» разойдётся с пометкой. */
function requiresResult(t: Task): boolean {
  return Boolean(t.expected_result?.required);
}

/**
 * Личное пространство сужает набор ещё: только «Завершить» и «Перенести». «Взять», «Вопрос»,
 * «Непонятно» и «Отказаться» там запрещает ядро (`personActions`, `transition`); остальное в личном
 * делают «Удалить» (`DELETE /personal/:id`) и «Отложить».
 */
const PERSONAL_ACTIONS: readonly PersonAction[] = ['done', 'postpone'];

/**
 * Что человеку разрешено сделать с делом (спека miniapp-task-actions). Список собирает
 * ядро (`personActions`) — тот же, что у кнопок бота, — а приложение только сужает его: иначе список
 * расходится с сервером и кнопка показывается там, где ручка отвечает отказом.
 */
export function allowedActions(task: Task, personal: boolean, userId?: string): string[] {
  const actions: string[] = [];
  // Ожидание закрывает тот, кому поручено проверять (в боте это так же). Для всего остального
  // действующее лицо — исполнитель: постороннему, которого пустили на карточку, кнопок не даём.
  const assignee = !userId || task.assignee_user_id === userId;
  for (const action of personActions(task, personal)) {
    // «Жду ответа от…» — создание ожидания, а не действие над делом: не-цель спеки.
    if (action === 'wait') continue;
    if (personal && !PERSONAL_ACTIONS.includes(action)) continue;
    if (!assignee && !(action === 'done' && task.kind === 'waiting')) continue;
    // «Завершить» есть всегда, когда его разрешает ядро — и у дела с затребованным результатом
    //: прятать кнопку значило оставить человеку только «Остановить».
    actions.push(action);
  }
  return actions;
}

/** Запись по делу: реплика человека или ответ агента (спека miniapp-task-card). */
export interface TaskNote {
  id: string;
  /** Что это за запись: реплика, вопрос, «непонятно», ответ, причина возврата. */
  kind: string;
  /** Для вопроса и «непонятно»: ответили ли уже. */
  answered?: boolean;
  author: string;
  mine: boolean;
  text: string;
  at: string;
}

/**
 * Записи по делу — старые первыми. Без них поле «Написать» — дыра: человек пишет, поле очищается,
 * и следа не остаётся. У личного дела это заметки самому себе, у дела компании — разговор с агентом.
 */
async function loadNotes(db: Db, taskId: string, userId: string, lang: string, limit = CARD_NOTES_LIMIT, cacheOnly = false): Promise<TaskNote[]> {
  const r = await db.query(
    `select m.id, m.kind, m.answered_at, m.text, m.source_language, m.created_at, m.author_user_id,
            coalesce(a.name, u.display_name, '') as author
       from task_messages m
       left join users u on u.id = m.author_user_id
       left join agents a on a.id = m.author_agent_id
      where m.task_id = $1 and ${CARD_NOTES_SQL}
      order by m.created_at desc, m.id desc
      limit $2`,
    [taskId, limit],
  );
  // Новые сверху, старые внизу (решение владельца 30.09): открыв дело, видишь последнее сразу.
  // Вопросы и ответы — тоже записи по делу: без них человек спрашивал, а в карточке
  // не было ни вопроса, ни ответа — ответ жил только в ленте бота.
  // По очереди: запросы идут по одному соединению, параллель здесь ничего не выигрывает — перевод
  // карточка готовит заранее, вне транзакции (спека translation-prefetch), а здесь читает кэш.
  const notes: TaskNote[] = [];
  for (const row of r.rows) {
    notes.push({
      id: row.id as string,
      kind: row.kind as string,
      ...(row.kind === 'question' || row.kind === 'unclear' ? { answered: row.answered_at !== null } : {}),
      author: (row.author as string) || '',
      mine: row.author_user_id === userId,
      text: await trNote(db, row.id as string, row.text as string, row.source_language as string | null, lang, cacheOnly),
      at: new Date(row.created_at as string).toISOString(),
    });
  }
  return notes;
}

/**
 * Реплика на языке читающего — как в уведомлениях бота (спека translation-and-email). Каждый
 * работает на своём языке: вьетнамская запись исполнителя приходила владельцу в бота по-русски, а
 * в карточке приложения оставалась вьетнамской — одно и то же дело рассказывало разное.
 * Язык не распознан (короткое «ок») — переводить не из чего; ошибка перевода — показываем оригинал.
 */
async function trNote(db: Db, id: string, text: string, source: string | null, lang: string, cacheOnly = false): Promise<string> {
  if (!text.trim() || !source || source === lang) return text;
  try {
    const r = await translateField(db, { objectType: 'task_message', objectId: id, field: 'text', text, sourceLang: source, targetLang: lang, cacheOnly });
    return r.text;
  } catch (e) {
    logger.warn({ err: e, messageId: id }, 'mini app: перевод записи не удался, показываем оригинал');
    return text;
  }
}

async function toCard(db: Db, t: Task, lang: string, parts: CardParts = {}): Promise<TaskCard> {
  const c = parts.cacheOnly ?? false;
  const title = await tr(db, t, 'title', t.title, lang, c);
  const why = parts.withWhy ? await tr(db, t, 'why', t.why ?? null, lang, c) : NOT_SHOWN;
  const doneCriteria = parts.withDoneCriteria ? await tr(db, t, 'done_criteria', t.done_criteria || null, lang, c) : NOT_SHOWN;
  // Объяснение хранилось, но человеку не показывалось вовсе — дело приходило голым названием.
  const description = parts.withDescription ? await tr(db, t, 'description', t.description || null, lang, c) : NOT_SHOWN;
  return {
    id: t.id,
    short_id: String(t.short_id),
    title: title.text ?? t.title,
    due_date: t.due_date,
    status: t.status,
    version: t.version,
    requires_result: requiresResult(t),
    // Ожидание результата не просит (сдачи у него нет): поле на карточке рисовать не из-за чего.
    expected_result: t.expected_result && t.kind === 'action'
      ? { type: t.expected_result.type, required: t.expected_result.required, min_length: t.expected_result.type === 'text' || t.expected_result.type === 'file' ? RESULT_MIN_LENGTH : 0 }
      : null,
    is_translated: title.translated || why.translated || doneCriteria.translated || description.translated,
    why: why.text,
    done_criteria: doneCriteria.text,
    description: description.text,
    bot_link: `https://t.me/${env.telegramBotUsername}?start=t_${t.short_id}`,
    important: t.priority === 'urgent',
    category: t.category ?? null,
    waiting_for: t.kind === 'waiting' ? (t.waiting?.waiting_for ?? null) : null,
    next_check_at: t.kind === 'waiting' ? (t.waiting?.next_check_at ?? null) : null,
    photos: parts.photos ?? 0,
    sources: parts.sources ?? [],
    shared_with: parts.sharedWith ?? null,
    project: parts.project ?? null,
    key: taskKey(parts.project?.key, t.number),
    created_at: parts.withCreatedAt ? new Date(t.created_at).toISOString() : undefined,
    unread: parts.unread,
  };
}

/** Реплики, которые для читающего — новое: разговор по делу, а не служебные записи. */
// owner_instruction — указание владельца в дело своего агента: исполнитель видит его в карточке, значит и точку.
// due_request — просьба назвать срок (спека self-set-due): исполнителю это новое, пока не ответил.
const UNREAD_KINDS = ['comment', 'question', 'unclear', 'decline_reason', 'answer', 'rework_reason', 'owner_instruction', 'due_request'];

/**
 * Есть ли в деле `t` новое для смотрящего (спека unread-and-deeplink) — SQL-условие над строкой дела.
 * Новое — реплика или результат не от него (другой человек или агент) позже его последнего открытия
 * карточки; не открывал ни разу — позже постановки дела. Закрытое дело новым не бывает: в
 * «Завершённых» уже не работают. `viewer` и `kinds` — номера параметров запроса.
 */
function unreadSql(viewer: string, kinds: string): string {
  return `(t.status <> 'done' and exists (
      select 1 from (
        select m.created_at from task_messages m
         where m.task_id = t.id and m.kind = any(${kinds}) and m.author_user_id is distinct from ${viewer}
        union all
        select r.created_at from task_results r where r.task_id = t.id and r.user_id <> ${viewer}
      ) news
      where news.created_at > coalesce(
        (select v.viewed_at from task_views v where v.user_id = ${viewer} and v.task_id = t.id), t.created_at)))`;
}

/** Отметка «открывал карточку»: время только растёт — запоздавший запрос не вернёт погасшее новым. */
async function markViewed(db: Db, taskId: string, userId: string): Promise<void> {
  await db.query(
    `insert into task_views(user_id, task_id, org_id) values ($1, $2, current_setting('app.org_id')::uuid)
     on conflict (user_id, task_id) do update set viewed_at = greatest(task_views.viewed_at, excluded.viewed_at)`,
    [userId, taskId],
  );
}

type ListParts = Pick<CardParts, 'withWhy' | 'withDoneCriteria' | 'withCreatedAt' | 'withDescription' | 'cacheOnly'> & {
  /** Для кого считать «новое» (спека unread-and-deeplink): задан — у каждого дела есть `unread`. */
  unreadFor?: string;
};

async function cards(db: Db, list: Task[], lang: string, listParts: ListParts = {}): Promise<TaskCard[]> {
  const { unreadFor, ...parts } = listParts;
  const counts = new Map<string, number>();
  const unread = new Set<string>();
  const orgNames = new Map<string, string>();
  const sources = new Map<string, TaskSource[]>();
  const projects = new Map<string, TaskProject>();
  if (list.length) {
    const r = await db.query(
      `select task_id, count(*)::int as n from task_attachments where task_id = any($1::uuid[]) group by task_id`, [list.map((t) => t.id)]);
    for (const row of r.rows) counts.set(row.task_id as string, row.n as number);
    // Материалы дела (спека task-context): на карточке дела — развёрнутым списком, с цитатой-основанием.
    const src = await db.query(
      `select id, task_id, kind, title, url, snapshot->>'status' as status, quote from task_sources
        where task_id = any($1::uuid[]) order by created_at, id`, [list.map((t) => t.id)]);
    for (const row of src.rows) {
      const item = {
        id: row.id as string, kind: row.kind as string, title: row.title as string,
        url: row.url as string | null, status: row.status as string | null, quote: row.quote as string | null,
      };
      sources.set(row.task_id as string, [...(sources.get(row.task_id as string) ?? []), item]);
    }
    // Проекты дел списка одним запросом: по ним список группируется (спека projects).
    const projectIds = [...new Set(list.map((t) => t.project_id).filter((id): id is string => Boolean(id)))];
    if (projectIds.length) {
      const pr = await db.query('select id, name, private, key from projects where id = any($1::uuid[])', [projectIds]);
      for (const row of pr.rows) {
        projects.set(row.id as string, {
          id: row.id as string, name: row.name as string, private: row.private as boolean, key: row.key as string,
        });
      }
    }
    // Название компании у личного дела с пометкой «рабочее» (спека owner-feedback).
    const shared = [...new Set(list.map((t) => t.shared_org_id).filter((id): id is string => Boolean(id)))];
    if (shared.length) {
      const o = await db.query('select id, name from orgs where id = any($1::uuid[])', [shared]);
      for (const row of o.rows) orgNames.set(row.id as string, row.name as string);
    }
    // Новое — одним запросом на весь список, а не по делу.
    if (unreadFor) {
      const u = await db.query(
        `select t.id from tasks t where t.id = any($1::uuid[]) and ${unreadSql('$2::uuid', '$3::text[]')}`,
        [list.map((t) => t.id), unreadFor, UNREAD_KINDS]);
      for (const row of u.rows) unread.add(row.id as string);
    }
  }
  return Promise.all(list.map((t) => {
    const name = t.shared_org_id ? orgNames.get(t.shared_org_id) : undefined;
    return toCard(db, t, lang, {
      ...parts,
      photos: counts.get(t.id) ?? 0,
      sharedWith: name ? { org_id: t.shared_org_id!, name } : null,
      sources: sources.get(t.id) ?? [],
      project: (t.project_id ? projects.get(t.project_id) : null) ?? null,
      unread: unreadFor ? unread.has(t.id) : undefined,
    });
  }));
}

interface CompanyLists {
  now: TaskCard[];
  queue: TaskCard[];
  waiting_external: TaskCard[];
  submitted: TaskCard[];
  waiting: TaskCard[];
  scheduled: TaskCard[];
}

async function loadCompanyLists(db: Db, userId: string, now: Date, lang: string): Promise<CompanyLists> {
  const holders = (await db.query(
    `select * from tasks where assignee_user_id = $1 and kind = 'action' and status in ('active','in_progress','blocked')
       order by status_changed_at`,
    [userId],
  )).rows as Task[];
  const nowList: Task[] = [];
  for (const t of holders) if (await holdsSlot(db, t, now)) nowList.push(t);

  const queue = (await db.query(
    `select * from tasks where assignee_user_id = $1 and kind = 'action' and status in ('ready','rework')
       order by (status = 'rework') desc, (priority = 'urgent') desc, due_date nulls last, created_at`,
    [userId],
  )).rows as Task[];

  const waitingExternal = (await db.query(
    `select * from tasks where assignee_user_id = $1 and status = 'waiting_external'
       order by due_date nulls last, created_at`,
    [userId],
  )).rows as Task[];

  // Сданное, где человек проверяющий, — его работа на приёмке (спека task-reviewer): без этого дело
  // жило бы только в уведомлении бота.
  const submitted = (await db.query(
    `select * from tasks where status = 'submitted' and (assignee_user_id = $1 or reviewer_user_id = $1) order by submitted_at`,
    [userId],
  )).rows as Task[];

  const waiting = (await db.query(
    `select * from tasks where kind = 'waiting' and status = 'waiting'
       and (assignee_user_id = $1 or waiting->>'check_user_id' = $1::text)
       order by (waiting->>'next_check_at')`,
    [userId],
  )).rows as Task[];

  // «Отложено»: перенесённое дело ждёт своего дня в scheduled. Без этого раздела оно
  // пропадало из списка целиком до начала рабочего дня новой даты — Мария перенесла два дела на
  // завтра и утром решила, что они потерялись.
  const scheduled = (await db.query(
    `select * from tasks where assignee_user_id = $1 and kind = 'action' and status = 'scheduled'
       order by activate_at nulls last, due_date nulls last, created_at`,
    [userId],
  )).rows as Task[];

  return {
    now: await cards(db, nowList, lang, { withWhy: true, unreadFor: userId }),
    queue: await cards(db, queue, lang, { unreadFor: userId }),
    waiting_external: await cards(db, waitingExternal, lang, { unreadFor: userId }),
    submitted: await cards(db, submitted, lang, { unreadFor: userId }),
    waiting: await cards(db, waiting, lang, { unreadFor: userId }),
    scheduled: await cards(db, scheduled, lang, { unreadFor: userId }),
  };
}

/**
 * Проекты, на которых у человека есть дела: по ним список делится (спека projects-stage2). Закрытая
 * проект самого человека идёт первой — это то, что раньше было «Личным».
 */
async function loadProjects(db: Db, userId: string): Promise<{ id: string; key: string; name: string; private: boolean; open: number }[]> {
  const r = await db.query(
    `select p.id, p.key, p.name, p.private,
            (select count(*)::int from tasks t
              where t.project_id = p.id and t.assignee_user_id = $1 and t.status = any($2)) as open
       from projects p
      where p.status = 'active' and (p.private = false or p.owner_user_id = $1
            or exists (select 1 from project_members m where m.project_id = p.id and m.user_id = $1))
      order by (p.private and p.owner_user_id = $1) desc, p.created_at`,
    [userId, VISIBLE_STATUSES]);
  return r.rows.filter((b) => b.open > 0) as { id: string; key: string; name: string; private: boolean; open: number }[];
}

/**
 * Люди компании со счётчиком открытых дел — для фильтра списка (спека projects-stage2). Видит их
 * только владелец или админ: рядовому исполнителю чужая загрузка не показывается.
 * Закрытые проекты в счёт не идут — правило видимости то же, что везде.
 */
async function loadPeople(db: Db, viewerRole: string, viewerId: string): Promise<{ id: string; name: string; open: number; invited: boolean; unread: boolean }[]> {
  if (viewerRole !== 'owner' && viewerRole !== 'admin') return [];
  // Приглашённые входят в список: владельцу важно видеть и того, кто ещё не дошёл до бота, —
  // дело на нём уже висит. Себя в список не кладём: свой список открывается чипом «Мои дела».
  const r = await db.query(
    `select u.id, u.display_name as name, (m.status = 'invited') as invited,
            (select count(*)::int from tasks t
              -- Правило видимости держит RLS: своё закрытое смотрящий видит, чужое — нет.
              -- Ручной фильтр поверх него прятал от человека его собственные дела.
              where t.assignee_user_id = u.id and t.status = any($1)) as open,
            -- Точка на чипе: у человека есть дело с новым для смотрящего — то же условие, что у
            -- строки его списка (спека unread-and-deeplink).
            exists (select 1 from tasks t
              where t.assignee_user_id = u.id and t.status = any($1) and ${unreadSql('$2::uuid', '$3::text[]')}) as unread
       from memberships m join users u on u.id = m.user_id
      where m.org_id = current_setting('app.org_id')::uuid and m.status in ('active','invited')
        and u.anonymized_at is null and u.id <> $2
      order by u.display_name`, [VISIBLE_STATUSES, viewerId, UNREAD_KINDS]);
  return r.rows as { id: string; name: string; open: number; invited: boolean; unread: boolean }[];
}

async function loadPersonalTasks(db: Db, userId: string, lang: string): Promise<TaskCard[]> {
  const r = await db.query(
    `select * from tasks where assignee_user_id = $1 and status in ('ready','scheduled','waiting')
      order by (priority = 'urgent') desc, due_date nulls last, position, created_at`,
    [userId],
  );
  return cards(db, r.rows as Task[], lang, { unreadFor: userId });
}

/** Окно и потолок раздела «Завершённые» (спека completed-list): раздел отвечает на вопрос
 *  «что я закрыл недавно», длинная история — забота страницы итогов. */
const COMPLETED_WINDOW_DAYS = 14;
const COMPLETED_LIMIT = 50;

/** Сколько дел человек закрыл за окно. Едет в основном списке: число видно до раскрытия раздела,
 *  иначе «Завершённые» выглядят пустыми, пока по ним не нажмёшь (а пустые и вовсе не показываются). */
async function countCompleted(db: Db, userId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - COMPLETED_WINDOW_DAYS * 86400_000);
  const r = await db.query(
    `select count(*)::int as n from tasks
      where assignee_user_id = $1 and status = 'done' and status_changed_at >= $2`,
    [userId, since],
  );
  return Math.min(r.rows[0].n as number, COMPLETED_LIMIT);
}

async function loadCompletedTasks(db: Db, userId: string, lang: string, now: Date): Promise<TaskCard[]> {
  const since = new Date(now.getTime() - COMPLETED_WINDOW_DAYS * 86400_000);
  const r = await db.query(
    `select * from tasks
      where assignee_user_id = $1 and status = 'done' and status_changed_at >= $2
      order by status_changed_at desc limit $3`,
    [userId, since, COMPLETED_LIMIT],
  );
  return cards(db, r.rows as Task[], lang);
}

/**
 * Дело, которое человек может двигать. Организации — те, где он действует, и те, куда его позвали
 * живым приглашением: первое действие по делу такой компании принимает приглашение,
 * как в боте. Отозванное или истёкшее приглашение дел не открывает — 404.
 * Ожидание двигает и тот, кому поручено его проверять, — как в боте.
 */
async function findAssignedTask(userId: string, taskId: string): Promise<Found | null> {
  if (!UUID_RE.test(taskId)) return null;
  const orgs = await workingOrgs(userId);
  for (const org of orgs) {
    const found = await withOrg(org.id, async (db) => {
      const r = await db.query(
        `select * from tasks
          where id = $1 and (assignee_user_id = $2 or (kind = 'waiting' and waiting->>'check_user_id' = $2::text))`,
        [taskId, userId],
      );
      return (r.rows[0] as Task) ?? null;
    }, { actorUserId: userId });
    if (!found) continue;
    return { orgId: org.id, orgStatus: org.status, task: found };
  }
  return null;
}

/** Дело действия и статус членства в его компании: `invited` — компания, куда лишь позвали. */
interface Found { orgId: string; orgStatus: string; task: Task }

/**
 * Транзакция действия по делу с правилом приглашённого: действие работы принимает
 * приглашение в этой же транзакции (упало действие — не принято), отказ отклоняет приглашение,
 * прочее до входа — 403. Отозванное или истёкшее приглашение — 404.
 */
function actIn<T>(found: Found, userId: string, mode: InvitedMode, fn: (db: Db) => Promise<T>): Promise<T> {
  return withOrg(found.orgId, async (db) => {
    await applyInvitedMode(db, { id: found.orgId, status: found.orgStatus }, userId, mode);
    return fn(db);
  }, { actorUserId: userId });
}

/** Ищет дело, которое человеку показывает список: он исполнитель (в том числе в личном пространстве)
 *  либо его назначили проверить ожидание. Чужое — 404 у вызывающего, как у остальных ручек. */
/**
 * Статусы, которые приложение вообще показывает (сумма списков `loadCompanyLists`/личного).
 * Карточка не должна открывать больше списка: закрытое дело выглядело бы живым — с «Готово»
 * и полем реплики, — хотя сделать с ним уже нечего.
 */
const VISIBLE_STATUSES = [
  'active', 'in_progress', 'blocked', 'ready', 'rework', 'waiting_external', 'submitted', 'scheduled', 'waiting',
  // Завершённое дело открывается тоже — из раздела «Завершённые», ради одной кнопки «Вернуть в работу»
  // (спека completed-list). Кнопок «Готово» и реплики у него нет: делать с ним больше нечего.
  'done',
];

/**
 * Дело, которое человеку можно открыть карточкой. Не только своё: владелец и админ смотрят список
 * дел человека («Компания» → человек) и нажимают на дело — до этой правки карточка отвечала 404, и
 * приложение возвращало нажавшего в собственный список, будто он промахнулся. То же у постановщика:
 * дело, которое он сам поставил, не открывалось.
 *
 * Открыть — не значит распорядиться: кнопок не-исполнителю карточка не даёт (`allowedActions`).
 * Границу закрытых досок держит RLS, а не этот запрос: чужую закрытую доску роль не открывает
 * — потому и спрашиваем под `withOrg` от имени смотрящего.
 */
async function findVisibleTask(userId: string, taskId: string): Promise<Found | null> {
  if (!UUID_RE.test(taskId)) return null;
  // Дело компании, куда позвали, видно и до принятия; распоряжаться чужими делами роль
  // из приглашения не даёт — только после входа.
  const orgs = await workingOrgs(userId);
  for (const org of orgs) {
    const manages = org.kind === 'company' && org.status === 'active' && (org.role === 'owner' || org.role === 'admin');
    const found = await withOrg(org.id, async (db) => {
      const r = await db.query(
        `select * from tasks
          where id = $1 and status = any($3)
            and (assignee_user_id = $2 or (kind = 'waiting' and waiting->>'check_user_id' = $2::text)
                 or author_user_id = $2 or reviewer_user_id = $2 or $4)`,
        [taskId, userId, VISIBLE_STATUSES, manages],
      );
      return (r.rows[0] as Task) ?? null;
    }, { actorUserId: userId });
    if (found) return { orgId: org.id, orgStatus: org.status, task: found };
  }
  return null;
}

/** Ищет задачу среди организаций человека без условия «он исполнитель» — права проверяет ядро
 *  (`addHumanComment`: исполнитель, постановщик-человек, владелец). Чужая задача — 404. */
async function findTaskInUserOrgs(userId: string, taskId: string): Promise<Found | null> {
  if (!UUID_RE.test(taskId)) return null;
  const orgs = await workingOrgs(userId);
  for (const org of orgs) {
    const found = await withOrg(org.id, async (db) => {
      // В компании, куда лишь позвали, — только своё дело: реплика по нему и есть первое действие.
      const r = await db.query(
        `select * from tasks where id = $1 and ($3 or assignee_user_id = $2)`, [taskId, userId, org.status === 'active']);
      return (r.rows[0] as Task) ?? null;
    }, { actorUserId: userId });
    if (!found) continue;
    return { orgId: org.id, orgStatus: org.status, task: found };
  }
  return null;
}

// Фабрика синхронная нарочно: раньше она была async и на каждый запрос порождала промис, за
// которым никто не следил. Отказ такого промиса не доходил до Express, а необработанный отказ
// в Node 22 убивает процесс — то есть любая заминка базы (разрыв
// соединения, statement_timeout, рестарт Postgres) валила web вместе с `/mcp` и вебхуком бота.
// Теперь мидлвар создаётся один раз, а его отказ Express 5 ловит сам и отдаёт обработчику ошибок.
function authMiddleware(botToken: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const initData = req.header('X-Telegram-Init-Data');
    if (!initData || !botToken) { res.status(401).json({ code: 'unauthorized' }); return; }
    const verified = verifyInitData(initData, botToken, new Date());
    if (!verified) { res.status(401).json({ code: 'unauthorized' }); return; }
    const row = await withGlobal((db) => db.query(
      `select u.id as user_id, u.language from telegram_links tl join users u on u.id = tl.user_id where tl.telegram_user_id = $1`,
      [verified.telegramUserId],
    ));
    if (!row.rowCount) { res.status(401).json({ code: 'unauthorized' }); return; }
    req.miniappUser = { userId: row.rows[0].user_id as string, language: row.rows[0].language as string };
    // Отметка «заходил в приложение» (спека person-presence). Ждём её здесь же, а не пускаем
    // висящим промисом — по той же причине, что выше. Упала запись — человек всё равно получает
    // свой ответ: отметка нужна владельцу, а не ему.
    try {
      await touchAppSeen(req.miniappUser.userId);
    } catch (e) {
      logger.warn({ err: e, userId: req.miniappUser.userId }, 'mini app: отметка «заходил» не записалась');
    }
    next();
  };
}


/**
 * Версия карточки в теле действия: прислали — ядро проверит, что жали по свежей карточке.
 * Принимается только целое число: строка «abc» или `1.5` раньше молча отключали проверку,
 * а `null` превращался в версию 0 и ломал корректный запрос (ревью диффа).
 */
function optionalVersion(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new AppError('validation_failed', 'Card version must be a whole number');
  }
  return raw;
}

/**
 * Сколько раз в сутки человек тревожит агента по одному делу. Вопрос и «Непонятно» из очереди
 * статус не меняют, поэтому кнопка остаётся нажимаемой — без предела двадцать пять нажатий уедут
 * в сводку двадцатью пятью записями (ревью диффа). Предел тот же, что у реплик.
 */
async function assertAskLimit(db: Db, taskId: string, userId: string): Promise<void> {
  const used = (await db.query(
    `select count(*)::int as n from task_messages
      where task_id = $1 and author_user_id = $2 and kind in ('comment','owner_instruction','question','unclear')
        and created_at > now() - interval '24 hours'`,
    [taskId, userId],
  )).rows[0].n as number;
  if (used >= COMMENT_DAILY_LIMIT) {
    throw new AppError('limit_exceeded', `No more than ${COMMENT_DAILY_LIMIT} messages a day on one task`, { limit: COMMENT_DAILY_LIMIT });
  }
}

/**
 * Текст вопроса, «Непонятно» и отказа: пустой не уходит — агент узнаёт об отказе
 * только ради причины. Предел длины тот же, что у реплики: и то и другое уезжает агенту в сводке.
 */
function requireText(raw: unknown): string {
  // Нулевой байт база не принимает вовсе (запрос падал в 500), невидимые символы текстом не являются:
  // «причина отказа» из одного zero-width обходила правило «без текста не уходит» (ревью диффа).
  const text = typeof raw === 'string'
    ? raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u200b-\u200f\ufeff]/g, '').trim()
    : '';
  if (!text) throw new AppError('validation_failed', 'Text is required');
  if (text.length > COMMENT_MAX_LENGTH) {
    throw new AppError('validation_failed', `Text is longer than ${COMMENT_MAX_LENGTH} characters — say the gist, the details go into the task`, { length: text.length });
  }
  return text;
}

/** «Перенести» — три даты вместо календаря; рабочие дни считает ядро, как и у бота. */
const POSTPONE_DAYS: Record<string, number> = { tomorrow: 1, day_after: 2, week: 7 };

// Сборка Vite кладёт Mini App в <корень>/dist/app; сервер в образе лежит в dist/src/web — считаем от рабочего каталога.
const DIST_DIR = resolve(process.env.TASKANO_APP_DIR ?? join(process.cwd(), 'dist', 'app'));

/**
 * Что человек делает прямо сейчас — дело, которое он взял (статус `in_progress`), с минутой начала.
 * Нужно шапке приложения: «Взял» ничем не отзывался, и человек не видел ни что он взял, ни сколько
 * с этим сидит (спека mini-app).
 *
 * Ищем поперёк компаний: слот один на человека, и взятое дело может быть из другой компании — та
 * самая, чья очередь здесь стоит. Название компании отдаём, когда компаний у человека больше одной,
 * иначе оно лишнее в каждой строке (спека multi-company).
 */
async function loadInProgress(userId: string, language: string): Promise<InProgress | null> {
  const orgs = await withGlobal((db) => userOrgs(db, userId));
  for (const org of orgs) {
    const found = await withOrg(org.id, async (db) => {
      const r = await db.query(
        `select id, title, coalesce(taken_at, started_at) as started_at, worked_seconds, source_language from tasks
          where assignee_user_id = $1 and kind = 'action' and status = 'in_progress'
          order by coalesce(taken_at, started_at) desc nulls last limit 1`,
        [userId],
      );
      const task = r.rows[0] as { id: string; title: string; started_at: Date | null; worked_seconds: number; source_language: string | null } | undefined;
      if (!task) return null;
      const title = await tr(db, { id: task.id, source_language: task.source_language } as Task, 'title', task.title, language);
      return {
        task_id: task.id,
        title: title.text ?? task.title,
        started_at: (task.started_at ?? new Date()).toISOString(),
        // Время прежних подходов: таймер показывает его вместе с идущим отрезком, иначе после
        // остановки счёт начинался бы с нуля и потраченное пропадало с экрана.
        worked_seconds: task.worked_seconds ?? 0,
        company: await companyNameIfMany(db, userId),
      };
    }, { actorUserId: userId });
    if (found) return found;
  }
  return null;
}

/**
 * Перевести для карточки всё, что она покажет, — вне её транзакции (спека translation-prefetch).
 * Обычно фон уже всё перевёл, и здесь один запрос к кэшу. Недостающее идёт к модели параллельно,
 * а не по очереди; транзакция карточки потом только читает кэш и модель не ждёт — иначе она
 * держала бы блокировки кэша, пока переводит, и сталкивалась с фоновым переводом того же дела.
 */
async function warmCard(orgId: string, task: Task, userId: string, lang: string): Promise<void> {
  const notes = await withOrg(orgId, async (db) => (await db.query(
    `select m.id, m.text, m.source_language from task_messages m
      where m.task_id = $1 and (${CARD_NOTES_SQL} or m.kind = 'due_request')
      order by m.created_at desc, m.id desc limit $2`,
    [task.id, CARD_NOTES_LIMIT + 1],
  )).rows as { id: string; text: string; source_language: string | null }[], { actorUserId: userId });
  const source = task.source_language ?? 'ru';
  const inputs: TranslateFieldInput[] = [];
  for (const field of ['title', 'why', 'done_criteria', 'description'] as const) {
    const text = task[field];
    if (text) inputs.push({ objectType: 'task', objectId: task.id, field, text, sourceLang: source, targetLang: lang });
  }
  for (const m of notes) {
    if (m.source_language) inputs.push({ objectType: 'task_message', objectId: m.id, field: 'text', text: m.text, sourceLang: m.source_language, targetLang: lang });
  }
  await warmTranslations(orgId, inputs, { actorUserId: userId });
}

/**
 * Карточка дела целиком — то, что отдаёт `GET /tasks/:id` и действия, после которых карточка
 * перерисовывается с сервера (срок, просьба назвать срок). Срок и просьба считаются правами ядра,
 * а не вёрсткой: приложение своей копии правил не держит.
 */
async function taskScreen(orgId: string, task: Task, userId: string, language: string, opts: { markViewed?: boolean } = {}) {
  await warmCard(orgId, task, userId, language);
  const actor = { kind: 'user' as const, userId };
  const { card, notes, due, people, result } = await withOrg(orgId, async (db) => {
    // Открыл карточку — новое в деле прочитано (спека unread-and-deeplink): и тапом по строке, и по
    // кнопке «Открыть задачу» из уведомления — оба пути идут сюда.
    if (opts.markViewed) await markViewed(db, task.id, userId);
    const open = await openDueRequest(db, task.id);
    const [card] = await cards(db, [task], language, { withWhy: true, withDoneCriteria: true, withCreatedAt: true, withDescription: true, cacheOnly: true });
    return {
      card: card!,
      notes: await loadNotes(db, task.id, userId, language, CARD_NOTES_LIMIT, true),
      people: await taskPeople(db, task, userId, language),
      result: await taskResult(db, task),
      due: {
        can_set_due: await maySetDue(db, task, actor),
        can_request_due: await mayRequestDue(db, task, actor),
        due_request: open
          ? {
            requested_at: new Date(open.requested_at).toISOString(), by_name: open.by_name, to_me: task.assignee_user_id === userId,
            // Зачем нужен срок — словами просившего, на языке читающего.
            text: open.text.trim() ? await trNote(db, open.id, open.text, open.source_language, language, true) : null,
          }
          : null,
      },
    };
  }, { actorUserId: userId });
  // Вид пространства берём здесь, а не из списка на клиенте: дело могло переехать (`move_to_org`),
  // и тогда карточка показывала бы личные кнопки у дела компании.
  const kind = (await withGlobal((db) => db.query('select kind from orgs where id = $1', [orgId]))).rows[0]?.kind;
  return {
    lang: language,
    task: {
      ...card, ...due, people, result,
      auto_started: task.started_via && task.started_at ? { via: task.started_via, at: new Date(task.started_at).toISOString() } : null,
    },
    personal: kind === 'personal', notes,
    actions: allowedActions(task, kind === 'personal', userId),
  };
}

/** Дело для срока и просьбы о сроке: права проверяет ядро; в компании, куда позвали, — только своё, и это принятие. */
async function findActingTask(userId: string, taskId: string): Promise<Found | null> {
  if (!UUID_RE.test(taskId)) return null;
  const orgs = await workingOrgs(userId);
  for (const org of orgs) {
    const found = await withOrg(org.id, async (db) => (await db.query(
      `select * from tasks where id = $1 and ($3 or assignee_user_id = $2)`, [taskId, userId, org.status === 'active'],
    )).rows[0] as Task | undefined, { actorUserId: userId });
    if (!found) continue;
    return { orgId: org.id, orgStatus: org.status, task: found };
  }
  return null;
}

/**
 * Неподтверждённые объявления человека во всех его компаниях, старые первыми (спека announcements).
 * Перевод — только из кэша: первый запрос приложения модель не ждёт. Кэш наполняет отправка в фоне
 * после коммита (`core/announcements`); не успел — показан оригинал. Только действующие компании:
 * вышедшему объявления прежней компании не показываются, приглашённому до входа — тоже.
 */
async function loadAnnouncements(userId: string, language: string, orgs: { id: string; kind: string; status: string }[]) {
  const out: { id: string; org_id: string; from: string; agent: string | null; text: string; translated: boolean; sent_at: string }[] = [];
  for (const org of orgs.filter((o) => o.kind === 'company' && o.status === 'active')) {
    const rows = await withOrg(org.id, (db) => openAnnouncements(db, userId), { actorUserId: userId });
    if (!rows.length) continue;
    await withOrg(org.id, async (db) => {
      for (const r of rows) {
        const tr = r.source_language && r.source_language !== language
          ? await translateField(db, { objectType: 'announcement', objectId: r.translation_id, field: 'text', text: r.text, sourceLang: r.source_language, targetLang: language, cacheOnly: true })
          : null;
        out.push({
          id: r.id, org_id: r.org_id, from: r.author, agent: r.agent, text: tr?.translated ? tr.text : r.text, translated: !!tr?.translated,
          sent_at: new Date(r.sent_at).toISOString(),
        });
      }
    }, { actorUserId: userId });
  }
  return out.sort((a, b) => (a.sent_at < b.sent_at ? -1 : a.sent_at > b.sent_at ? 1 : a.id < b.id ? -1 : 1));
}

export function miniappRoutes(app: Express, opts: MiniappOptions = {}): void {
  const botToken = opts.botToken ?? env.telegramBotToken;
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  // Первый потолок — до проверки подписи и по адресу: проверка считает HMAC и ходит в базу за
  // привязкой, а неподписанный запрос до счёта по человеку не доживает — раньше поток чужих
  // запросов проходил мимо ограничителя целиком. Порог высокий: за клиентами Telegram один выход
  // в сеть, и несколько человек одной компании сидят под общим адресом. Адрес — клиента, а не узла
  // Cloudflare: по узлу один посторонний закрывал бы приложение всем, кто пришёл через тот же узел.
  router.use(rateLimit({ windowMs: 60_000, max: 600, key: clientKey }));
  router.use(authMiddleware(botToken));

  // Второй — по человеку. Общий на минуту и отдельный на смену слота: такт «взял — остановил»
  // поднимает версию дела, а значит пробивает дедуп уведомлений — пятнадцать тактов давали
  // шестнадцать сообщений в Telegram и полсотни событий в ленте, которую читает агент.
  const byUser = (req: Request): string => req.miniappUser?.userId ?? req.ip ?? 'unknown';
  router.use(rateLimit({ windowMs: 60_000, max: 120, key: byUser }));
  const slotLimit = rateLimit({ windowMs: 3600_000, max: 60, key: byUser });
  // Загрузка фото — свой потолок (спека task-photos): каждое перекодируется sharp в процессе web.
  const photoLimit = rateLimit({ windowMs: 60_000, max: 30, key: byUser });

  // Раздел «Компания» (спека miniapp-company): управление людьми, проектами и агентами. Ручки живут
  // отдельным файлом — у них другой читатель и другая граница доступа.
  companyRoutes(router);

  router.get('/lists', async (req, res) => {
    const { userId, language } = req.miniappUser!;
    const now = new Date();
    // Компания, куда позвали, — тоже вкладка: её дела видны, первое действие принимает приглашение.
    const orgs = await workingOrgs(userId, now);
    const spaces = await Promise.all(orgs.map(async (org) => {
      if (org.kind === 'personal') {
        const { tasks, completed } = await withOrg(org.id, async (db) => ({
          tasks: await loadPersonalTasks(db, userId, language),
          completed: await countCompleted(db, userId, now),
        }), { actorUserId: userId });
        return { org_id: org.id, name: org.name, kind: 'personal' as const, lists: { open: tasks }, completed_count: completed, projects: [], people: [] };
      }
      const { lists, completed, projects, people } = await withOrg(org.id, async (db) => ({
        lists: await loadCompanyLists(db, userId, now, language),
        completed: await countCompleted(db, userId, now),
        projects: await loadProjects(db, userId),
        // Людей компании приглашённый до входа не видит: роль из приглашения ещё не его.
        people: org.status === 'active' ? await loadPeople(db, org.role, userId) : [],
      }), { actorUserId: userId });
      // `manages` — право на раздел «Компания» именно в этой компании. Приложение по нему решает,
      // показывать ли кнопку на вкладке: у человека компаний может быть несколько, и в одной он
      // владелец, а в другой рядовой — без этого признака кнопка вела бы в чужую компанию или в
      // «не найдено».
      const manages = org.status === 'active' && (org.role === 'owner' || org.role === 'admin');
      return {
        org_id: org.id, name: org.name, kind: 'company' as const, invited: org.status === 'invited',
        manages, lists, completed_count: completed, projects, people,
      };
    }));
    // Личное пространство после переезда на проекты пустует: показывать пустую вкладку незачем
    // (спека projects-stage2). Показываем её, только пока в ней что-то есть.
    const shown = spaces.filter((sp) => sp.kind === 'company' || sp.lists.open.length || sp.completed_count > 0);
    res.json({
      lang: language, spaces: shown.length ? shown : spaces, in_progress: await loadInProgress(userId, language),
      announcements: await loadAnnouncements(userId, language, orgs),
    });
  });

  // «Прочёл, подтверждаю» в заслоне приложения (спека announcements). Чужое объявление — 404, как чужое дело.
  router.post('/announcements/:id/confirm', async (req, res) => {
    try {
      const done = await confirmAnnouncementForUser(req.miniappUser!.userId, req.params.id!, 'app');
      res.json({ ok: true, confirmed_at: new Date(done.confirmedAt).toISOString() });
    } catch (e) {
      handleError(res, e);
    }
  });

  /**
   * Дела выбранного человека (спека projects-stage2): владелец и админ смотрят, что у кого в работе,
   * не уходя в разговор с агентом. Только чтение: чужое дело закрывают не за человека.
   * Закрытый проект попадает сюда, только если смотрящий сам в её составе: граница та
   * же, что в RLS, роль её не снимает.
   */
  router.get('/people/:id/tasks', async (req, res) => {
    try {
      const { userId, language } = req.miniappUser!;
      const personId = req.params.id!;
      if (!UUID_RE.test(personId)) throw new AppError('not_found', 'Person not found');
      const orgs = (await withGlobal((db) => userOrgs(db, userId))).filter((o) => o.kind === 'company' && o.status === 'active');
      for (const org of orgs) {
        if (org.role !== 'owner' && org.role !== 'admin') continue;
        const found = await withOrg(org.id, async (db) => {
          const member = await db.query(
            `select u.display_name as name from memberships m join users u on u.id = m.user_id
              where m.org_id = $1 and m.user_id = $2 and m.status in ('active','invited')`, [org.id, personId]);
          if (!member.rowCount) return null;
          // Завершённые — в том же списке, внизу, свежие выше (владелец 30.09: отдельный раздел не нужен).
          // Потолок как у своих «Завершённых»: список отвечает «что сейчас», история — в «Итогах».
          const rows = await db.query(
            `(select * from tasks
               where assignee_user_id = $1 and status = any($2) and status <> 'done'
               order by (status = 'active') desc, due_date nulls last, created_at)
             union all
             (select * from tasks
               where assignee_user_id = $1 and status = 'done'
               order by status_changed_at desc limit $3)`, [personId, VISIBLE_STATUSES, COMPLETED_LIMIT]);
          return { name: member.rows[0].name as string, tasks: await cards(db, rows.rows as Task[], language, { withWhy: true, unreadFor: userId }) };
        }, { actorUserId: userId });
        if (found) { res.json({ lang: language, org_id: org.id, ...found }); return; }
      }
      throw new AppError('not_found', 'Person not found');
    } catch (e) {
      handleError(res, e);
    }
  });

  /**
   * Дела проекта: в «Компании → Проекты» проект открывается списком своих дел — кто
   * что делает, — а не одной строкой «видит вся компания». Владелец и админ; закрытый проект — только
   * если смотрящий в его составе (RLS проектов и дел, как у дел человека).
   */
  router.get('/projects/:id/tasks', async (req, res) => {
    try {
      const { userId, language } = req.miniappUser!;
      const projectId = req.params.id!;
      if (!UUID_RE.test(projectId)) throw new AppError('not_found', 'Project not found');
      const orgs = (await withGlobal((db) => userOrgs(db, userId))).filter((o) => o.kind === 'company' && o.status === 'active');
      for (const org of orgs) {
        if (org.role !== 'owner' && org.role !== 'admin') continue;
        const found = await withOrg(org.id, async (db) => {
          const project = await db.query('select name from projects where id = $1', [projectId]);
          if (!project.rowCount) return null;
          const rows = await db.query(
            `(select * from tasks
               where project_id = $1 and status = any($2) and status <> 'done'
               order by (status in ('active','in_progress')) desc, due_date nulls last, created_at)
             union all
             (select * from tasks
               where project_id = $1 and status = 'done'
               order by status_changed_at desc limit $3)`, [projectId, VISIBLE_STATUSES, COMPLETED_LIMIT]);
          const list = rows.rows as Task[];
          const ids = [...new Set(list.map((x) => x.assignee_user_id).filter((x): x is string => !!x))];
          const names = new Map<string, string>(ids.length
            ? (await db.query('select id, display_name from users where id = any($1::uuid[])', [ids])).rows.map((r) => [r.id as string, r.display_name as string])
            : []);
          const tasks = (await cards(db, list, language, { withWhy: true, unreadFor: userId }))
            .map((c, i) => ({ ...c, assignee_name: names.get(list[i]!.assignee_user_id ?? '') ?? null }));
          return { name: project.rows[0].name as string, tasks };
        }, { actorUserId: userId });
        if (found) { res.json({ lang: language, org_id: org.id, ...found }); return; }
      }
      throw new AppError('not_found', 'Project not found');
    } catch (e) {
      handleError(res, e);
    }
  });

  // Раздел «Завершённые» (спека completed-list): грузится отдельным запросом, по нажатию — основной
  // `/lists` и так самый горячий, а сюда заглядывают редко.
  router.get('/completed', async (req, res) => {
    const { userId, language } = req.miniappUser!;
    const now = new Date();
    const orgs = await withGlobal((db) => userOrgs(db, userId));
    const spaces = [];
    for (const org of orgs) {
      const tasks = await withOrg(org.id, (db) => loadCompletedTasks(db, userId, language, now), { actorUserId: userId });
      if (tasks.length) spaces.push({ org_id: org.id, name: org.name, kind: org.kind, tasks });
    }
    res.json({ lang: language, spaces });
  });

  // Вернуть дело, закрытое по ошибке (спека completed-list). Возврат — человеку, не агенту: агент,
  // передумавший насчёт принятого результата, идёт через `review_result(verdict: rework)` по своим правилам.
  router.post('/tasks/:id/reopen', async (req, res) => {
    try {
      const { userId } = req.miniappUser!;
      const found = await findTaskInUserOrgs(userId, req.params.id!);
      if (!found) throw new AppError('not_found', 'Task not found');
      const { orgId, task } = found;
      // Своё дело — то, которое ты закрыл (исполнитель), сам поставил человеком или принял как
      // проверяющий (спека task-reviewer). Чужое закрытое возвращает тот, кого оно касается, а не
      // любой участник организации.
      const mine = task.assignee_user_id === userId || (task.author_user_id === userId && !task.author_agent_id)
        || task.reviewer_user_id === userId;
      if (!mine) throw new AppError('forbidden', 'This is not your task');
      if (task.status !== 'done') throw new AppError('validation_failed', 'The task is not completed');
      const updated = await actIn(found, userId, 'other', (db) => transition(db, task.id, 'reopen', { kind: 'user', userId }));
      res.json({ ok: true, status: updated.status });
    } catch (e) {
      handleError(res, e);
    }
  });

  // Карточка дела внутри приложения (спека miniapp-task-card): то же дело, что в списке, но целиком —
  // «зачем», критерий готовности, материалы. Досье агента (`get_task`) приложение не зовёт: объём разный.
  router.get('/tasks/:id', async (req, res) => {
    try {
      const { userId, language } = req.miniappUser!;
      const found = await findVisibleTask(userId, req.params.id!);
      if (!found) throw new AppError('not_found', 'Task not found');
      // Замер (спека translation-prefetch): сколько стоит открыть карточку и сколько раз за это звали
      // модель. 0 вызовов — всё из кэша; N — столько полей и записей переводили, пока человек ждал.
      const t0 = Date.now();
      const { result: screen, calls } = await countLlmCalls(() => taskScreen(found.orgId, found.task, userId, language, { markViewed: true }));
      logger.info({ ms: Date.now() - t0, llm: calls, task: found.task.id, lang: language }, 'mini app: карточка открыта');
      res.json(screen);
    } catch (e) {
      handleError(res, e);
    }
  });

  router.post('/tasks/:id/done', async (req, res) => {
    try {
      const { userId } = req.miniappUser!;
      const taskId = req.params.id!;
      // Версия читается так же строго, как в остальных ручках (`optionalVersion`): `Number(true)`
      // давал единицу и проходил проверку — две политики на один параметр рано или поздно разойдутся.
      const version = req.body?.version;
      if (typeof version !== 'number' || !Number.isInteger(version)) {
        throw new AppError('validation_failed', 'Card version is required');
      }
      const found = await findAssignedTask(userId, taskId);
      if (!found) throw new AppError('not_found', 'Task not found');
      const { orgId, task } = found;
      const result = readResult(req.body?.result);
      // Личное ожидание «пришло» — закрывается как ожидание, а не сдачей результата.
      const action = task.kind === 'waiting' ? 'resolve_waiting' : 'submit';
      await actIn(found, userId, 'work', (db) => transition(db, taskId, action, { kind: 'user', userId }, { expectedVersion: version, result }));
      res.json({ ok: true });
    } catch (e) {
      handleError(res, e);
    }
  });

  // Остальные действия по делу (спека miniapp-task-actions): всё, что человек делает с делом в боте,
  // он делает и здесь. Кто вправе — тот же `findAssignedTask`, что у «Завершить»: чужое дело — 404.

  router.post('/tasks/:id/take', slotLimit, async (req, res) => {
    try {
      const { userId } = req.miniappUser!;
      const found = await findAssignedTask(userId, String(req.params.id));
      if (!found) throw new AppError('not_found', 'Task not found');
      // Тот же путь, что у «Взял» в боте: takeTask держит слот одним на человека и снимает прежнее
      // дело — через `transition` напрямую человек получал бы два «Сейчас» сразу (спека multi-company).
      await actIn(found, userId, 'work', (db) => takeTask(db, found.task.id, { kind: 'user', userId }, {
        expectedVersion: optionalVersion(req.body?.version),
      }));
      res.json({ ok: true });
    } catch (e) {
      handleError(res, e);
    }
  });

  /**
   * «Остановить»: дело уходит из «Сейчас» обратно в очередь, таймер встаёт. Пара к «Взял» —
   * человек сел не за то или его отвлекли, и держать дело взятым нечестно: слот занят, а работы нет.
   * Само дело никуда не девается, оно возвращается в общий список (спека mini-app).
   */
  router.post('/tasks/:id/stop', slotLimit, async (req, res) => {
    try {
      const { userId } = req.miniappUser!;
      const found = await findAssignedTask(userId, String(req.params.id));
      if (!found) throw new AppError('not_found', 'Task not found');
      // Остановка живёт в ядре: то же самое делает кнопка бота, и расходиться им нельзя.
      await actIn(found, userId, 'other', (db) => stopTask(db, found.task.id, userId, {
        expectedVersion: optionalVersion(req.body?.version),
      }));
      res.json({ ok: true });
    } catch (e) {
      handleError(res, e);
    }
  });

  // Перенос считается графиком исполнителя — тем же, что у бота: иначе «завтра» в приложении и
  // «завтра» в чате оказались бы разными днями.
  router.post('/tasks/:id/postpone', async (req, res) => {
    try {
      const { userId } = req.miniappUser!;
      const days = POSTPONE_DAYS[String(req.body?.to)];
      if (days === undefined) throw new AppError('validation_failed', 'to must be tomorrow, day_after or week');
      const found = await findAssignedTask(userId, req.params.id!);
      if (!found) throw new AppError('not_found', 'Task not found');
      const dueDate = await actIn(found, userId, 'work', async (db) => {
        const schedule = await loadUserSchedule(db, userId);
        const date = localDatePlusDays(schedule, new Date(), days);
        await transition(db, found.task.id, 'postpone', { kind: 'user', userId }, {
          postponeTo: date, expectedVersion: optionalVersion(req.body?.version),
        });
        return date;
      });
      res.json({ ok: true, due_date: dueDate });
    } catch (e) {
      handleError(res, e);
    }
  });

  // Срок — календарём в карточке (спека self-set-due): ставят исполнитель, автор и
  // owner/admin, статус не меняется. Не `findAssignedTask`: срок ставит не только исполнитель.
  router.post('/tasks/:id/due', async (req, res) => {
    try {
      const { userId, language } = req.miniappUser!;
      const date = req.body?.date;
      if (typeof date !== 'string') throw new AppError('validation_failed', 'date — format YYYY-MM-DD');
      const found = await findActingTask(userId, req.params.id!);
      if (!found) throw new AppError('not_found', 'Task not found');
      const task = await actIn(found, userId, 'work', (db) => setDueDate(db, {
        taskId: found.task.id, date, actor: { kind: 'user', userId }, source: 'app', version: optionalVersion(req.body?.version),
      }));
      res.json(await taskScreen(found.orgId, task, userId, language));
    } catch (e) {
      handleError(res, e);
    }
  });

  // «Попросить срок»: автор или owner/admin просит исполнителя назвать срок сам.
  router.post('/tasks/:id/due-request', async (req, res) => {
    try {
      const { userId, language } = req.miniappUser!;
      const text = typeof req.body?.text === 'string' ? req.body.text : null;
      const found = await findActingTask(userId, req.params.id!);
      if (!found) throw new AppError('not_found', 'Task not found');
      const task = await actIn(found, userId, 'other', async (db) => {
        await requestDue(db, { taskId: found.task.id, actor: { kind: 'user', userId }, text });
        return (await db.query('select * from tasks where id = $1', [found.task.id])).rows[0] as Task;
      });
      res.json(await taskScreen(found.orgId, task, userId, language));
    } catch (e) {
      handleError(res, e);
    }
  });

  // Вопрос агенту и «Непонятно» — одна ручка: разница только в том, чем дело блокировано.
  router.post('/tasks/:id/question', async (req, res) => {
    try {
      const { userId } = req.miniappUser!;
      const kind = req.body?.kind;
      if (kind !== 'question' && kind !== 'unclear') throw new AppError('validation_failed', 'kind must be question or unclear');
      const text = requireText(req.body?.text);
      const found = await findAssignedTask(userId, req.params.id!);
      if (!found) throw new AppError('not_found', 'Task not found');
      await actIn(found, userId, 'work', async (db) => {
        await assertAskLimit(db, found.task.id, userId);
        return transition(db, found.task.id, kind, { kind: 'user', userId }, {
          text, expectedVersion: optionalVersion(req.body?.version),
        });
      });
      res.json({ ok: true });
    } catch (e) {
      handleError(res, e);
    }
  });

  router.post('/tasks/:id/decline', async (req, res) => {
    try {
      const { userId } = req.miniappUser!;
      const text = requireText(req.body?.text);
      const found = await findAssignedTask(userId, req.params.id!);
      if (!found) throw new AppError('not_found', 'Task not found');
      // От своего дела не отказываются — удаляют или откладывают; отказ отклоняет ядро (`transition`).
      // Отказ от дела компании, куда лишь позвали, — не вход: приглашение отклоняется.
      await actIn(found, userId, 'decline', (db) => transition(db, found.task.id, 'decline', { kind: 'user', userId }, {
        text, expectedVersion: optionalVersion(req.body?.version),
      }));
      res.json({ ok: true });
    } catch (e) {
      handleError(res, e);
    }
  });

  // Реплика к делу из приложения (спека task-comments): задачу не двигает, агент читает её в сводке.
  router.post('/tasks/:id/comment', async (req, res) => {
    try {
      const { userId } = req.miniappUser!;
      const text = typeof req.body?.text === 'string' ? req.body.text : '';
      const found = await findTaskInUserOrgs(userId, req.params.id!);
      if (!found) throw new AppError('not_found', 'Task not found');
      await actIn(found, userId, 'work', (db) => addHumanComment(db, found.task.id, userId, text));
      res.json({ ok: true });
    } catch (e) {
      handleError(res, e);
    }
  });

  // Фото и скриншоты к делу (спека task-photos). Тело — само изображение: `express.raw` только на этой
  // ручке, общий `express.json` на 256 КБ остаётся как есть. Права — ядро (`attachImage`, как у реплики).
  router.post('/tasks/:id/attachments', photoLimit, express.raw({ type: 'image/*', limit: '20mb' }), async (req, res) => {
    try {
      const { userId } = req.miniappUser!;
      const found = await findVisibleTask(userId, req.params.id as string);
      // Завершённое дело карточка открывает, но прикреплять к нему не к чему — как чужое.
      if (!found || CLOSED_STATUSES.includes(found.task.status)) throw new AppError('not_found', 'Task not found');
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        res.status(415).json({ code: 'unsupported_media_type', message: 'Send an image: image/jpeg, image/png or image/webp' });
        return;
      }
      // Разбор — до транзакции: соединение базы не держится, пока картинка ждёт очереди декодера.
      const image = await cleanImage(req.body as Buffer);
      const added = await actIn(found, userId, 'work', (db) => attachImage(db, { taskId: found.task.id, userId, image, now: new Date() }));
      res.json({ id: added.id, photos: added.photos });
    } catch (e) {
      if (e instanceof UnsupportedImageError) {
        res.status(415).json({ code: 'unsupported_media_type', message: 'This image cannot be read: send a JPEG, PNG or WebP photo' });
        return;
      }
      handleError(res, e);
    }
  });

  // Фото дела — список для ряда миниатюр: автор и когда. У фото из группы автор — у её сообщения.
  router.get('/tasks/:id/attachments', async (req, res) => {
    try {
      const { userId } = req.miniappUser!;
      const found = await findVisibleTask(userId, req.params.id!);
      if (!found) throw new AppError('not_found', 'Task not found');
      const rows = await withOrg(found.orgId, async (db) => (await db.query(
        `select a.id, a.source, a.created_at, u.display_name as author
           from task_attachments a
           left join group_messages gm on gm.id = a.message_id
           left join users u on u.id = coalesce(a.author_user_id, gm.author_user_id)
          where a.task_id = $1 order by a.created_at, a.id`, [found.task.id])).rows, { actorUserId: userId });
      res.json({
        attachments: rows.map((a) => ({
          id: a.id as string, source: a.source as string, author: (a.author as string | null) ?? null, at: new Date(a.created_at).toISOString(),
        })),
      });
    } catch (e) {
      handleError(res, e);
    }
  });

  // Само фото. Видно тому, кому видно дело: дело — через `findVisibleTask` (закрытые доски режет RLS
  // дел), вложение — только этого дела. Кэш частный: картинка не должна лечь в общий кэш прокси.
  router.get('/tasks/:id/attachments/:attId', async (req, res) => {
    try {
      const { userId } = req.miniappUser!;
      const attId = req.params.attId!;
      const found = UUID_RE.test(attId) ? await findVisibleTask(userId, req.params.id!) : null;
      if (!found) throw new AppError('not_found', 'Attachment not found');
      const path = await withOrg(found.orgId, async (db) => (await db.query(
        `select m.path from task_attachments a join media m on m.id = a.media_id where a.id = $1 and a.task_id = $2`,
        [attId, found.task.id])).rows[0]?.path as string | undefined, { actorUserId: userId });
      if (!path) throw new AppError('not_found', 'Attachment not found');
      let file: Buffer;
      try { file = await readMediaFile(path); } catch { throw new AppError('not_found', 'Attachment file is unavailable'); }
      res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'private, max-age=3600').send(file);
    } catch (e) {
      handleError(res, e);
    }
  });

  router.post('/personal/reorder', async (req, res) => {
    try {
      const { userId } = req.miniappUser!;
      const ids = req.body?.ids;
      if (!Array.isArray(ids) || !ids.length || !ids.every((v) => typeof v === 'string' && UUID_RE.test(v))) {
        throw new AppError('validation_failed', 'ids list is required');
      }
      const orgId = await withGlobal((db) => ensurePersonalOrg(db, userId));
      await withOrg(orgId, async (db) => {
        const cur = await db.query(`select id from tasks where id = any($1::uuid[]) and assignee_user_id = $2`, [ids, userId]);
        if (cur.rowCount !== ids.length) throw new AppError('not_found', 'Personal task not found');
        // Личные дела не привязаны к плану — позиция просто повторяет порядок присланных ids.
        for (let i = 0; i < ids.length; i++) {
          await db.query('update tasks set position = $2, version = version + 1, updated_at = now() where id = $1', [ids[i], i]);
        }
      }, { actorUserId: userId });
      res.json({ ok: true });
    } catch (e) {
      handleError(res, e);
    }
  });

  // Звёздочка «важно» у личного дела. Это не добавление задачи, а пометка своего.
  router.post('/personal/:id/important', async (req, res) => {
    try {
      const { userId } = req.miniappUser!;
      const taskId = req.params.id!;
      if (!UUID_RE.test(taskId)) throw new AppError('not_found', 'Personal task not found');
      const important = req.body?.important === true;
      const orgId = await withGlobal((db) => ensurePersonalOrg(db, userId));
      const updated = await withOrg(orgId, (db) => db.query(
        `update tasks set priority = $3, version = version + 1, updated_at = now()
          where id = $1 and assignee_user_id = $2 and status in ('ready','scheduled','waiting') returning id`,
        [taskId, userId, important ? 'urgent' : 'normal'],
      ), { actorUserId: userId });
      if (!updated.rowCount) throw new AppError('not_found', 'Personal task not found');
      res.json({ ok: true });
    } catch (e) {
      handleError(res, e);
    }
  });

  /**
   * «Отложить» и «Вернуть в список» у личного дела (спека miniapp-task-actions).
   * Отложенное не исчезает и не переносится на дату — оно уезжает в свёрнутый раздел «Когда-нибудь»,
   * откуда его достают той же кнопкой. Статус дела при этом не меняется: это разбор списка, а не
   * движение работы.
   */
  router.post('/personal/:id/someday', async (req, res) => {
    try {
      const { userId } = req.miniappUser!;
      const taskId = req.params.id!;
      if (!UUID_RE.test(taskId)) throw new AppError('not_found', 'Personal task not found');
      // Обратно дело возвращается в «Дела» (`do`) — это список действий, с которого всё начинается.
      const category = req.body?.someday === true ? 'someday' : 'do';
      const orgId = await withGlobal((db) => ensurePersonalOrg(db, userId));
      const updated = await withOrg(orgId, (db) => db.query(
        `update tasks set category = $3, version = version + 1, updated_at = now()
          where id = $1 and assignee_user_id = $2 and status in ('ready','scheduled','waiting') returning id`,
        [taskId, userId, category],
      ), { actorUserId: userId });
      if (!updated.rowCount) throw new AppError('not_found', 'Personal task not found');
      res.json({ ok: true, category });
    } catch (e) {
      handleError(res, e);
    }
  });

  // Пометка «рабочее» у личного дела (спека owner-feedback): в приложении её снимают, org_id — поставить.
  router.post('/personal/:id/share', async (req, res) => {
    try {
      const { userId } = req.miniappUser!;
      const taskId = req.params.id!;
      const orgRef = req.body?.org_id ?? null;
      if (orgRef !== null && (typeof orgRef !== 'string' || !UUID_RE.test(orgRef))) {
        throw new AppError('validation_failed', 'org_id must be the id of your company or null');
      }
      const orgId = await withGlobal((db) => ensurePersonalOrg(db, userId));
      await withOrg(orgId, (db) => setTaskShare(db, taskId, userId, orgRef), { actorUserId: userId });
      res.json({ ok: true });
    } catch (e) {
      handleError(res, e);
    }
  });

  router.delete('/personal/:id', async (req, res) => {
    try {
      const { userId } = req.miniappUser!;
      const taskId = req.params.id!;
      if (!UUID_RE.test(taskId)) throw new AppError('not_found', 'Personal task not found');
      const orgId = await withGlobal((db) => ensurePersonalOrg(db, userId));
      const exists = await withOrg(orgId, async (db) => {
        const r = await db.query('select 1 from tasks where id = $1 and assignee_user_id = $2', [taskId, userId]);
        return Boolean(r.rowCount);
      }, { actorUserId: userId });
      if (!exists) throw new AppError('not_found', 'Personal task not found');
      await withOrg(orgId, (db) => transition(db, taskId, 'cancel', { kind: 'user', userId }), { actorUserId: userId });
      res.json({ ok: true });
    } catch (e) {
      handleError(res, e);
    }
  });

  // Сколько живёт подпись приложения для выпуска долгоживущего токена.
  const TOKEN_FRESH_MS = 15 * 60_000;
  // Долгоживущий токен — только из свежеоткрытого приложения: подпись initData живёт сутки, и
  // утёкшая строка иначе превращалась бы в постоянный доступ (ревью 08.10). Подпись уже проверена
  // authMiddleware, здесь — только её возраст. Общая для токенов чтения и токенов агентов.
  const freshSession = (req: Request, res: Response, next: NextFunction): void => {
    const authDate = Number(new URLSearchParams(req.header('X-Telegram-Init-Data') ?? '').get('auth_date'));
    if (!Number.isFinite(authDate) || Date.now() - authDate * 1000 > TOKEN_FRESH_MS) {
      res.status(401).json({ code: 'stale_session', message: 'Reopen the app to issue a token' });
      return;
    }
    next();
  };

  // «Доступ для программ» (спека read-tokens): токен только на чтение выпускает и отзывает сам
  // человек здесь, а не в разговоре с Claude — токен не должен попадать в переписку модели.
  router.get('/read-tokens', async (req, res) => {
    const tokens = await listReadTokens(req.miniappUser!.userId);
    res.json(tokens.map((t) => ({
      id: t.id, label: t.label, created_at: new Date(t.created_at).toISOString(),
      last_used_at: t.last_used_at ? new Date(t.last_used_at).toISOString() : null,
    })));
  });

  router.post('/read-tokens', freshSession, async (req, res) => {
    try {
      const issued = await issueReadToken(req.miniappUser!.userId, req.body?.label);
      // Показывается один раз: ни список, ни повторный запрос его больше не отдадут.
      res.set('Cache-Control', 'no-store').json(issued);
    } catch (e) {
      handleError(res, e);
    }
  });

  router.delete('/read-tokens/:id', async (req, res) => {
    try {
      await revokeReadToken(req.miniappUser!.userId, req.params.id!);
      res.json({ ok: true });
    } catch (e) {
      handleError(res, e);
    }
  });

  // Токены агентов (спека agent-tokens): серверная программа ставит задачи и тревоги от имени
  // агента. Выпускает и отзывает их только владелец компании — и тоже здесь, не в разговоре с моделью.
  router.get('/agent-tokens', async (req, res) => {
    try {
      const tokens = await listAgentTokens(String(req.query.org ?? ''), req.miniappUser!.userId);
      res.set('Cache-Control', 'no-store').json(tokens.map((t) => ({
        id: t.id, label: t.label, agent_id: t.agent_id, agent_name: t.agent_name,
        created_at: new Date(t.created_at).toISOString(), expires_at: new Date(t.expires_at).toISOString(),
        last_used_at: t.last_used_at ? new Date(t.last_used_at).toISOString() : null,
      })));
    } catch (e) {
      handleError(res, e);
    }
  });

  router.post('/agent-tokens', freshSession, async (req, res) => {
    try {
      const issued = await issueAgentToken(req.body?.org, req.miniappUser!.userId, req.body?.agent, req.body?.label);
      // Показывается один раз: ни список, ни повторный запрос его больше не отдадут.
      res.set('Cache-Control', 'no-store').json({ id: issued.id, token: issued.token, expires_at: new Date(issued.expires_at).toISOString() });
    } catch (e) {
      handleError(res, e);
    }
  });

  router.delete('/agent-tokens/:id', async (req, res) => {
    try {
      await revokeAgentToken(String(req.query.org ?? ''), req.miniappUser!.userId, req.params.id!);
      res.json({ ok: true });
    } catch (e) {
      handleError(res, e);
    }
  });

  app.use('/app/api', router);

  // Статика Mini App: index.html — без кэша (иначе Telegram WebView держит старую сборку).
  app.use('/app', express.static(DIST_DIR, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
}
