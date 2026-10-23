import { afterCommit, withGlobal, withOrg, type Db } from '../db/pool.js';
import { warmTranslations, type TranslateFieldInput } from '../ai/translate.js';
import { logger } from '../log.js';
import { AppError } from './errors.js';
import { actingUserId, requireActorRole } from './access.js';
import { loadUserSchedule, localDatePlusDays, nextDayShare, nextWorkingStart, workingMinutesBetween, zonedToUtc } from './calendar.js';
import { messageLanguage } from './message-language.js';
import { notify } from './notify.js';
import { userOrgs } from './people.js';
import type { Actor } from './types.js';
import { actorAgentId } from './types.js';

// Объявления людям с подтверждением прочтения (спека announcements). Объявление — не задача: его не
// делают и не сдают, его читают и подтверждают. Подтверждение ставится один раз — это держит и
// триггер в базе (миграция 032), здесь же оно просто идемпотентно.

export const ANNOUNCEMENT_MAX_LENGTH = 2000;
/** Первое напоминание — через 4 рабочих часа получателя после отправки. */
const FIRST_REMINDER_MINUTES = 4 * 60;
/** Сколько раз напоминаем; после последнего — тишина, отправитель видит «не подтвердил». */
export const REMINDER_LIMIT = 3;
/**
 * Потолки на скользящие сутки: объявление поднимает заслон у всех, и поток их — это спам с
 * подтверждением. Десять на организацию; от одного агента — три: ошибка в цикле агента не должна
 * выбрать лимит компании за минуту.
 */
export const ORG_DAILY_LIMIT = 10;
export const AGENT_DAILY_LIMIT = 3;
/** Сколько людей можно назвать в `to` одним вызовом (для «всех» есть `"all"`). */
export const MAX_NAMED_RECIPIENTS = 200;
const DAY_MS = 24 * 3600 * 1000;
/** Сколько последних объявлений отдаёт `announcement_status` без указания объявления. */
const STATUS_LIMIT = 20;

export type ConfirmVia = 'bot' | 'app';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SentAnnouncement { announcement_id: string; recipients: { user_id: string; name: string }[] }

/**
 * Отправить объявление. `to` — `'all'` или уже разрешённые id людей (имена и почты разбирает
 * инструмент). Получатели — действующие участники, без самого отправителя-человека; при `'all'`
 * список фиксируется сейчас: пришедший позже объявления не получает.
 */
