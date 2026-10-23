import type { Db } from '../db/pool.js';
import { withSystem } from '../db/pool.js';
import { AppError } from './errors.js';
import { emit } from './events.js';
import { localDate, localParts, zonedToUtc } from './calendar.js';

// Учёт времени — спека time-tracking. Таймер: один активный на человека во всех организациях
// (уникальный индекс time_entries_one_open на уровне таблицы, RLS его не сужает). Ручной ввод —
// без проверок, кроме здравого диапазона.

const MAX_MANUAL_MINUTES = 16 * 60;

function minutesBetween(a: Date, b: Date): number {
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / 60000));
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

/** Закрыть открытый таймер человека в текущей организации, если он есть (видим через RLS). */
async function closeOpenTimerHere(db: Db, userId: string, at: Date): Promise<void> {
  const open = await db.query(
    `select id, started_at from time_entries where user_id = $1 and ended_at is null and source = 'timer'`,
    [userId],
  );
  const row = open.rows[0] as { id: string; started_at: Date } | undefined;
  if (!row) return;
  await db.query(`update time_entries set ended_at = $2, minutes = $3 where id = $1`, [row.id, at, minutesBetween(row.started_at, at)]);
}

/** Открытый таймер человека может быть в ДРУГОЙ организации — уникальный индекс не видит org_id.
 *  Закрыть его напрямую через withSystem: легитимный системный доступ, только ended_at/minutes
 *  по user_id, содержимое задач здесь не читается. */
async function closeOpenTimerElsewhere(userId: string, at: Date): Promise<void> {
  await withSystem(async (sys) => {
    const open = await sys.query(
      `select id, started_at from time_entries where user_id = $1 and ended_at is null and source = 'timer'`,
      [userId],
    );
    const row = open.rows[0] as { id: string; started_at: Date } | undefined;
    if (!row) return;
    await sys.query(`update time_entries set ended_at = $2, minutes = $3 where id = $1`, [row.id, at, minutesBetween(row.started_at, at)]);
  });
}

export interface TimerStarted { id: string; startedAt: Date }

/**
 * Старт таймера: старт другого таймера останавливает прежний, где бы он ни шёл. `silent` — без
 * события `timer_started`: таймер, который ведёт сама смена статуса, уже записан её событием
 * (`task_taken` и т.п.), и второе событие было бы шумом в ленте дела и в разборе человека у агента.
 */
export async function startTimer(
  db: Db, userId: string, taskId: string, now: Date = new Date(), opts: { silent?: boolean } = {},
): Promise<TimerStarted> {
  await closeOpenTimerHere(db, userId, now);
  const insert = () => db.query(
    `insert into time_entries(org_id, task_id, user_id, started_at, source)
     values (current_setting('app.org_id')::uuid, $1, $2, $3, 'timer') returning id, started_at`,
    [taskId, userId, now],
  );
  await db.query('savepoint start_timer');
  try {
    const r = await insert();
    await db.query('release savepoint start_timer');
    if (!opts.silent) await emit(db, { type: 'timer_started', taskId, actorUserId: userId });
    return { id: r.rows[0].id, startedAt: r.rows[0].started_at };
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // Ошибка abort'ит транзакцию до ROLLBACK/savepoint — откатываемся к savepoint, а не ко всей транзакции.
    await db.query('rollback to savepoint start_timer');
    await closeOpenTimerElsewhere(userId, now);
    const r = await insert();
    await db.query('release savepoint start_timer');
    if (!opts.silent) await emit(db, { type: 'timer_started', taskId, actorUserId: userId });
    return { id: r.rows[0].id, startedAt: r.rows[0].started_at };
  }
}

/** Остановить активный таймер человека в текущей организации → сколько минут записано. */
export async function stopTimer(db: Db, userId: string, now: Date = new Date()): Promise<number> {
  const open = await db.query(
    `select id, started_at, task_id from time_entries where user_id = $1 and ended_at is null and source = 'timer'`,
    [userId],
  );
  const row = open.rows[0] as { id: string; started_at: Date; task_id: string | null } | undefined;
  if (!row) throw new AppError('not_found', 'No active timer');
  const minutes = minutesBetween(row.started_at, now);
  await db.query(`update time_entries set ended_at = $2, minutes = $3 where id = $1`, [row.id, now, minutes]);
  await emit(db, { type: 'timer_stopped', taskId: row.task_id, actorUserId: userId, data: { minutes } });
  return minutes;
}

