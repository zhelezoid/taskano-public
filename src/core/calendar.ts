import type { Db } from '../db/pool.js';

// Рабочий календарь человека: все таймеры считаются в его рабочих часах (спека
// step-lifecycle-and-queue, «Рабочий календарь»). Без внешних библиотек — через Intl.

export interface Schedule {
  tz: string;
  days: number[];            // 1 = пн … 7 = вс
  start: string;             // 'HH:MM'
  end: string;               // 'HH:MM'
  holidays: Set<string>;     // 'YYYY-MM-DD' в локальной дате
}

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function localParts(at: Date, tz: string): LocalParts {
  const parts = Object.fromEntries(formatter(tz).formatToParts(at).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), weekday: WEEKDAYS[parts.weekday!] ?? 1,
  };
}

/** Локальная дата 'YYYY-MM-DD' в часовом поясе. */
export function localDate(at: Date, tz: string): string {
  const p = localParts(at, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Локальная дата человека + N дней, как строка 'YYYY-MM-DD' (календарная дата, без рабочих часов). */
export function localDatePlusDays(s: Schedule, now: Date, days: number): string {
  const today = localDate(now, s.tz);
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

function offsetMinutes(at: Date, tz: string): number {
  const p = localParts(at, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(at.getTime() / 60000) * 60000) / 60000);
}

/** Момент UTC для локального времени в поясе (с учётом перехода на летнее время — две итерации). */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ts = guess - offsetMinutes(new Date(guess), tz) * 60000;
  ts = guess - offsetMinutes(new Date(ts), tz) * 60000;
  return new Date(ts);
}

function hm(s: string): [number, number] {
  const [h, m] = s.split(':').map(Number);
  return [h ?? 0, m ?? 0];
}

function addDaysToYmd(y: number, m: number, d: number, n: number): [number, number, number] {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

function ymdKey(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function weekdayOf(y: number, m: number, d: number): number {
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

/** Конец рабочего окна того локального дня, на который приходится `at`; null — день нерабочий. */
export function workdayEndOf(s: Schedule, at: Date): Date | null {
  const p = localParts(at, s.tz);
  return dayWindow(s, p.year, p.month, p.day)?.to ?? null;
}

/** Рабочее окно конкретного локального дня или null, если день нерабочий. */
function dayWindow(s: Schedule, y: number, m: number, d: number): { from: Date; to: Date } | null {
  if (!s.days.includes(weekdayOf(y, m, d))) return null;
  if (s.holidays.has(ymdKey(y, m, d))) return null;
  const [sh, sm] = hm(s.start);
  const [eh, em] = hm(s.end);
  const from = zonedToUtc(y, m, d, sh, sm, s.tz);
  const to = zonedToUtc(y, m, d, eh, em, s.tz);
  return to > from ? { from, to } : null;
}

export function isWorkingTime(s: Schedule, at: Date): boolean {
  const p = localParts(at, s.tz);
  const w = dayWindow(s, p.year, p.month, p.day);
  return !!w && at >= w.from && at < w.to;
}

/** Прибавить рабочие минуты. Нерабочее время пропускается. */
export function addWorkingMinutes(s: Schedule, from: Date, minutes: number): Date {
  let remaining = minutes * 60000;
  const p = localParts(from, s.tz);
  let [y, m, d] = [p.year, p.month, p.day];
  let cursor = from.getTime();
  for (let i = 0; i < 800; i++) {
    const w = dayWindow(s, y, m, d);
    if (w) {
      const start = Math.max(cursor, w.from.getTime());
      if (start < w.to.getTime()) {
        const avail = w.to.getTime() - start;
        if (remaining <= avail) return new Date(start + remaining);
        remaining -= avail;
      }
    }
    [y, m, d] = addDaysToYmd(y, m, d, 1);
  }
  throw new Error('addWorkingMinutes: нет рабочих дней в ближайшие 800 дней — проверь график');
}

/** Рабочие минуты между двумя моментами. */
export function workingMinutesBetween(s: Schedule, a: Date, b: Date): number {
  if (b <= a) return 0;
  let total = 0;
  const p = localParts(a, s.tz);
  let [y, m, d] = [p.year, p.month, p.day];
  for (let i = 0; i < 800; i++) {
    const w = dayWindow(s, y, m, d);
    if (w) {
      const lo = Math.max(a.getTime(), w.from.getTime());
      const hi = Math.min(b.getTime(), w.to.getTime());
      if (hi > lo) total += hi - lo;
      if (w.from.getTime() >= b.getTime()) break;
    }
    if (zonedToUtc(y, m, d, 0, 0, s.tz).getTime() > b.getTime()) break;
    [y, m, d] = addDaysToYmd(y, m, d, 1);
  }
  return Math.round(total / 60000);
}

/** Начало ближайшего рабочего времени (сам момент, если он рабочий). */
export function nextWorkingStart(s: Schedule, from: Date): Date {
  if (isWorkingTime(s, from)) return from;
  const p = localParts(from, s.tz);
  let [y, m, d] = [p.year, p.month, p.day];
  for (let i = 0; i < 800; i++) {
    const w = dayWindow(s, y, m, d);
    if (w && w.to > from) return w.from > from ? w.from : from;
    [y, m, d] = addDaysToYmd(y, m, d, 1);
  }
  throw new Error('nextWorkingStart: нет рабочих дней');
}

/**
 * Первый момент после `after`, когда начинается одна из `parts` равных долей рабочего окна дня
 * (окно 9–18, parts 2 → 9:00 и 13:30). Так повторяется тревога (спека announcement-alerts): раунды
 * ложатся на рабочий день человека. Нет рабочих дней — null.
 */
export function nextDayShare(s: Schedule, after: Date, parts: number): Date | null {
  if (!s.days.length || parts < 1) return null;
  const p = localParts(after, s.tz);
  let [y, m, d] = [p.year, p.month, p.day];
  for (let i = 0; i < 400; i++) {
    const w = dayWindow(s, y, m, d);
    if (w) {
      const len = w.to.getTime() - w.from.getTime();
      for (let k = 0; k < parts; k++) {
        const at = new Date(w.from.getTime() + Math.floor((k * len) / parts));
        if (at > after) return at;
      }
    }
    [y, m, d] = addDaysToYmd(y, m, d, 1);
  }
  return null;
}

/** Внутри ли тихих часов (окно может переходить через полночь). */
export function isQuietTime(tz: string, quietStart: string, quietEnd: string, at: Date): boolean {
  const p = localParts(at, tz);
  const now = p.hour * 60 + p.minute;
  const [qs, qsm] = hm(quietStart);
  const [qe, qem] = hm(quietEnd);
  const a = qs * 60 + qsm;
  const b = qe * 60 + qem;
  return a <= b ? now >= a && now < b : now >= a || now < b;
}

/** Конец тихих часов, ближайший после `at` (для откладывания уведомлений). */
export function quietEndAfter(tz: string, quietEnd: string, at: Date): Date {
  const p = localParts(at, tz);
  const [qe, qem] = hm(quietEnd);
  let candidate = zonedToUtc(p.year, p.month, p.day, qe, qem, tz);
  if (candidate <= at) {
    const [y, m, d] = addDaysToYmd(p.year, p.month, p.day, 1);
    candidate = zonedToUtc(y, m, d, qe, qem, tz);
  }
  return candidate;
}

export async function loadUserSchedule(db: Db, userId: string): Promise<Schedule> {
  const u = await db.query(
    `select timezone, work_days, to_char(work_start, 'HH24:MI') as ws, to_char(work_end, 'HH24:MI') as we, country
       from users where id = $1`,
    [userId],
  );
  const row = u.rows[0];
  if (!row) throw new Error(`loadUserSchedule: нет пользователя ${userId}`);
  // Праздники в этой версии не учитываются — только дни недели (решение владельца). Движок их
  // по-прежнему умеет (`Schedule.holidays`), и таблица `holidays` с засеянным календарём на месте:
  // праздники вернутся следующей версией, вместе с ответом на вопрос, чьи они — страны или
  // конкретной установки. До тех пор ни один график их не подтягивает.
  return { tz: row.timezone, days: row.work_days, start: row.ws, end: row.we, holidays: new Set() };
}

export function windowSchedule(window: { tz: string; days: number[]; start: string; end: string }): Schedule {
  return { tz: window.tz, days: window.days, start: window.start, end: window.end, holidays: new Set() };
}