export async function sendAnnouncement(
  db: Db, input: { text: string; to: 'all' | string[] }, actor: Actor, now: Date = new Date(),
): Promise<SentAnnouncement> {
  // Право — по человеку, чьими правами идёт действие: агент рядового участника объявлять не вправе.
  await requireActorRole(db, actor, ['owner', 'admin']);
  const org = (await db.query(`select kind from orgs where id = current_setting('app.org_id')::uuid`)).rows[0] as { kind: string } | undefined;
  if (!org || org.kind === 'personal') {
    throw new AppError('validation_failed', 'An announcement needs a company: in the personal space there is nobody to announce to');
  }
  const text = input.text.trim();
  if (!text) throw new AppError('validation_failed', 'text is required', { missing: ['text'] });
  if (text.length > ANNOUNCEMENT_MAX_LENGTH) {
    throw new AppError('validation_failed', `text is too long: at most ${ANNOUNCEMENT_MAX_LENGTH} characters`);
  }

  const agentId = actorAgentId(actor);
  // Счёт и вставка под замком организации: два вызова разом не проскочат мимо потолка.
  await db.query(`select pg_advisory_xact_lock(hashtextextended('announcements:' || current_setting('app.org_id'), 0))`);
  const used = (await db.query(
    `select count(*)::int as org_n, count(*) filter (where author_agent_id = $3)::int as agent_n
       from announcements where created_at > $1 and created_at <= $2 and alert_id is null`,
    [new Date(now.getTime() - DAY_MS), now, agentId])).rows[0] as { org_n: number; agent_n: number };
  if (used.org_n >= ORG_DAILY_LIMIT) {
    throw new AppError('limit_exceeded', `At most ${ORG_DAILY_LIMIT} announcements per organization in 24 hours — this limit is used up, try again later`);
  }
  if (agentId && used.agent_n >= AGENT_DAILY_LIMIT) {
    throw new AppError('limit_exceeded', `At most ${AGENT_DAILY_LIMIT} announcements per agent in 24 hours — this limit is used up, try again later`);
  }
  // Автор-человек — всегда: у объявления от агента это владелец агента (как у дел, `createTask`).
  const authorUserId = await actingUserId(db, actor);
  // Автор-человек не получатель, и когда объявляет его агент: хозяин сам просил и знает текст.
  const selfId = authorUserId;

  const active = (await db.query(
    `select m.user_id, u.display_name from memberships m join users u on u.id = m.user_id
      where m.org_id = current_setting('app.org_id')::uuid and m.status = 'active' and u.anonymized_at is null
      order by u.display_name, m.user_id`)).rows as { user_id: string; display_name: string }[];
  const byId = new Map(active.map((m) => [m.user_id, m]));

  let recipients: { user_id: string; display_name: string }[];
  if (input.to === 'all') {
    recipients = active.filter((m) => m.user_id !== selfId);
  } else {
    const picked = new Set<string>();
    for (const id of input.to) {
      if (!byId.has(id)) throw new AppError('validation_failed', 'Every recipient must be an active member of the organization');
      if (id !== selfId) picked.add(id);
    }
    recipients = [...picked].map((id) => byId.get(id)!);
  }
  if (!recipients.length) throw new AppError('validation_failed', 'There is nobody to send the announcement to', { missing: ['to'] });

  const sourceLanguage = await messageLanguage(db, text, actor.kind === 'user' ? actor.userId : null);
  const row = (await db.query(
    `insert into announcements(org_id, author_user_id, author_agent_id, text, source_language, to_all, created_at)
     values (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6) returning id`,
    // Язык автора-человека, как у реплик (`messageLanguage`): у агента — язык компании.
    [authorUserId, agentId, text, sourceLanguage, input.to === 'all', now],
  )).rows[0] as { id: string };

  for (const r of recipients) {
    await db.query(
      `insert into announcement_recipients(org_id, announcement_id, user_id)
       values (current_setting('app.org_id')::uuid, $1, $2)`, [row.id, r.user_id]);
    await notify(db, {
      userId: r.user_id, kind: 'announcement', level: 'work', payload: announcementPayload(row.id, agentId),
      dedupeKey: `announcement:${row.id}:${r.user_id}`, deliverAfter: now, createdAt: now,
    });
  }
  await warmAfterCommit(db, { id: row.id, text, sourceLanguage }, recipients.map((r) => r.user_id));
  return { announcement_id: row.id, recipients: recipients.map((r) => ({ user_id: r.user_id, name: r.display_name })) };
}

/** Id агента — в данные уведомления; имя берётся при показе (так же, как имена людей). */
function announcementPayload(announcementId: string, agentId: string | null): Record<string, unknown> {
  return agentId ? { announcement_id: announcementId, agent_id: agentId } : { announcement_id: announcementId };
}

/**
 * Перевод на языки получателей — в фоне после коммита (спека announcements): список приложения читает
 * только кэш и модель не ждёт, а к моменту, когда человек откроет приложение, перевод уже лежит.
 * Не ждём и не роняем отправку: ошибка идёт в журнал, оригинал показывается и без перевода.
 */
async function warmAfterCommit(db: Db, a: { id: string; text: string; sourceLanguage: string | null }, userIds: string[]): Promise<void> {
  if (!a.sourceLanguage) return;
  const langs = [...new Set((await db.query('select language from users where id = any($1::uuid[])', [userIds])).rows
    .map((r) => r.language as string))].filter((l) => l !== a.sourceLanguage);
  if (!langs.length) return;
  const orgId = (await db.query(`select current_setting('app.org_id') as id`)).rows[0].id as string;
  const inputs: TranslateFieldInput[] = langs.map((targetLang) => ({
    objectType: 'announcement', objectId: a.id, field: 'text', text: a.text, sourceLang: a.sourceLanguage!, targetLang,
  }));
  await afterCommit(db, `announcement-translate:${a.id}`, async () => {
    void warmTranslations(orgId, inputs)
      .catch((e) => logger.warn({ err: e, announcement: a.id }, 'announcement: перевод в фоне не удался'));
  });
}