/**
 * Таймер дела, которое человек взял (спека time-tracking, «Взять» ведёт учёт времени). Уже идёт по
 * этому делу — не перезапускаем: «Старт» в боте до «Взял» иначе дробил бы один подход на две записи.
 * Открытый таймер по этому делу может быть только в текущей организации — дело живёт здесь.
 */
export async function ensureTaskTimer(db: Db, userId: string, taskId: string, now: Date): Promise<void> {
  const open = await db.query(
    `select 1 from time_entries where user_id = $1 and task_id = $2 and ended_at is null and source = 'timer'`,
    [userId, taskId],
  );
  if (open.rowCount) return;
  await startTimer(db, userId, taskId, now, { silent: true });
}

/**
 * Закрыть открытый таймер человека, только если он идёт по этому делу: дело ушло из работы — его
 * счёт встал, а таймер, запущенный по другому делу, не наш. Без события — по той же причине, что
 * у `ensureTaskTimer`. Возвращает записанные минуты или null, если закрывать было нечего.
 */
export async function stopTaskTimer(db: Db, userId: string, taskId: string, now: Date): Promise<number | null> {
  const open = await db.query(
    `select id, started_at from time_entries where user_id = $1 and task_id = $2 and ended_at is null and source = 'timer'`,
    [userId, taskId],
  );
  const row = open.rows[0] as { id: string; started_at: Date } | undefined;
  if (!row) return null;
  const minutes = minutesBetween(row.started_at, now);
  await db.query(`update time_entries set ended_at = $2, minutes = $3 where id = $1`, [row.id, now, minutes]);
  return minutes;
}

export interface ManualEntry { id: string; startedAt: Date; minutes: number }

/** Ручной ввод времени. `forDate` — дата, за которую вносится время ('YYYY-MM-DD' в поясе человека);
 *  дата внесения (created_at) — всегда сейчас, отдельно от даты работы (edge case спеки). */
export async function addManual(db: Db, userId: string, taskId: string, minutes: number, forDate?: string | null): Promise<ManualEntry> {
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_MANUAL_MINUTES) {
    throw new AppError('validation_failed', 'Time must be greater than 0 and at most 16 hours, for example "45" or "1h 30m"');
  }
  const roundedMinutes = Math.round(minutes);
  let startedAt: Date;
  if (forDate) {
    const u = await db.query(`select timezone from users where id = $1`, [userId]);
    const tz = (u.rows[0]?.timezone as string) ?? 'UTC';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(forDate);
    if (!m) throw new AppError('validation_failed', `Invalid date: ${forDate}`);
    startedAt = zonedToUtc(Number(m[1]), Number(m[2]), Number(m[3]), 12, 0, tz);
  } else {
    startedAt = new Date();
  }
  // ended_at = started_at (не null): ручная запись не «открытый таймер» — избегаем неявной
  // зависимости отчёта от текущего момента при подсчёте этой строки (только у timer есть «сейчас»).
  const r = await db.query(
    `insert into time_entries(org_id, task_id, user_id, started_at, ended_at, minutes, source)
     values (current_setting('app.org_id')::uuid, $1, $2, $3, $3, $4, 'manual') returning id, started_at`,
    [taskId, userId, startedAt, roundedMinutes],
  );
  await emit(db, { type: 'time_manual_added', taskId, actorUserId: userId, data: { minutes: roundedMinutes, for_date: forDate ?? null } });
  return { id: r.rows[0].id, startedAt: r.rows[0].started_at, minutes: roundedMinutes };
}

// --- разбор длительности вводимой человеком строки -------------------------------------------

// Cyrillic-буквы не входят в \w в движке JS-регулярок без unicode-свойств — \b на них не работает
// (памятка проекта: см. сессии Joy про скрытый баг \b). Границу задаём через \p{L} c флагом u.
const NOT_LETTER_AFTER = /(?![\p{L}])/u;
const HOUR_UNIT = /(час(?:а|ов)?|ч|h|saat|giờ|gio)/iu;
const MINUTE_UNIT = /(минут(?:ы|у)?|мин|м|min|m|dk|phút|phut)/iu;
const HOUR_RE = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${HOUR_UNIT.source}${NOT_LETTER_AFTER.source}`, 'iu');
const MINUTE_RE = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${MINUTE_UNIT.source}${NOT_LETTER_AFTER.source}`, 'iu');
const HM_RE = /^(\d{1,2}):([0-5]\d)$/;
const BARE_NUMBER_RE = /^(\d+(?:[.,]\d+)?)$/;

