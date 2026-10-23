import type { Db } from '../db/pool.js';
import { daysLabel, humanDate, t } from '../i18n/index.js';
import { localDate, loadUserSchedule } from '../core/calendar.js';
import { companyNameIfMany } from '../core/people.js';
import { taskKey } from '../core/projects.js';
import { translateField } from '../ai/translate.js';
import { logger } from '../log.js';
import { bold, clip, esc } from './html.js';
import { takeStillOpen } from './take-prompt.js';

const STUCK_DAYS_FALLBACK = 2; // должно совпадать с worker/timers.ts STUCK_DAYS — только на случай старого payload без days

// Реплика человека в сообщении не должна вытолкнуть его за предел Telegram (4096): остальное — в карточке.
const QUOTE_LIMIT = 2500;
const SUBJECT_LIMIT = 800;
const LINE_QUOTE_LIMIT = 200;

// Текст уведомления по виду (реестр — core/notification-kinds.ts) — общее между доставкой в бот
// (deliver.ts), /feed и дайджестом. Вид рендерится в части — что случилось, предмет, реплика, — а
// собираются они двумя способами: отдельным сообщением с разметкой (спека bot-messages,
// «Оформление») и одной простой строкой для ленты и дайджеста. Разметку ставит только сборка:
// строки локализации — простой текст, и значения из данных экранируются ровно в одном месте.

export interface NotifRow {
  id: string;
  kind: string;
  level: string;
  task_id: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
}

/** Уведомление по частям — всё простым текстом, ещё не экранированным. */
interface NotifParts {
  head: string;          // что случилось
  subject?: string;      // предмет: название задачи, имена агентов
  meta?: string;         // о каком деле: обозначение и на ком оно
  body?: string;         // пояснение отдельным абзацем
  items?: string[];      // список (склейка напоминаний)
  quote?: string;        // реплика человека
}

/** Задача с полями, по которым её название переводится тем же кэшем, что у карточки. */
export interface TitledTask { id: string; title: string; source_language: string | null }

/**
 * Название задачи на языке получателя (спека bot-messages, «Язык получателя»): тот же вызов, что у
 * карточки (bot/cards.ts), — тот же ключ кэша `translations`. Пауза бюджета и сбой модели отдают
 * оригинал — сообщение уходит, а не теряется.
 */
export async function translatedTitle(db: Db, task: TitledTask, lang: string, opts: { cacheOnly?: boolean } = {}): Promise<string> {
  const source = task.source_language ?? 'ru';
  if (source === lang || !task.title.trim()) return task.title;
  const r = await translateField(db, { objectType: 'task', objectId: task.id, field: 'title', text: task.title, sourceLang: source, targetLang: lang, cacheOnly: opts.cacheOnly });
  return r.text;
}

interface TaskInfo {
  title: string; key: string | null; assigneeId: string; assigneeName: string; dueDate: string | null; createdAt: Date;
}