export interface ConfirmedAt { confirmedAt: Date; already: boolean }

/**
 * Подтвердить прочтение (внутри `withOrg` организации объявления). Уже подтверждено — не ошибка и
 * время прежнее: кнопка в боте и заслон в приложении могут сработать оба. Чужое объявление
 * (человек не получатель) — `not_found`: о его существовании не говорим.
 */
export async function confirmAnnouncement(db: Db, announcementId: string, userId: string, via: ConfirmVia): Promise<ConfirmedAt> {
  if (!UUID_RE.test(announcementId)) throw new AppError('not_found', 'Announcement not found');
  const done = await db.query(
    `update announcement_recipients set confirmed_at = now(), confirmed_via = $3
      where announcement_id = $1 and user_id = $2 and confirmed_at is null returning confirmed_at`,
    [announcementId, userId, via]);
  if (done.rowCount) return { confirmedAt: done.rows[0].confirmed_at as Date, already: false };
  const prior = await db.query(
    'select confirmed_at from announcement_recipients where announcement_id = $1 and user_id = $2', [announcementId, userId]);
  if (!prior.rowCount) throw new AppError('not_found', 'Announcement not found');
  return { confirmedAt: prior.rows[0].confirmed_at as Date, already: true };
}

/**
 * То же по всем компаниям человека: бот и приложение знают только id объявления, а RLS не даёт
 * искать без организации. Перебор идёт по действующим компаниям — вышедшему из компании подтверждать
 * её объявления нечем (оно и не показывается).
 */
export async function confirmAnnouncementForUser(userId: string, announcementId: string, via: ConfirmVia): Promise<ConfirmedAt & { orgId: string }> {
  if (!UUID_RE.test(announcementId)) throw new AppError('not_found', 'Announcement not found');
  const orgs = (await withGlobal((db) => userOrgs(db, userId))).filter((o) => o.kind === 'company');
  for (const org of orgs) {
    const done = await withOrg(org.id, async (db) => {
      try {
        return await confirmAnnouncement(db, announcementId, userId, via);
      } catch (e) {
        if (e instanceof AppError && e.code === 'not_found') return null;
        throw e;
      }
    }, { actorUserId: userId });
    if (done) return { ...done, orgId: org.id };
  }
  throw new AppError('not_found', 'Announcement not found');
}

export interface OpenAnnouncement {
  id: string; org_id: string; author: string; agent: string | null; text: string; source_language: string | null; sent_at: Date;
  /** Под каким id лежит перевод: у раунда тревоги — id тревоги, чтобы раунды не переводились заново. */
  translation_id: string;
}

/**
 * Неподтверждённые объявления человека в текущей организации, старые первыми (внутри `withOrg`).
 * От тревоги (спека announcement-alerts) — только её последний раунд и только пока она открыта: новый
 * раунд заменяет старый, а снятая тревога уходит из заслона, даже не подтверждённая.
 */
export async function openAnnouncements(db: Db, userId: string): Promise<OpenAnnouncement[]> {
  return (await db.query(
    `select a.id, a.org_id, u.display_name as author, ag.name as agent, a.text, a.source_language, a.created_at as sent_at,
            coalesce(a.alert_id, a.id) as translation_id
       from announcement_recipients r
       join announcements a on a.org_id = r.org_id and a.id = r.announcement_id
       join users u on u.id = a.author_user_id
       left join agents ag on ag.id = a.author_agent_id
      where r.user_id = $1 and r.confirmed_at is null
        and (a.alert_id is null or (
          exists (select 1 from announcement_alerts al where al.id = a.alert_id and al.resolved_at is null)
          and not exists (
            select 1 from announcements later join announcement_recipients lr on lr.announcement_id = later.id and lr.user_id = r.user_id
             where later.alert_id = a.alert_id and (later.created_at, later.id) > (a.created_at, a.id))))
      order by a.created_at, a.id`, [userId])).rows as OpenAnnouncement[];
}

export interface AnnouncementStatusRow {
  id: string; text: string; from: string; via_agent: string | null; sent_at: Date; to_all: boolean;
  recipients: { user_id: string; name: string; confirmed_at: Date | null; confirmed_via: ConfirmVia | null; reminded_count: number }[];
}

