import { Api, GrammyError } from 'grammy';
import { setActor, withOrg, type Db } from '../db/pool.js';
import { env } from '../config/env.js';
import { emit } from '../core/events.js';
import { notify } from '../core/notify.js';
import { localDate, loadUserSchedule } from '../core/calendar.js';
import { userOrgs } from '../core/people.js';
import { humanDate, t } from '../i18n/index.js';
import { notificationLine, notificationText, translatedTitle, type NotifRow, type TitledTask } from './notif-text.js';
import { bold, clip, esc, TELEGRAM_TEXT_LIMIT } from './html.js';
import {
  announcementKeyboard, answerKeyboard, maybeDoneKeyboard, openAppKeyboard, ownerAnswerKeyboard, ownerSubmittedKeyboard, proposalKeyboard, reminderKeyboard,
  takePromptKeyboard, takeReminderKeyboard, vetoableKeyboard, waitingItemKeyboard, withOpenTask,
} from './keyboards.js';
import { clockTime, laterChoices } from './take-prompt.js';
import { rateLimiter } from './limiter.js';

// Доставка уведомления в Telegram — спека telegram-bot. Worker вызывает эту функцию для каждого
// недоставленного уведомления (тихие часы и отложенную доставку worker уже учёл, здесь — только
// отправка). Своего `Api`, если бот в этом процессе не создавался (роль `worker`), создаём лениво.
export type DeliveryResult = 'sent' | 'skipped' | 'failed' | 'deferred';

let overrideApi: Api | undefined;
let lazyApi: Api | undefined;

/** Использовать тот же `Api`, что и у живого бота (веб-роль, тесты) — те же трансформеры/перехватчики. */
export function setDeliveryApi(api: Api | undefined): void {
  overrideApi = api;
}

/** Api бота для фоновых задач (worker): проверка админства в группах (спека group-intake). */
export function getBotApi(): Api | null {
  return getApi();
}

function getApi(): Api | null {
  if (overrideApi) return overrideApi;
  if (!env.telegramBotToken) return null;
  if (!lazyApi) {
    lazyApi = new Api(env.telegramBotToken);
    lazyApi.config.use(rateLimiter);
  }
  return lazyApi;
}

async function taskShortId(db: Db, taskId: string | null): Promise<string | null> {
  if (!taskId) return null;
  const r = await db.query('select short_id::text as id from tasks where id = $1', [taskId]);
  return r.rows[0]?.id ?? null;
}

async function keyboardFor(db: Db, n: NotifRow, lang: string, userId: string, now: Date) {
  switch (n.kind) {
    // Напоминание проверяющему несёт те же кнопки, что и первое «сдано»: решить можно, не открывая дело.
    case 'task_submitted':
    case 'review_reminder': {
      const s = await taskShortId(db, n.task_id);
      return s ? ownerSubmittedKeyboard(lang, s) : undefined;
    }
    case 'task_question':
    case 'task_unclear': {
      const s = await taskShortId(db, n.task_id);
      return s ? ownerAnswerKeyboard(lang, s) : undefined;
    }
    case 'task_answer': {
      if (!n.task_id) return undefined;
      const r = await db.query('select short_id::text as id, version from tasks where id = $1', [n.task_id]);
      return r.rowCount ? answerKeyboard(lang, r.rows[0].id, r.rows[0].version) : undefined;
    }
    case 'maybe_done': {
      if (!n.task_id) return undefined;
      const r = await db.query('select short_id::text as id, version from tasks where id = $1', [n.task_id]);
      return r.rowCount ? maybeDoneKeyboard(lang, r.rows[0].id, r.rows[0].version) : undefined;
    }
    case 'waiting_check': {
      const s = await taskShortId(db, n.task_id);
      return s ? waitingItemKeyboard(lang, s) : undefined;
    }
    case 'proposal': {
      const r = await db.query('select short_id::text as id from proposals where id = $1', [n.payload.proposal_id]);
      return r.rowCount ? proposalKeyboard(lang, r.rows[0].id) : undefined;
    }
    case 'vetoable': {
      const r = await db.query('select short_id::text as id from vetoable_changes where id = $1', [n.payload.change_id]);
      return r.rowCount ? vetoableKeyboard(lang, r.rows[0].id) : undefined;
    }
    case 'reminder': {
      const s = await taskShortId(db, n.task_id);
      return s ? reminderKeyboard(lang, s, { withNoChange: true }) : undefined;
    }
    // Время «Позже» — от момента отправки, в графике получателя: кнопка показывает итоговое (спека auto-start).
    case 'take_prompt': {
      const s = await taskShortId(db, n.task_id);
      if (!s) return undefined;
      const schedule = await loadUserSchedule(db, userId);
      return takePromptKeyboard(lang, s, laterChoices(schedule, now).map((c) => ({ code: c.code, time: clockTime(c.at, schedule.tz) })));
    }
    case 'take_reminder': {
      const s = await taskShortId(db, n.task_id);
      return s ? takeReminderKeyboard(lang, s) : undefined;
    }
    case 'open_app': return openAppKeyboard(lang);
    case 'announcement':
    case 'announcement_reminder':
      return typeof n.payload.announcement_id === 'string' ? announcementKeyboard(lang, n.payload.announcement_id) : undefined;
    default:
      return undefined;
  }
}