async function taskInfo(db: Db, taskId: string, lang: string): Promise<TaskInfo | null> {
  const r = await db.query(
    `select t.id, t.title, t.source_language, t.due_date, t.created_at, t.number, p.key as project_key,
            t.assignee_user_id, u.display_name as assignee_name
       from tasks t join users u on u.id = t.assignee_user_id left join projects p on p.id = t.project_id
      where t.id = $1`,
    [taskId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    title: await translatedTitle(db, row as TitledTask, lang), key: taskKey(row.project_key, row.number),
    assigneeId: row.assignee_user_id, assigneeName: row.assignee_name, dueDate: row.due_date, createdAt: row.created_at,
  };
}

/** Кто написал последнюю реплику такого вида: человек или агент. Нет — назвать нечем. */
async function lastAuthor(db: Db, taskId: string, kinds: string[]): Promise<string | null> {
  const r = await db.query(
    `select coalesce(a.name, u.display_name, '') as name from task_messages m
       left join users u on u.id = m.author_user_id left join agents a on a.id = m.author_agent_id
      where m.task_id = $1 and m.kind = any($2) order by m.created_at desc limit 1`,
    [taskId, kinds]);
  const name = String(r.rows[0]?.name ?? '').trim();
  return name || null;
}

/**
 * Последняя реплика такого вида — на языке того, кто её читает (спека translation-and-email).
 * Переводится не только карточка: вопрос вьетнамца русскоязычному постановщику приходил как есть, и
 * обещание «каждый работает на своём языке» держалось ровно в одну сторону.
 */
async function lastMessage(db: Db, taskId: string, kinds: string[], lang: string): Promise<string> {
  const r = await db.query(
    `select id, text, source_language from task_messages where task_id = $1 and kind = any($2) order by created_at desc limit 1`,
    [taskId, kinds],
  );
  const row = r.rows[0] as { id: string; text: string; source_language: string | null } | undefined;
  if (!row?.text.trim()) return row?.text ?? '';
  // Язык не распознан (короткая реплика вроде «ок») — переводить нечего и не из чего.
  const source = row.source_language;
  if (!source || source === lang) return row.text;
  const tr = await translateField(db, {
    objectType: 'task_message', objectId: row.id, field: 'text', text: row.text, sourceLang: source, targetLang: lang,
  });
  return tr.text;
}

/**
 * Объявление для уведомления (спека announcements): автор по id и текст на языке читающего — через
 * тот же кэш `translations`, что у реплик. Модель недоступна или пауза бюджета — приходит оригинал:
 * объявление не должно теряться из-за перевода.
 */
async function announcementFor(
  db: Db, n: NotifRow, lang: string, recipientUserId: string,
): Promise<{ head: string; text: string } | null> {
  const announcementId = n.payload.announcement_id;
  if (typeof announcementId !== 'string') return null;
  // Подтвердил раньше, чем дошло (тихие часы, второе устройство): слать нечего, доставка пропустит.
  const done = await db.query(
    'select 1 from announcement_recipients where announcement_id = $1 and user_id = $2 and confirmed_at is not null', [announcementId, recipientUserId]);
  if (done.rowCount) return null;
  // Раунд тревоги, снятой до доставки (тихие часы), не шлём: событие уже наступило (спека announcement-alerts).
  const r = await db.query(
    `select coalesce(a.alert_id, a.id) as translation_id, a.text, a.source_language, u.display_name as author
       from announcements a join users u on u.id = a.author_user_id left join announcement_alerts al on al.id = a.alert_id
      where a.id = $1 and al.resolved_at is null`,
    [announcementId]);
  const row = r.rows[0] as { translation_id: string; text: string; source_language: string | null; author: string } | undefined;
  if (!row?.text.trim()) return null;
  // Объявление от агента подписано честно: «от <человек> через агента <агент>». Имя агента — по id при показе.
  const agent = typeof n.payload.agent_id === 'string'
    ? String((await db.query('select name from agents where id = $1', [n.payload.agent_id])).rows[0]?.name ?? '').trim() : '';
  const head = agent ? t(lang, `notif.${n.kind}_via`, { name: row.author, agent }) : t(lang, `notif.${n.kind}`, { name: row.author });
  if (!row.source_language || row.source_language === lang) return { head, text: row.text };
  const tr = await translateField(db, {
    objectType: 'announcement', objectId: row.translation_id, field: 'text', text: row.text, sourceLang: row.source_language, targetLang: lang,
  });
  return { head, text: tr.text };
}

/** Имя приглашённого: имя в профиле, иначе почта. Нет приглашения — назвать нечем. */
async function invitedName(db: Db, invitationId: unknown): Promise<string | null> {
  if (typeof invitationId !== 'string') return null;
  const r = await db.query(
    `select i.email, u.display_name from invitations i left join users u on u.id = i.user_id where i.id = $1`, [invitationId]);
  const row = r.rows[0] as { email: string; display_name: string | null } | undefined;
  if (!row) return null;
  return row.display_name?.trim() || row.email || null;
}

/** Имена агентов по id из payload, через запятую. Пусто — назвать нечем. */
async function agentNames(db: Db, ids: unknown): Promise<string | null> {
  const list = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
  if (!list.length) return null;
  const r = await db.query('select name from agents where id = any($1::uuid[]) order by name', [list]);
  const names = r.rows.map((x) => String(x.name).trim()).filter(Boolean);
  return names.length ? names.join(', ') : null;
}

/** Имя человека по id, запасной вариант — имя, записанное в payload старыми версиями. */
async function userName(db: Db, userId: unknown, fallback: unknown): Promise<string | null> {
  if (typeof userId === 'string') {
    const r = await db.query('select display_name from users where id = $1', [userId]);
    const name = String(r.rows[0]?.display_name ?? '').trim();
    if (name) return name;
  }
  const old = typeof fallback === 'string' ? fallback.trim() : '';
  return old && old !== '?' ? old : null;
}

/**
 * «?» вместо имени не показывается никогда (спека bot-messages): назвать нечем — уведомление не
 * шлётся, а в журнал пишется, какое и почему, — это ошибка источника, а не повод для загадки.
 */
function unnamed(n: NotifRow): null {
  logger.warn({ notification: n.id, kind: n.kind, payload: n.payload }, 'notif-text: нечем назвать человека или агента — уведомление не отправлено');
  return null;
}

/** Кто попросил назвать срок: эта просьба, а без id — последняя по делу. Пусто — назвать нечем. */
async function dueRequester(db: Db, taskId: string, requestId: unknown): Promise<string | null> {
  const r = await db.query(
    `select coalesce(a.name, u.display_name, '') as name from task_messages m
       left join users u on u.id = m.author_user_id left join agents a on a.id = m.author_agent_id
      where m.task_id = $1 and m.kind = 'due_request' and ($2::uuid is null or m.id = $2::uuid)
      order by m.created_at desc limit 1`,
    [taskId, typeof requestId === 'string' ? requestId : null]);
  const name = String(r.rows[0]?.name ?? '').trim();
  return name || null;
}

const REMINDER_STAGE_KEY: Record<string, string> = {
  ack: 'reminder.ack', due_tomorrow: 'reminder.due_tomorrow',
  overdue_1: 'reminder.overdue', overdue_3: 'reminder.overdue', overdue_7: 'reminder.overdue',
};

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
}

