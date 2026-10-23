import { withGlobal, type Db } from '../db/pool.js';
import { actingUserId } from './access.js';
import { localDate } from './calendar.js';
import type { Actor } from './types.js';

// Отметки «когда человек последний раз заходил» в бота и в Mini App (спека person-presence).
//
// Taskano хранит действия, а просмотр действием не был: человек мог неделю открывать приложение и
// ничего не нажимать — или не открывать его ни разу, — и отличить одно от другого было нечем.

/**
 * С какой даты отметкам можно верить: до выкатки они не писались. `null` у человека значит «с этой
 * даты не заходил», а не «не заходил никогда» — агенту нельзя говорить о времени, когда никто не смотрел.
 */
export const SEEN_TRACKED_SINCE = '2026-09-29';

/** Сколько часов без захода ни в бота, ни в приложение — повод сказать владельцу в сводке (3 суток). */
export const NOT_SEEN_HOURS = 72;

/**
 * Отметка пишется не чаще раза в 5 минут на канал: каждое нажатие в боте и каждый запрос приложения
 * — это запрос к базе, и без порога человек, листающий список, писал бы в `users` на каждое касание.
 */
const THROTTLE = `interval '5 minutes'`;

/** Человек что-то сделал в личном чате бота. `false` — такого Telegram среди привязанных нет. */
export async function touchBotSeen(telegramUserId: number): Promise<boolean> {
  const r = await withGlobal((db) => db.query(
    `update users u set last_seen_bot_at = now()
       from telegram_links tl
      where tl.telegram_user_id = $1 and u.id = tl.user_id
        and (u.last_seen_bot_at is null or u.last_seen_bot_at < now() - ${THROTTLE})`,
    [telegramUserId]));
  return (r.rowCount ?? 0) > 0;
}

/** Приложение открыто: запрос Mini App прошёл авторизацию. */
export async function touchAppSeen(userId: string): Promise<boolean> {
  const r = await withGlobal((db) => db.query(
    `update users set last_seen_app_at = now()
      where id = $1 and (last_seen_app_at is null or last_seen_app_at < now() - ${THROTTLE})`,
    [userId]));
  return (r.rowCount ?? 0) > 0;
}

/**
 * Когда заходил — словами: `within the last hour`, `today`, `yesterday`, `N days ago`. Не временем:
 * округлённое «в 15:00» при заходе в 15:54 владелец читал как ошибку, а точное время — это уже слежка,
 * а не управление. «В течение часа» — по прошедшему времени, дальше — по календарю смотрящего.
 */
export type SeenPhrase = 'within the last hour' | 'today' | 'yesterday' | `${number} days ago`;

export interface Presence {
  last_seen_bot: SeenPhrase | null;
  /** День захода (YYYY-MM-DD) в часовом поясе смотрящего. */
  last_seen_bot_on: string | null;
  last_seen_app: SeenPhrase | null;
  last_seen_app_on: string | null;
  seen_tracked_since: string;
}

const dayNumber = (isoDate: string): number => Date.UTC(
  Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1, Number(isoDate.slice(8, 10))) / 86_400_000;

/** Одна отметка словами и днём — в поясе `tz` того, кто смотрит. */
export function seenPhrase(at: Date | null | undefined, tz: string, now: Date = new Date()): { phrase: SeenPhrase | null; on: string | null } {
  if (!at) return { phrase: null, on: null };
  const on = localDate(at, tz);
  // Отметка «из будущего» (расхождение часов базы и процесса) — тоже «только что».
  if (now.getTime() - at.getTime() < 3600_000) return { phrase: 'within the last hour', on };
  const days = dayNumber(localDate(now, tz)) - dayNumber(on);
  if (days <= 0) return { phrase: 'today', on };
  if (days === 1) return { phrase: 'yesterday', on };
  return { phrase: `${days} days ago`, on };
}

/**
 * Отметки в том виде, в каком их видят снаружи (MCP, Mini App): словами и днём, без времени.
 * Единственный путь отметок наружу — этот хелпер.
 */
export function presenceView(bot: Date | null | undefined, app: Date | null | undefined, tz: string, now: Date = new Date()): Presence {
  const b = seenPhrase(bot, tz, now);
  const a = seenPhrase(app, tz, now);
  return {
    last_seen_bot: b.phrase, last_seen_bot_on: b.on, last_seen_app: a.phrase, last_seen_app_on: a.on,
    seen_tracked_since: SEEN_TRACKED_SINCE,
  };
}

/** Сырые отметки человека — для решений сервера (повтор приглашения), не для ответа. */
export async function loadSeen(db: Db, userId: string): Promise<{ bot: Date | null; app: Date | null }> {
  const row = (await db.query(`select last_seen_bot_at, last_seen_app_at from users where id = $1`, [userId])).rows[0];
  return { bot: row?.last_seen_bot_at ?? null, app: row?.last_seen_app_at ?? null };
}

/**
 * Часовой пояс того, кто смотрит: человек сам или хозяин агента (как в `actorHasRole`). «Вчера» —
 * это вчера у владельца, а не на сервере: иначе заход в 23:30 по Москве назывался бы «сегодня».
 */
export async function viewerTimezone(db: Db, actor: Actor): Promise<string> {
  const userId = await actingUserId(db, actor);
  if (!userId) return 'UTC';
  return (await db.query(`select timezone from users where id = $1`, [userId])).rows[0]?.timezone ?? 'UTC';
}

/**
 * Отметки одного человека для ответа. Звать только про активного участника компании смотрящего:
 * приглашённый ещё не в компании, и его отметки — это его жизнь в чужих компаниях (владелец любой
 * компании может пригласить любой адрес).
 */
export async function presenceOf(db: Db, userId: string, tz: string, now: Date = new Date()): Promise<Presence> {
  const seen = await loadSeen(db, userId);
  return presenceView(seen.bot, seen.app, tz, now);
}