interface DigestSection { title: string; items: string[] }

/** Названия задач запроса — на языке получателя (спека bot-messages, «Язык получателя»). */
async function titles(db: Db, rows: TitledTask[], lang: string): Promise<string[]> {
  const out: string[] = [];
  for (const row of rows) out.push(await translatedTitle(db, row, lang));
  return out;
}

/** Секции дайджеста в одной организации (вызывается под `withOrg` этой организации — RLS). */
async function orgDigestSections(db: Db, userId: string, lang: string, today: string, includeFeed: boolean): Promise<DigestSection[]> {
  const org = (await db.query(`select kind from orgs where id = current_setting('app.org_id')::uuid`)).rows[0];

  const sections: DigestSection[] = [];
  const add = (key: string, items: string[]) => { if (items.length) sections.push({ title: t(lang, key), items }); };

  const now1 = (await db.query(
    `select id, title, source_language from tasks where assignee_user_id = $1 and kind = 'action' and status in ('active','in_progress') limit 1`, [userId],
  )).rows as TitledTask[];
  add('digest.now', await titles(db, now1, lang));

  const waiting = (await db.query(
    `select id, title, source_language from tasks where kind = 'waiting' and status = 'waiting' and (waiting->>'check_user_id') = $1
       and (waiting->>'next_check_at')::date <= $2::date order by created_at`, [userId, today],
  )).rows as TitledTask[];
  add('digest.waiting_today', await titles(db, waiting, lang));

  if (org?.kind === 'personal') {
    const personal = (await db.query(
      `select id, title, source_language from tasks where assignee_user_id = $1 and kind = 'action' and status = 'ready' and due_date = $2::date
        order by created_at`, [userId, today],
    )).rows as TitledTask[];
    add('digest.personal_today', await titles(db, personal, lang));
  }

  const overdue = (await db.query(
    `select id, title, source_language from tasks where assignee_user_id = $1 and kind = 'action' and due_date < $2::date
       and status in ('ready','active','in_progress','blocked','rework') order by due_date, created_at`, [userId, today],
  )).rows as TitledTask[];
  add('digest.overdue', await titles(db, overdue, lang));

  if (org?.kind === 'company') {
    const noDue = (await db.query(
      `select id, title, source_language from tasks where assignee_user_id = $1 and kind = 'action' and status = 'ready' and due_date is null
        order by created_at`, [userId],
    )).rows as TitledTask[];
    add('digest.no_due', await titles(db, noDue, lang));

    // Очередь со сроком впереди (30.09): человек, застрявший на текущем деле, иначе не видел
    // следующих вовсе — ни в «Сейчас», ни в «Срок прошёл», ни в «Без даты». Ахмет получил дело
    // с неделей срока и узнать о нём мог только из приложения, куда не заходил.
    const queued = (await db.query(
      `select id, title, source_language, to_char(due_date, 'YYYY-MM-DD') as due from tasks
        where assignee_user_id = $1 and kind = 'action' and status = 'ready' and due_date >= $2::date
        order by due_date, created_at limit 10`, [userId, today],
    )).rows as (TitledTask & { due: string })[];
    const queueItems: string[] = [];
    for (const row of queued) {
      queueItems.push(t(lang, 'digest.queue_item', {
        title: clip(await translatedTitle(db, row, lang), DIGEST_ITEM_LIMIT - 40), date: humanDate(lang, row.due, today),
      }));
    }
    add('digest.queue', queueItems);
  }

  if (includeFeed) {
    const feed = (await db.query(
      `select id, kind, level, task_id, payload, created_at from notifications
        where user_id = $1 and level = 'feed' and created_at >= $2::date - interval '1 day' and created_at < $2::date
        order by created_at`,
      [userId, today],
    )).rows as NotifRow[];
    const lines: string[] = [];
    for (const row of feed) {
      // Компанию здесь не называем: блок дайджеста уже идёт под её заголовком.
      const text = await notificationLine(db, lang, row, userId, { company: false });
      if (text) lines.push(text);
    }
    add('digest.feed_yesterday', lines);
  }

  return sections;
}