/**
 * Кто и когда подтвердил: по каждому получателю время или его отсутствие и число напоминаний.
 * Без `ref` — последние объявления; с `ref` — одно. Право (owner/admin) проверяет вызывающий слой так
 * же, как при отправке.
 */
export async function announcementStatus(db: Db, actor: Actor, ref?: string | null): Promise<AnnouncementStatusRow[]> {
  await requireActorRole(db, actor, ['owner', 'admin']);
  if (ref && !UUID_RE.test(ref)) throw new AppError('not_found', 'Announcement not found');
  const rows = (await db.query(
    `select a.id, a.text, a.created_at as sent_at, a.to_all, u.display_name as "from", ag.name as via_agent
       from announcements a join users u on u.id = a.author_user_id left join agents ag on ag.id = a.author_agent_id
      where ($1::uuid is null and a.alert_id is null or a.id = $1::uuid)
      order by a.created_at desc, a.id desc limit $2`, [ref ?? null, STATUS_LIMIT])).rows as Omit<AnnouncementStatusRow, 'recipients'>[];
  if (ref && !rows.length) throw new AppError('not_found', 'Announcement not found');
  const people = (await db.query(
    `select r.announcement_id, r.user_id, u.display_name as name, r.confirmed_at, r.confirmed_via, r.reminded_count
       from announcement_recipients r join users u on u.id = r.user_id
      where r.announcement_id = any($1::uuid[]) order by u.display_name, r.user_id`,
    [rows.map((r) => r.id)])).rows as (AnnouncementStatusRow['recipients'][number] & { announcement_id: string })[];
  return rows.map((r) => ({
    ...r,
    recipients: people.filter((p) => p.announcement_id === r.id).map(({ announcement_id: _id, ...rest }) => rest),
  }));
}

/**
 * Пора ли напоминать получателю. Первое — когда рабочих минут получателя с отправки набралось
 * четыре часа; следующие — в первый рабочий час следующего рабочего дня после предыдущего
 * напоминания: раз в рабочий день, а не раз в сутки, чтобы выходные и ночь не съедали напоминание.
 */
function reminderDue(
  schedule: Awaited<ReturnType<typeof loadUserSchedule>>, sentAt: Date, remindedCount: number, lastRemindedAt: Date | null, now: Date,
): boolean {
  if (!schedule.days.length) return false;
  if (remindedCount === 0 || !lastRemindedAt) return workingMinutesBetween(schedule, sentAt, now) >= FIRST_REMINDER_MINUTES;
  const [y, m, d] = localDatePlusDays(schedule, lastRemindedAt, 1).split('-').map(Number) as [number, number, number];
  return now >= nextWorkingStart(schedule, zonedToUtc(y, m, d, 0, 0, schedule.tz));
}

/**
 * Таймер тика организации: напомнить тем, кто не подтвердил. Только действующим участникам — вышедшему
 * из компании не пишем (в списке отправителя он остаётся «не подтвердил»). Номер напоминания
 * занимается обновлением счётчика раньше уведомления: подтвердил между выборкой и записью — обновление
 * не заденет строку, и напоминание не уйдёт.
 */