async function renderParts(db: Db, lang: string, n: NotifRow, recipientUserId: string): Promise<NotifParts | null> {
  const task = n.task_id ? await taskInfo(db, n.task_id, lang) : null;
  // О каком деле — обозначение и на ком оно: «Комментарий к задаче» с одним названием не
  // говорил ни чьё это дело, ни кто написал. Самому исполнителю «исполнитель: он сам» не пишем.
  // Заголовок уже называет исполнителя («Мария: задача закрыта») — второй раз имя не пишем (ревью 07.10).
  const metaFor = (head: string): string | undefined => {
    if (!task) return undefined;
    const named = task.assigneeId === recipientUserId || head.includes(task.assigneeName);
    return [task.key, named ? null : t(lang, 'notif.assignee', { name: task.assigneeName })].filter(Boolean).join(' · ') || undefined;
  };
  const withTask = (head: string, quote?: string): NotifParts | null => (task ? { head, subject: task.title, meta: metaFor(head), quote } : null);
  const by = async (kinds: string[], key: string, plain: string): Promise<string> => {
    const name = n.task_id ? await lastAuthor(db, n.task_id, kinds) : null;
    return name ? t(lang, key, { name }) : t(lang, plain);
  };
  const reply = async (kinds: string[]): Promise<string> => (n.task_id ? lastMessage(db, n.task_id, kinds, lang) : '');

  switch (n.kind) {
    case 'task_now': return withTask(t(lang, 'notif.task_now'));
    case 'task_updated': return withTask(t(lang, 'notif.task_updated'));
    case 'task_changed_by_manager': return withTask(t(lang, 'notif.task_changed_by_manager'));
    case 'task_answer': return task ? withTask(await by(['answer'], 'notif.task_answer_by', 'notif.task_answer'), await reply(['answer'])) : null;
    case 'task_rework': return withTask(t(lang, 'notif.task_rework'));
    case 'task_reviewer_assigned': return withTask(t(lang, 'notif.task_reviewer_assigned'));
    // Постановщику — итог чужой проверки (спека task-reviewer): кто вернул, чей результат и почему.
    case 'task_returned':
      return task ? withTask(await by(['rework_reason'], 'notif.task_returned_by', 'notif.task_returned'), await reply(['rework_reason'])) : null;
    case 'maybe_done': return withTask(t(lang, 'notif.maybe_done'));
    // Объявление — без дела: текст и есть содержание, а кнопка «Прочёл, подтверждаю» — под ним (deliver.ts).
    case 'announcement':
    case 'announcement_reminder': {
      const a = await announcementFor(db, n, lang, recipientUserId);
      return a ? { head: a.head, quote: a.text } : null;
    }
    case 'task_comment': {
      if (!task) return null;
      const kinds = ['comment', 'owner_instruction'];
      return withTask(await by(kinds, 'notif.task_comment_by', 'notif.task_comment'), await reply(kinds));
    }
    case 'task_photo': {
      if (!task) return null;
      const name = await userName(db, n.payload.by_user_id, null);
      return name ? withTask(t(lang, 'notif.task_photo', { name })) : unnamed(n);
    }
    // «Берёшь сейчас?» и «Пора браться» (спека auto-start): дело начали, закрыли, отдали другому или
    // увели из очереди, пока уведомление ждало, — звать не к чему, доставка пропустит.
    case 'take_prompt':
    case 'take_reminder':
      if (!task || !n.task_id || !(await takeStillOpen(db, n.task_id, recipientUserId, n.created_at))) return null;
      return withTask(t(lang, `notif.${n.kind}`));
    case 'task_cancelled': return withTask(t(lang, 'notif.task_cancelled'));
    case 'task_closed':
      return task ? withTask(await by(['close_reason'], 'notif.task_closed_by', 'notif.task_closed'), await reply(['close_reason'])) : null;
    case 'task_submitted': return task ? withTask(t(lang, 'owner_task.submitted_notice', { name: task.assigneeName })) : null;
    // Молчание проверяющего (спека task-reviewer): ему — напоминание, постановщику — кто и сколько тянет.
    // Часы — рабочие, проверяющего: именно столько он на самом деле мог посмотреть.
    case 'review_reminder':
      return task ? withTask(t(lang, 'notif.review_reminder', { name: task.assigneeName, hours: Number(n.payload.hours ?? 0) })) : null;
    case 'review_overdue': {
      if (!task) return null;
      const reviewer = await userName(db, n.payload.reviewer_id, null);
      if (!reviewer) return unnamed(n);
      const parts = withTask(t(lang, 'notif.review_overdue', { reviewer, name: task.assigneeName }));
      return parts && { ...parts, body: t(lang, 'notif.review_overdue_body', { hours: Number(n.payload.hours ?? 0) }) };
    }
    case 'task_question':
      return task ? withTask(t(lang, 'owner_task.question_notice', { name: task.assigneeName }), await reply(['question'])) : null;
    case 'task_unclear':
      return task ? withTask(t(lang, 'owner_task.unclear_notice', { name: task.assigneeName }), await reply(['unclear'])) : null;
    case 'not_acknowledged': return task ? withTask(t(lang, 'notif.not_acknowledged', { name: task.assigneeName })) : null;
    case 'task_declined':
      return task ? withTask(t(lang, 'notif.task_declined', { name: task.assigneeName }), await reply(['decline_reason'])) : null;
    case 'question_unanswered': return task ? withTask(t(lang, 'notif.question_unanswered', { name: task.assigneeName })) : null;
    case 'person_stuck': {
      if (!task) return null;
      const days = Number(n.payload.days ?? STUCK_DAYS_FALLBACK);
      return withTask(t(lang, 'notif.person_stuck', { name: task.assigneeName, days: daysLabel(lang, days) }));
    }
    case 'estimate_diverged': return withTask(t(lang, 'notif.estimate_diverged'));
    case 'waiting_check': {
      if (!task) return null;
      // Сколько ждём — словами, а не датой из базы: «ждём 10 дней» (спека bot-messages).
      const { tz } = await loadUserSchedule(db, recipientUserId);
      const days = Math.max(0, daysBetween(localDate(new Date(), tz), localDate(task.createdAt, tz)));
      return withTask(t(lang, 'notif.waiting_check', { days: daysLabel(lang, days) }));
    }
    case 'timer_check': return withTask(t(lang, 'notif.timer_check'));
    case 'timer_autostopped': {
      const reason = n.payload.reason === 'day_end' ? 'day_end' : 'idle';
      return withTask(t(lang, `notif.timer_autostopped_${reason}`, { minutes: Number(n.payload.minutes ?? 0) }));
    }
    case 'external_overdue': return withTask(t(lang, 'notif.external_overdue'));
    // Исполнителю принятое называем его словами: «Ахмет: задача закрыта» самому Ахмету читается чужим (спека task-reviewer).
    case 'task_done':
      if (!task) return null;
      return withTask(task.assigneeId === recipientUserId ? t(lang, 'notif.task_done_yours') : t(lang, 'notif.task_done', { name: task.assigneeName }));
    case 'task_reopened': return task ? withTask(t(lang, 'notif.task_reopened', { name: task.assigneeName })) : null;
    case 'person_offboarded': return task ? withTask(t(lang, 'notif.person_offboarded', { name: task.assigneeName })) : null;
    // Срок называет исполнитель (спека self-set-due). Дата — словами, в поясе получателя.
    case 'due_set': {
      if (!task) return null;
      const date = typeof n.payload.to === 'string' ? n.payload.to : task.dueDate;
      if (!date) return null;
      const { tz } = await loadUserSchedule(db, recipientUserId);
      return withTask(t(lang, 'notif.due_set', { name: task.assigneeName, date: humanDate(lang, date, localDate(new Date(), tz)) }));
    }
    case 'due_request':
    case 'due_request_reminder': {
      if (!task || !n.task_id) return null;
      // Кто просит — по самой просьбе: имя человека или агента. Просьбу успели погасить — сказать
      // «выберите дату» всё равно честно, а имя просто не называем.
      const by = await dueRequester(db, n.task_id, n.payload.request_id);
      return {
        head: t(lang, n.kind === 'due_request' ? 'notif.due_request' : 'notif.due_request_reminder'), subject: task.title,
        body: by ? t(lang, 'notif.due_request_body', { name: by }) : t(lang, 'notif.due_request_body_plain'),
        // Зачем нужен срок — словами просившего, на языке читающего.
        quote: await reply(['due_request']),
      };
    }
    case 'due_set_from_chat': {
      if (!task) return null;
      const date = typeof n.payload.to === 'string' ? n.payload.to : task.dueDate;
      if (!date) return null;
      const chat = typeof n.payload.chat === 'string' && n.payload.chat.trim() ? n.payload.chat.trim() : 'Telegram';
      const { tz } = await loadUserSchedule(db, recipientUserId);
      return withTask(t(lang, 'notif.due_set_from_chat', { chat, date: humanDate(lang, date, localDate(new Date(), tz)) }));
    }
    case 'due_request_ignored': return task ? withTask(t(lang, 'notif.due_request_ignored', { name: task.assigneeName })) : null;
    case 'reminder': {
      if (!task) return null;
      const stage = String(n.payload.stage ?? '');
      const key = REMINDER_STAGE_KEY[stage] ?? 'notif.task_now';
      const { tz } = await loadUserSchedule(db, recipientUserId);
      const date = task.dueDate ? humanDate(lang, task.dueDate, localDate(new Date(), tz)) : '';
      return withTask(t(lang, key, { date }));
    }
    case 'reminder_digest': {
      const ids = (n.payload.task_ids as string[] | undefined) ?? [];
      if (!ids.length) return null;
      const r = await db.query('select id, title, source_language from tasks where id = any($1::uuid[]) order by created_at', [ids]);
      const items: string[] = [];
      for (const row of r.rows as TitledTask[]) items.push(await translatedTitle(db, row, lang));
      return items.length ? { head: t(lang, 'reminder.digest'), items } : null;
    }
    // Предложение и откатываемое изменение: суть пишет агент — она и есть «что случилось».
    case 'proposal': {
      const p = await db.query('select summary from proposals where id = $1', [n.payload.proposal_id]);
      const summary = String(p.rows[0]?.summary ?? '');
      return summary.trim() ? { head: summary } : null;
    }
    case 'vetoable': {
      const v = await db.query('select summary from vetoable_changes where id = $1', [n.payload.change_id]);
      const summary = String(v.rows[0]?.summary ?? '');
      return summary.trim() ? { head: summary } : null;
    }
    case 'stuck_summary': {
      const ids = (n.payload.plan_ids as string[] | undefined) ?? [];
      return { head: t(lang, 'notif.stuck_summary', { count: ids.length }) };
    }
    case 'channel_dead': {
      const name = await userName(db, n.payload.user_id, n.payload.name);
      return name ? { head: t(lang, 'notif.channel_dead', { name }) } : unnamed(n);
    }
    case 'invitation_stalled': {
      const name = await invitedName(db, n.payload.invitation_id);
      return name ? { head: t(lang, 'notif.invitation_stalled', { name }) } : unnamed(n);
    }
    case 'ai_budget_exceeded': return { head: t(lang, 'notif.ai_budget_exceeded') };
    case 'read_token_issued': {
      const label = typeof n.payload.label === 'string' ? n.payload.label.trim() : '';
      return { head: t(lang, 'notif.read_token_issued'), subject: label || undefined, body: t(lang, 'notif.read_token_issued_body') };
    }
    case 'agent_token_issued': {
      const agent = typeof n.payload.agent_name === 'string' ? n.payload.agent_name.trim() : '';
      if (!agent) return unnamed(n);
      const label = typeof n.payload.label === 'string' ? n.payload.label.trim() : '';
      return { head: t(lang, 'notif.agent_token_issued', { agent }), subject: label || undefined, body: t(lang, 'notif.agent_token_issued_body') };
    }
    case 'open_app': {
      const by = typeof n.payload.by === 'string' ? n.payload.by.trim() : '';
      if (!by) return unnamed(n);
      const org = (await db.query(`select name from orgs where id = current_setting('app.org_id')::uuid`)).rows[0]?.name ?? '';
      return { head: t(lang, 'notif.open_app', { name: by }), body: t(lang, 'notif.open_app_body', { org }) };
    }
    case 'runner_broken': {
      const names = await agentNames(db, n.payload.agent_ids);
      return names ? { head: t(lang, 'notif.runner_broken'), subject: names } : unnamed(n);
    }
    case 'agents_silent': {
      const names = await agentNames(db, n.payload.agent_ids);
      return names ? { head: t(lang, 'notif.agents_silent'), subject: names } : unnamed(n);
    }
    default:
      // Вид без текста: доставка пометит его пропущенным, и человек не узнает о событии вовсе.
      // Молчать здесь нельзя — так task_changed_by_manager терялся с самого появления.
      logger.warn({ notification: n.id, kind: n.kind }, 'notif-text: для вида уведомления нет текста — уведомление не отправлено');
      return null;
  }
}