function parseNum(s: string): number {
  return Number(s.replace(',', '.'));
}

/** Разбор «45», «1ч 30м», «1:30», «1.5h», «1 saat 30 dk», «45 phút» и т.п. → минуты, либо null. */
export function parseDuration(text: string): number | null {
  const raw = text.trim().toLowerCase();
  if (!raw) return null;

  let total: number | null = null;
  const hm = HM_RE.exec(raw);
  if (hm) {
    total = Number(hm[1]) * 60 + Number(hm[2]);
  } else {
    const hourMatch = HOUR_RE.exec(raw);
    const minuteMatch = MINUTE_RE.exec(raw);
    if (hourMatch || minuteMatch) {
      total = (hourMatch ? parseNum(hourMatch[1]!) * 60 : 0) + (minuteMatch ? parseNum(minuteMatch[1]!) : 0);
    } else {
      const bare = BARE_NUMBER_RE.exec(raw);
      if (bare) total = parseNum(bare[1]!);
    }
  }

  if (total === null) return null;
  const rounded = Math.round(total);
  if (rounded <= 0 || rounded > MAX_MANUAL_MINUTES) return null;
  return rounded;
}

// --- отчёт по времени -------------------------------------------------------------------------

export interface TimeReportOptions {
  userIds?: string[];
  from: Date;
  to: Date;
  groupBy: 'day' | 'task' | 'agent';
  agentScope?: string | null;   // видны только задачи этого агента (author_agent_id)
  now?: Date;                   // до какого момента считать открытый таймер (по умолчанию — сейчас)
}

export interface TimeReportGroup {
  key: string;
  minutes: number;
  timerMinutes: number;
  manualMinutes: number;
  taskCount: number;
  open: boolean;
}

export interface TimeReportResult { groups: TimeReportGroup[]; totalMinutes: number }

interface RawEntry {
  task_id: string | null;
  user_id: string;
  started_at: Date;
  ended_at: Date | null;
  minutes: number | null;
  source: 'timer' | 'manual';
  timezone: string;
  author_agent_id: string | null;
}

/** Начало следующих локальных суток относительно `at` в поясе `tz`. */
function nextLocalMidnight(at: Date, tz: string): Date {
  const p = localParts(at, tz);
  const t = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return zonedToUtc(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), 0, 0, tz);
}

/** Разбить [start, end) на отрезки по локальным суткам человека (таймер через полночь — edge case спеки). */
function splitByLocalDay(start: Date, end: Date, tz: string): { from: Date; to: Date; day: string }[] {
  const segments: { from: Date; to: Date; day: string }[] = [];
  let cursor = start;
  for (let i = 0; i < 400 && cursor < end; i++) {
    const boundary = nextLocalMidnight(cursor, tz);
    const segEnd = boundary < end ? boundary : end;
    segments.push({ from: cursor, to: segEnd, day: localDate(cursor, tz) });
    cursor = segEnd;
  }
  return segments;
}

/**
 * Минуты одной записи в окне [from, to) — та же арифметика, что в `timeReport`: ручная запись
 * целиком, таймер — пересечение с окном, идущий — до `now`, округление по отрезкам суток человека.
 * Нужна «Итогам» (спека stats-page): числа страницы обязаны сходиться с отчётом по времени до минуты,
 * а округление целиком вместо поотрезочного расходилось бы на таймерах через полночь.
 */
export function entryMinutesInRange(
  row: { started_at: Date; ended_at: Date | null; minutes: number | null; source: 'timer' | 'manual'; timezone: string },
  from: Date, to: Date, now: Date,
): number {
  if (row.source === 'manual') return row.minutes ?? 0;
  const effectiveEnd = row.ended_at ?? now;
  const clampedStart = row.started_at < from ? from : row.started_at;
  const clampedEnd = effectiveEnd > to ? to : effectiveEnd;
  if (clampedEnd <= clampedStart) return 0;
  return splitByLocalDay(clampedStart, clampedEnd, row.timezone)
    .reduce((sum, seg) => sum + Math.max(0, Math.round((seg.to.getTime() - seg.from.getTime()) / 60000)), 0);
}