export async function runAnnouncementReminders(db: Db, now: Date): Promise<void> {
  const rows = (await db.query(
    `select r.announcement_id, r.user_id, r.reminded_count, r.last_reminded_at, a.created_at as sent_at, a.author_agent_id
       from announcement_recipients r
       join announcements a on a.org_id = r.org_id and a.id = r.announcement_id
       join memberships m on m.org_id = r.org_id and m.user_id = r.user_id and m.status = 'active'
      where r.confirmed_at is null and r.reminded_count < $1 and a.created_at <= $2 and a.alert_id is null
      order by a.created_at, r.user_id`, [REMINDER_LIMIT, now])).rows as {
    announcement_id: string; user_id: string; reminded_count: number; last_reminded_at: Date | null; sent_at: Date;
    author_agent_id: string | null;
  }[];
  const schedules = new Map<string, Awaited<ReturnType<typeof loadUserSchedule>>>();
  for (const r of rows) {
    let schedule = schedules.get(r.user_id);
    if (!schedule) { schedule = await loadUserSchedule(db, r.user_id); schedules.set(r.user_id, schedule); }
    if (!reminderDue(schedule, new Date(r.sent_at), r.reminded_count, r.last_reminded_at ? new Date(r.last_reminded_at) : null, now)) continue;
    const claimed = await db.query(
      `update announcement_recipients set reminded_count = reminded_count + 1, last_reminded_at = $4
        where announcement_id = $1 and user_id = $2 and reminded_count = $3 and confirmed_at is null`,
      [r.announcement_id, r.user_id, r.reminded_count, now]);
    if (!claimed.rowCount) continue;
    await notify(db, {
      userId: r.user_id, kind: 'announcement_reminder', level: 'work',
      payload: announcementPayload(r.announcement_id, r.author_agent_id),
      dedupeKey: `ann_rem:${r.announcement_id}:${r.user_id}:${r.reminded_count + 1}`, deliverAfter: now, createdAt: now,
    });
  }
}

// ——— Тревоги: повторяющиеся объявления по ключу (спека announcement-alerts) ———
// Тревогу поднимает внешний сторож и снимает событием «сдвинулось». Пока она открыта, каждый
// получатель видит её раундами — обычными объявлениями одному человеку, тем же заслоном и той же
// кнопкой. «Прочёл» отмечает раунд, но повторы не снимает.

export const ALERT_KEY_MAX_LENGTH = 200;
/** Открытых тревог в организации одновременно; от одного агента — новых за сутки. */
export const ALERT_OPEN_LIMIT = 30;
export const ALERT_AGENT_DAILY_LIMIT = 20;
/** Новых тревог в организации за сутки — от всех, и людей тоже: подъём со снятием по кругу не обходит потолок. */
export const ALERT_ORG_DAILY_LIMIT = 30;
/** Сколько дней закрытые тревоги видны в статусе. */
const ALERT_STATUS_DAYS = 7;

export interface AlertSchedule { per_day: number; escalated_per_day: number; escalate_after_days: number }
export const ALERT_DEFAULTS: AlertSchedule = { per_day: 2, escalated_per_day: 4, escalate_after_days: 2 };

export interface RaisedAlert { alert_id: string; created: boolean; recipients: { user_id: string; name: string }[] }

/**
 * Поднять тревогу. Открытая с тем же ключом уже есть — та же тревога: меняется только текст (растёт
 * «сколько дней»), раунда сверх расписания нет. Иначе — новая тревога и первый раунд каждому сразу.
 * `to` — `'all'` или уже разрешённые id. Автор-человек получает тревогу, только если назван явно.
 */