/** Отдельное сообщение: что случилось — жирным, дальше абзацами предмет и реплика. HTML. */
function partsToHtml(p: NotifParts, company: string | null): string {
  const lines = [company ? `${bold(p.head)} · ${esc(company)}` : bold(p.head)];
  if (p.subject) lines.push('', esc(clip(p.subject, SUBJECT_LIMIT)));
  if (p.meta) lines.push(esc(p.meta));
  if (p.body) lines.push('', esc(p.body));
  if (p.items?.length) lines.push('', ...p.items.map((i) => `• ${esc(clip(i, SUBJECT_LIMIT))}`));
  if (p.quote?.trim()) lines.push('', `<blockquote>${esc(clip(p.quote.trim(), QUOTE_LIMIT))}</blockquote>`);
  return lines.join('\n');
}

/** Одна строка для ленты и дайджеста. Простой текст — экранирует тот, кто вставляет её в разметку. */
function partsToLine(lang: string, p: NotifParts): string {
  let line = p.subject ? t(lang, 'notif.line', { head: p.head, title: p.subject }) : p.head;
  if (p.meta) line += ` (${p.meta})`;
  if (p.items?.length) line += `: ${p.items.join(', ')}`;
  if (p.quote?.trim()) line += ` — ${clip(p.quote.trim().replace(/\s+/g, ' '), LINE_QUOTE_LIMIT)}`;
  return line;
}