function groupKeyFor(groupBy: TimeReportOptions['groupBy'], ctx: { day: string; taskId: string | null; agentId: string | null }): string {
  if (groupBy === 'day') return ctx.day;
  if (groupBy === 'task') return ctx.taskId ?? 'no_task';
  return ctx.agentId ?? 'none';
}

interface GroupAcc { minutes: number; timerMinutes: number; manualMinutes: number; taskIds: Set<string>; open: boolean }

function addToGroup(groups: Map<string, GroupAcc>, key: string, delta: { total: number; timer: number; manual: number; taskId: string | null; open: boolean }): void {
  let g = groups.get(key);
  if (!g) { g = { minutes: 0, timerMinutes: 0, manualMinutes: 0, taskIds: new Set(), open: false }; groups.set(key, g); }
  g.minutes += delta.total;
  g.timerMinutes += delta.timer;
  g.manualMinutes += delta.manual;
  if (delta.taskId) g.taskIds.add(delta.taskId);
  if (delta.open) g.open = true;
}

/**
 * Отчёт по времени — часы, разбивка таймер/ручной, число задач; границы дней в поясе КАЖДОГО
 * человека; открытый таймер считается до `now` и помечается `open: true`. `agentScope` — только
 * задачи этого агента (право `time_report_full` проверяет вызывающий слой — MCP-инструмент).
 */
export async function timeReport(db: Db, opts: TimeReportOptions): Promise<TimeReportResult> {
  const now = opts.now ?? new Date();
  // Открытый таймер — «сейчас» задаёт вызывающий (тесты, детерминизм), не SQL now(): иначе строка
  // может выпасть из окна [from, to), если теста используют даты, отличные от настенного времени.
  const params: unknown[] = [opts.from, opts.to, now];
  let filter = '';
  if (opts.userIds?.length) { params.push(opts.userIds); filter += ` and te.user_id = any($${params.length})`; }
  if (opts.agentScope) { params.push(opts.agentScope); filter += ` and t.author_agent_id = $${params.length}`; }

  const rows = (await db.query(
    `select te.task_id, te.user_id, te.started_at, te.ended_at, te.minutes, te.source,
            u.timezone, t.author_agent_id
       from time_entries te
       join users u on u.id = te.user_id
       left join tasks t on t.id = te.task_id
      where te.started_at < $2 and coalesce(te.ended_at, $3::timestamptz) > $1 ${filter}
      order by te.started_at`,
    params,
  )).rows as RawEntry[];

  const groups = new Map<string, GroupAcc>();

  for (const row of rows) {
    if (row.source === 'manual') {
      const day = localDate(row.started_at, row.timezone);
      const key = groupKeyFor(opts.groupBy, { day, taskId: row.task_id, agentId: row.author_agent_id });
      addToGroup(groups, key, { total: row.minutes ?? 0, timer: 0, manual: row.minutes ?? 0, taskId: row.task_id, open: false });
      continue;
    }
    const isOpen = row.ended_at === null;
    const effectiveEnd = row.ended_at ?? now;
    const clampedStart = row.started_at < opts.from ? opts.from : row.started_at;
    const clampedEnd = effectiveEnd > opts.to ? opts.to : effectiveEnd;
    if (clampedEnd <= clampedStart) continue;
    const segments = splitByLocalDay(clampedStart, clampedEnd, row.timezone);
    segments.forEach((seg, i) => {
      const minutes = Math.round((seg.to.getTime() - seg.from.getTime()) / 60000);
      if (minutes <= 0) return;
      const key = groupKeyFor(opts.groupBy, { day: seg.day, taskId: row.task_id, agentId: row.author_agent_id });
      addToGroup(groups, key, { total: minutes, timer: minutes, manual: 0, taskId: row.task_id, open: isOpen && i === segments.length - 1 });
    });
  }

  const result = [...groups.entries()]
    .map(([key, g]) => ({ key, minutes: g.minutes, timerMinutes: g.timerMinutes, manualMinutes: g.manualMinutes, taskCount: g.taskIds.size, open: g.open }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const totalMinutes = result.reduce((s, g) => s + g.minutes, 0);
  return { groups: result, totalMinutes };
}