export async function raiseAlert(
  db: Db, input: { key: string; text: string; to: 'all' | string[] } & Partial<AlertSchedule>, actor: Actor, now: Date = new Date(),
): Promise<RaisedAlert> {
  await requireActorRole(db, actor, ['owner', 'admin']);
  const org = (await db.query(`select kind from orgs where id = current_setting('app.org_id')::uuid`)).rows[0] as { kind: string } | undefined;
  if (!org || org.kind === 'personal') {
    throw new AppError('validation_failed', 'An alert needs a company: in the personal space there is nobody to alert');
  }
  const key = input.key.trim();
  if (!key || key.length > ALERT_KEY_MAX_LENGTH) throw new AppError('validation_failed', `key is required, at most ${ALERT_KEY_MAX_LENGTH} characters`);
  const text = input.text.trim();
  if (!text) throw new AppError('validation_failed', 'text is required', { missing: ['text'] });
  if (text.length > ANNOUNCEMENT_MAX_LENGTH) throw new AppError('validation_failed', `text is too long: at most ${ANNOUNCEMENT_MAX_LENGTH} characters`);
  const sched: AlertSchedule = {
    per_day: input.per_day ?? ALERT_DEFAULTS.per_day,
    escalated_per_day: input.escalated_per_day ?? Math.max(ALERT_DEFAULTS.escalated_per_day, input.per_day ?? 0),
    escalate_after_days: input.escalate_after_days ?? ALERT_DEFAULTS.escalate_after_days,
  };
  if (![sched.per_day, sched.escalated_per_day].every((n) => Number.isInteger(n) && n >= 1 && n <= 4) || sched.escalated_per_day < sched.per_day) {
    throw new AppError('validation_failed', 'per_day and escalated_per_day are 1 to 4 times a day, escalated_per_day not below per_day');
  }
  if (!Number.isInteger(sched.escalate_after_days) || sched.escalate_after_days < 1 || sched.escalate_after_days > 30) {
    throw new AppError('validation_failed', 'escalate_after_days is 1 to 30');
  }

  const agentId = actorAgentId(actor);
  const authorUserId = await actingUserId(db, actor);
  // Подъём под замком организации: два сторожа разом не откроют две тревоги с одним ключом и не проскочат мимо потолка.
  await db.query(`select pg_advisory_xact_lock(hashtextextended('alerts:' || current_setting('app.org_id'), 0))`);
  const sourceLanguage = await messageLanguage(db, text, actor.kind === 'user' ? actor.userId : null);

  const open = (await db.query(
    `select id, text, author_user_id from announcement_alerts where key = $1 and resolved_at is null`, [key])).rows[0] as
    { id: string; text: string; author_user_id: string } | undefined;
  if (open) {
    // Текст чужой тревоги не переписать: раунды подписаны её автором, и люди читали бы чужие слова от его имени.
    if (open.author_user_id !== authorUserId && open.text !== text) {
      throw new AppError('conflict', 'An open alert with this key was raised by another person — only its author (or their agents) can change its text');
    }
    if (open.text !== text) {
      await db.query('update announcement_alerts set text = $2, source_language = $3 where id = $1', [open.id, text, sourceLanguage]);
    }
    const people = (await db.query(
      `select ar.user_id, u.display_name as name from announcement_alert_recipients ar join users u on u.id = ar.user_id
         join memberships m on m.org_id = ar.org_id and m.user_id = ar.user_id and m.status = 'active'
        where ar.alert_id = $1 order by u.display_name, ar.user_id`, [open.id])).rows as { user_id: string; name: string }[];
    if (open.text !== text) await warmAfterCommit(db, { id: open.id, text, sourceLanguage }, people.map((p) => p.user_id));
    return { alert_id: open.id, created: false, recipients: people };
  }

  const used = (await db.query(
    `select count(*) filter (where resolved_at is null)::int as open_n,
            count(*) filter (where author_agent_id = $2 and opened_at > $1)::int as agent_n,
            count(*) filter (where opened_at > $1)::int as org_n
       from announcement_alerts`, [new Date(now.getTime() - DAY_MS), agentId])).rows[0] as { open_n: number; agent_n: number; org_n: number };
  if (used.open_n >= ALERT_OPEN_LIMIT) {
    throw new AppError('limit_exceeded', `At most ${ALERT_OPEN_LIMIT} open alerts per organization — resolve the ones that are over first`);
  }
  if (used.org_n >= ALERT_ORG_DAILY_LIMIT) {
    throw new AppError('limit_exceeded', `At most ${ALERT_ORG_DAILY_LIMIT} new alerts per organization in 24 hours — this limit is used up, try again later`);
  }
  if (agentId && used.agent_n >= ALERT_AGENT_DAILY_LIMIT) {
    throw new AppError('limit_exceeded', `At most ${ALERT_AGENT_DAILY_LIMIT} new alerts per agent in 24 hours — this limit is used up, try again later`);
  }

  const active = (await db.query(
    `select m.user_id, u.display_name from memberships m join users u on u.id = m.user_id
      where m.org_id = current_setting('app.org_id')::uuid and m.status = 'active' and u.anonymized_at is null
      order by u.display_name, m.user_id`)).rows as { user_id: string; display_name: string }[];
  const byId = new Map(active.map((m) => [m.user_id, m]));
  let recipients: { user_id: string; display_name: string }[];
  if (input.to === 'all') {
    recipients = active.filter((m) => m.user_id !== authorUserId);
  } else {
    // Названного явно автора не выкидываем: тревогу поднимает сторож, а владелец может поставить и себя.
    const picked = new Set<string>();
    for (const id of input.to) {
      if (!byId.has(id)) throw new AppError('validation_failed', 'Every recipient must be an active member of the organization');
      picked.add(id);
    }
    recipients = [...picked].map((id) => byId.get(id)!);
  }
  if (!recipients.length) throw new AppError('validation_failed', 'There is nobody to send the alert to', { missing: ['to'] });

  const alert = (await db.query(
    `insert into announcement_alerts(org_id, key, author_user_id, author_agent_id, text, source_language,
                                     per_day, escalated_per_day, escalate_after_days, opened_at)
     values (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [key, authorUserId, agentId, text, sourceLanguage, sched.per_day, sched.escalated_per_day, sched.escalate_after_days, now],
  )).rows[0] as { id: string };
  for (const r of recipients) {
    await db.query(
      `insert into announcement_alert_recipients(org_id, alert_id, user_id, rounds, last_round_at)
       values (current_setting('app.org_id')::uuid, $1, $2, 1, $3)`, [alert.id, r.user_id, now]);
    await alertRound(db, alert.id, r.user_id, 1, now);
  }
  await warmAfterCommit(db, { id: alert.id, text, sourceLanguage }, recipients.map((r) => r.user_id));
  return { alert_id: alert.id, created: true, recipients: recipients.map((r) => ({ user_id: r.user_id, name: r.display_name })) };
}

/**
 * Раунд тревоги: объявление одному человеку с текущим текстом тревоги и уведомление `announcement` —
 * тот же заслон и та же кнопка, что у объявления. Номер раунда — в ключе дедупа.
 */
async function alertRound(db: Db, alertId: string, userId: string, round: number, now: Date): Promise<void> {
  const a = (await db.query(
    `insert into announcements(org_id, author_user_id, author_agent_id, text, source_language, to_all, created_at, alert_id)
     select org_id, author_user_id, author_agent_id, text, source_language, false, $2, id from announcement_alerts where id = $1
     returning id, author_agent_id`, [alertId, now])).rows[0] as { id: string; author_agent_id: string | null };
  await db.query(
    `insert into announcement_recipients(org_id, announcement_id, user_id) values (current_setting('app.org_id')::uuid, $1, $2)`, [a.id, userId]);
  await notify(db, {
    userId, kind: 'announcement', level: 'work', payload: announcementPayload(a.id, a.author_agent_id),
    dedupeKey: `alert:${alertId}:${userId}:${round}`, deliverAfter: now, createdAt: now,
  });
}

/** Снять тревогу: событие наступило. Открытой нет — `resolved: false`, не ошибка: сторож зовёт снятие на каждом проходе. */
export async function resolveAlert(db: Db, input: { key: string; reason?: string | null }, actor: Actor, now: Date = new Date()): Promise<{ resolved: boolean; alert_id: string | null }> {
  await requireActorRole(db, actor, ['owner', 'admin']);
  const reason = input.reason?.trim() || null;
  if (reason && reason.length > 500) throw new AppError('validation_failed', 'reason is too long: at most 500 characters');
  const r = await db.query(
    `update announcement_alerts set resolved_at = $2, resolved_reason = $3 where key = $1 and resolved_at is null returning id`,
    [input.key.trim(), now, reason]);
  return { resolved: !!r.rowCount, alert_id: (r.rows[0]?.id as string | undefined) ?? null };
}

/** Сколько раундов в день сейчас: после `escalate_after_days` суток с открытия — эскалированная частота. */
export function alertPerDay(a: AlertSchedule & { opened_at: Date }, now: Date): number {
  return now.getTime() - a.opened_at.getTime() >= a.escalate_after_days * DAY_MS ? a.escalated_per_day : a.per_day;
}

/**
 * Таймер тика организации: следующий раунд каждому, у кого настал момент расписания после прошлого
 * раунда. Пропущенные моменты не догоняются: после раунда отсчёт идёт от «сейчас». Раунд занимается
 * обновлением счётчика по прежнему значению — второй тик тот же раунд не задвоит. Вышедшему из
 * компании раундов нет.
 */
export async function runAlertRounds(db: Db, now: Date): Promise<void> {
  const rows = (await db.query(
    `select ar.alert_id, ar.user_id, ar.rounds, ar.last_round_at, al.opened_at, al.per_day, al.escalated_per_day, al.escalate_after_days
       from announcement_alert_recipients ar
       join announcement_alerts al on al.org_id = ar.org_id and al.id = ar.alert_id
       join memberships m on m.org_id = ar.org_id and m.user_id = ar.user_id and m.status = 'active'
      where al.resolved_at is null and al.opened_at <= $1
      order by al.opened_at, ar.user_id`, [now])).rows as (AlertSchedule & {
    alert_id: string; user_id: string; rounds: number; last_round_at: Date | null; opened_at: Date;
  })[];
  const schedules = new Map<string, Awaited<ReturnType<typeof loadUserSchedule>>>();
  for (const r of rows) {
    let schedule = schedules.get(r.user_id);
    if (!schedule) { schedule = await loadUserSchedule(db, r.user_id); schedules.set(r.user_id, schedule); }
    const slot = nextDayShare(schedule, new Date(r.last_round_at ?? r.opened_at), alertPerDay({ ...r, opened_at: new Date(r.opened_at) }, now));
    if (!slot || now < slot) continue;
    const claimed = await db.query(
      `update announcement_alert_recipients set rounds = rounds + 1, last_round_at = $4
        where alert_id = $1 and user_id = $2 and rounds = $3`, [r.alert_id, r.user_id, r.rounds, now]);
    if (!claimed.rowCount) continue;
    await alertRound(db, r.alert_id, r.user_id, r.rounds + 1, now);
  }
}

export interface AlertStatusRow {
  id: string; key: string; text: string; from: string; via_agent: string | null; opened_at: Date;
  resolved_at: Date | null; resolved_reason: string | null; days_open: number; per_day_now: number;
  recipients: { user_id: string; name: string; rounds: number; last_round_at: Date | null; last_confirmed_at: Date | null; last_confirmed_via: ConfirmVia | null }[];
}

/** Открытые тревоги и закрытые за неделю: по получателю — сколько раундов и когда последний раз прочёл. */
export async function alertStatus(db: Db, actor: Actor, now: Date = new Date()): Promise<AlertStatusRow[]> {
  await requireActorRole(db, actor, ['owner', 'admin']);
  const alerts = (await db.query(
    `select al.id, al.key, al.text, al.opened_at, al.resolved_at, al.resolved_reason, al.per_day, al.escalated_per_day, al.escalate_after_days,
            u.display_name as "from", ag.name as via_agent
       from announcement_alerts al join users u on u.id = al.author_user_id left join agents ag on ag.id = al.author_agent_id
      where al.resolved_at is null or al.resolved_at > $1
      order by al.resolved_at is not null, al.opened_at desc, al.id`, [new Date(now.getTime() - ALERT_STATUS_DAYS * DAY_MS)])).rows as
    (AlertSchedule & Omit<AlertStatusRow, 'recipients' | 'days_open' | 'per_day_now'>)[];
  const people = (await db.query(
    `select ar.alert_id, ar.user_id, u.display_name as name, ar.rounds, ar.last_round_at, c.confirmed_at as last_confirmed_at, c.confirmed_via as last_confirmed_via
       from announcement_alert_recipients ar join users u on u.id = ar.user_id
       left join lateral (
         select r.confirmed_at, r.confirmed_via from announcements a join announcement_recipients r on r.announcement_id = a.id and r.user_id = ar.user_id
          where a.alert_id = ar.alert_id and r.confirmed_at is not null order by r.confirmed_at desc limit 1) c on true
      where ar.alert_id = any($1::uuid[]) order by u.display_name, ar.user_id`,
    [alerts.map((a) => a.id)])).rows as (AlertStatusRow['recipients'][number] & { alert_id: string })[];
  return alerts.map(({ per_day, escalated_per_day, escalate_after_days, ...a }) => ({
    ...a,
    days_open: Math.floor(((a.resolved_at ? new Date(a.resolved_at) : now).getTime() - new Date(a.opened_at).getTime()) / DAY_MS),
    per_day_now: a.resolved_at ? 0 : alertPerDay({ per_day, escalated_per_day, escalate_after_days, opened_at: new Date(a.opened_at) }, now),
    recipients: people.filter((p) => p.alert_id === a.id).map(({ alert_id: _id, ...rest }) => rest),
  }));
}