interface DigestLine { html: string; item: boolean }

// Пункт дайджеста — строка списка, а не карточка: одно длинное название не должно вытеснить остальные.
const DIGEST_ITEM_LIMIT = 300;

/**
 * Длинный дайджест не должен упасть с 400 от Telegram (предел 4096): режется по целым пунктам, а
 * вместо отрезанного — «и ещё N». Строка — единица разметки (тег не переходит на следующую), так
 * что резать между строками значит никогда не разрезать тег.
 */
function fitDigest(lines: DigestLine[], lang: string): string {
  const full = lines.map((l) => l.html).join('\n');
  if (full.length <= TELEGRAM_TEXT_LIMIT) return full;
  const totalItems = lines.filter((l) => l.item).length;
  const kept: DigestLine[] = [];
  let length = 0;
  for (const line of lines) {
    const keptItems = kept.filter((l) => l.item).length + (line.item ? 1 : 0);
    const more = `\n\n${esc(t(lang, 'digest.more', { count: totalItems - keptItems }))}`;
    if (length + line.html.length + 1 + more.length > TELEGRAM_TEXT_LIMIT) break;
    kept.push(line);
    length += line.html.length + 1;
  }
  // Заголовок без единого пункта под ним — обрывок: убрать вместе с пустыми строками. Шапку
  // («Доброе утро») — никогда: худший случай — шапка и «и ещё N», а не одно «и ещё N».
  while (kept.length > 1 && !kept[kept.length - 1]!.item) kept.pop();
  if (!kept.length) kept.push(lines[0]!);
  const dropped = totalItems - kept.filter((l) => l.item).length;
  return `${kept.map((l) => l.html).join('\n')}\n\n${esc(t(lang, 'digest.more', { count: dropped }))}`;
}

/**
 * Дайджест — одно сообщение на человека по ВСЕМ его организациям (спека telegram-bot): worker
 * создаёт уведомление `digest` только в одной, канонической, организации (worker/digest.ts), а
 * здесь, при доставке, данные собираются по остальным его организациям тоже — каждая под своим
 * `withOrg` (RLS не обойти иначе). Блоки с заголовком организации — только если организаций больше
 * одной (как в «Списке»); «Лента за вчера» — в организациях, где человек `owner`. Пусто везде →
 * `null` (не слать). Вид — спека bot-messages: жирные заголовки, пункты списком, секции через
 * пустую строку; результат — HTML.
 */