/**
 * Текст уведомления на языке получателя — HTML для `parse_mode: 'HTML'`. Пустая строка — «рендерить
 * нечем» (вызывающий решает, что делать). Называет компанию, когда их у человека больше одной (спека
 * multi-company): иначе утром приходят «Сейчас: подготовить отчёт» и «Сейчас: свериться с
 * поставщиком» из разных компаний, и понять это неоткуда. «Открыть приложение» называет компанию в
 * самом тексте — вторая приставка с тем же именем лишняя.
 */
export async function notificationText(db: Db, lang: string, n: NotifRow, recipientUserId: string): Promise<string> {
  const parts = await renderParts(db, lang, n, recipientUserId);
  if (!parts) return '';
  const company = n.kind === 'open_app' ? null : await companyNameIfMany(db, recipientUserId);
  return partsToHtml(parts, company);
}

/**
 * То же уведомление одной строкой простого текста — для /feed и «Ленты за вчера». `company: false` —
 * там, где компания уже названа заголовком (блок дайджеста).
 */
export async function notificationLine(
  db: Db, lang: string, n: NotifRow, recipientUserId: string, opts: { company?: boolean } = {},
): Promise<string> {
  const parts = await renderParts(db, lang, n, recipientUserId);
  if (!parts) return '';
  const line = partsToLine(lang, parts);
  if (opts.company === false || n.kind === 'open_app') return line;
  const company = await companyNameIfMany(db, recipientUserId);
  return company ? t(lang, 'notif.company', { name: company, text: line }) : line;
}