async function buildDigest(db: Db, userId: string, lang: string): Promise<string | null> {
  const schedule = await loadUserSchedule(db, userId);
  const today = localDate(new Date(), schedule.tz);
  // Только те компании, куда человек вошёл (спека multi-company): дайджест — это работа
  // на сегодня, а приглашение, которое не приняли, работой ещё не стало.
  const orgs = await userOrgs(db, userId, { includeInvited: false });
  // Компанию называем, когда их у человека больше одной (спека multi-company). Личное
  // пространство есть у каждого, и считать его второй организацией значило бы поставить заголовок
  // «Компания такая-то» всем подряд — ровно то лишнее слово, которого решили избегать.
  const showHeaders = orgs.filter((o) => o.kind === 'company').length > 1;

  const lines: DigestLine[] = [{ html: bold(t(lang, 'digest.header')), item: false }];
  let any = false;
  for (const org of orgs) {
    const sections = await withOrg(org.id, (odb) => orgDigestSections(odb, userId, lang, today, org.role === 'owner'), { actorUserId: userId });
    if (!sections.length) continue;
    any = true;
    // Заголовок компании выделен ещё и подчёркиванием: иначе он неотличим от заголовков секций под ним.
    if (showHeaders) lines.push({ html: '', item: false }, { html: `<b><u>${esc(t(lang, 'list.header', { org: org.name }))}</u></b>`, item: false });
    for (const s of sections) {
      lines.push({ html: '', item: false }, { html: bold(s.title), item: false });
      for (const item of s.items) lines.push({ html: `• ${esc(clip(item, DIGEST_ITEM_LIMIT))}`, item: true });
    }
  }

  if (!any) return null;
  return fitDigest(lines, lang);
}

function isForbidden(e: unknown): boolean {
  return e instanceof GrammyError && (e.error_code === 403 || /bot was blocked/i.test(e.description ?? ''));
}

/**
 * Бот заблокирован — канал к человеку мёртв во всех его компаниях сразу, а не только в той, чьё
 * уведомление не дошло (спека multi-company-person, п.7): владелец второй компании иначе так и
 * ставил бы дела в пустоту. Каждая компания — своей транзакцией: её агенты и её владелец живут под
 * её RLS. Действующим лицом называем самого человека — его дела закрытых проектов тоже в счёт.
 */
async function markChannelDead(db: Db, userId: string): Promise<void> {
  await markChannelDeadHere(db, userId);
  const here = (await db.query(`select current_setting('app.org_id') as id`)).rows[0].id as string;
  const others = (await userOrgs(db, userId, { includeInvited: false }))
    .filter((o) => o.kind === 'company' && o.id !== here);
  for (const o of others) await withOrg(o.id, (odb) => markChannelDeadHere(odb, userId), { actorUserId: userId });
}

async function markChannelDeadHere(db: Db, userId: string): Promise<void> {
  const agents = await db.query(
    `select distinct author_agent_id from tasks
      where assignee_user_id = $1 and author_agent_id is not null
        and status not in ('draft','done','declined','cancelled','resolved','waiting')`,
    [userId],
  );
  for (const row of agents.rows) await emit(db, { type: 'channel_dead', agentId: row.author_agent_id, data: { user_id: userId } });
  const org = (await db.query(`select owner_user_id from orgs where id = current_setting('app.org_id')::uuid`)).rows[0];
  // Имя — по id при показе (спека bot-messages): записанное сюда заранее бывало «?».
  if (org && org.owner_user_id !== userId) {
    await notify(db, { userId: org.owner_user_id, kind: 'channel_dead', level: 'decision', payload: { user_id: userId } });
  }
}

// Неудачная отправка повторяется не чаще раза в 5 минут (спека telegram-bot, «Напоминания»).
const RETRY_AFTER_MS = 5 * 60000;

/**
 * Отправить уведомление и тут же, той же транзакцией, записать итог: строку `deliveries` и отметку
 * `notifications.delivered_at` (или перенос повтора). Итог нельзя оставлять вызывающему: тик держит
 * одну транзакцию на всю организацию, и её откат снимал отметку, когда сообщение уже ушло, —
 * следующий тик слал его второй раз (аудит архитектуры, CRIT). Сеть откатить нельзя, поэтому
 * отметка живёт там же, где запись о самой отправке.
 */
export async function deliverNotification(orgId: string, notificationId: string, now: Date = new Date()): Promise<DeliveryResult> {
  const api = getApi();
  if (!api) return 'deferred';

  return withOrg(orgId, async (db) => {
    // Замок строки: второй доставщик того же уведомления (параллельный тик) пропускает его, а не
    // шлёт следом. Занята — как и «строки не видно»: следующий тик.
    const row = (await db.query(
      'select id, user_id, kind, level, task_id, payload, created_at, delivered_at from notifications where id = $1 for update skip locked', [notificationId],
    )).rows[0] as (NotifRow & { user_id: string; delivered_at: Date | null }) | undefined;
    // Строки нет в этом соединении — значит, её создала ещё не закрытая транзакция (доставка читает
    // своим соединением). «skipped» здесь помечал уведомление доставленным, и напоминания о сроках
    // не доходили никому с запуска (29.09). Отложить: следующий проход увидит строку закоммиченной.
    if (!row) return 'deferred';
    if (row.delivered_at) return 'skipped';

    const settle = async (result: 'sent' | 'skipped' | 'failed'): Promise<DeliveryResult> => {
      if (result === 'failed') {
        await db.query('update notifications set deliver_after = $2 where id = $1', [notificationId, new Date(now.getTime() + RETRY_AFTER_MS)]);
      } else {
        await db.query('update notifications set delivered_at = $2 where id = $1', [notificationId, now]);
      }
      return result;
    };

    // Дальше читается дело уведомления — от имени его получателя: иначе его же дело из закрытого
    // проекта осталось бы невидимым, и уведомление о нём было бы пустым (спека projects).
    await setActor(db, row.user_id);

    const link = (await db.query(
      `select tl.chat_id, tl.blocked_at, u.language from telegram_links tl join users u on u.id = tl.user_id where tl.user_id = $1`,
      [row.user_id],
    )).rows[0] as { chat_id: number; blocked_at: Date | null; language: string } | undefined;
    if (!link || link.blocked_at) return settle('skipped');
    const lang = link.language;

    let text: string;
    let keyboard;
    if (row.kind === 'digest') {
      const built = await buildDigest(db, row.user_id, lang);
      if (!built) return settle('skipped');
      text = built;
    } else {
      text = await notificationText(db, lang, row, row.user_id);
      if (!text) return settle('skipped');
      // Под уведомлением о деле — «Открыть задачу» (спека unread-and-deeplink). Видимость дела
      // получателю уже проверил текст: невидимое дело даёт пустой текст, и сюда не доходим.
      keyboard = withOpenTask(await keyboardFor(db, row, lang, row.user_id, now), lang, row.task_id);
    }

    try {
      // node-pg возвращает bigint (chat_id) строкой — Telegram API ждёт число.
      // Разметка — только наша, данные экранированы (спека bot-messages): parse_mode для всех.
      await api.sendMessage(Number(link.chat_id), text, { parse_mode: 'HTML', ...(keyboard ? { reply_markup: keyboard } : {}) });
    } catch (e) {
      if (isForbidden(e)) {
        await db.query('update telegram_links set blocked_at = now() where user_id = $1', [row.user_id]);
        await markChannelDead(db, row.user_id);
        await db.query(
          `insert into deliveries(org_id, notification_id, channel, status, error)
           values (current_setting('app.org_id')::uuid, $1, 'telegram', 'failed', 'blocked')`,
          [notificationId],
        );
        return settle('skipped');
      }
      await db.query(
        `insert into deliveries(org_id, notification_id, channel, status, error)
         values (current_setting('app.org_id')::uuid, $1, 'telegram', 'failed', $2)`,
        [notificationId, e instanceof Error ? e.message.slice(0, 500) : 'unknown'],
      );
      return settle('failed');
    }
    // Запись об отправке — вне `try`: сбой базы после ушедшего сообщения не должен выглядеть
    // неудачей отправки (та назначила бы повтор).
    await db.query(
      `insert into deliveries(org_id, notification_id, channel, status) values (current_setting('app.org_id')::uuid, $1, 'telegram', 'sent')`,
      [notificationId],
    );
    return settle('sent');
  });
}
