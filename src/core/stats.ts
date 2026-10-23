import type { Db } from '../db/pool.js';
import { AppError } from './errors.js';
import { localParts, zonedToUtc } from './calendar.js';
import { LOAD_STATUSES } from './types.js';
import { taskKey } from './projects.js';
import { entryMinutesInRange } from './time.js';

// Итоги работы (спека stats-page): сколько сделано за период, кем и на какой проекте.
//
// Считается по ленте событий, а не по текущему статусу дела: `closed_at` у дела не заполняется, а
// `status_changed_at` перетирается любым следующим изменением — по ним «сделано вчера» не посчитать.
// Лента только дополняется, и у каждого события есть своё время.

export type Period = 'today' | 'yesterday' | '7d' | '30d' | 'this_month' | 'last_month';

export const PERIODS: Period[] = ['today', 'yesterday', '7d', '30d', 'this_month', 'last_month'];

/** Работа принята: дело не просто сдано, а зачтено. Автоприёмка — то же самое, только без человека. */
const DONE_TYPES = ['task_accepted', 'auto_accepted'];
/** Сдано и ждёт приёмки: труд уже есть, и показывать его нулём нечестно. */
const SUBMITTED_TYPES = ['task_submitted'];
/** Отменено и отклонено — отдельной строкой: это другая история, и прятать её нечестно. */
const DROPPED_TYPES = ['cancelled', 'declined'];

export interface Range {
  from: Date;
  to: Date;
  /** Название месяца для календарных периодов — иначе непонятно, какой месяц идёт в счёт. */
  label: string | null;
}

export interface Counts { done: number; submitted: number; dropped: number }

/** Числа периода: дела по ленте событий и отработанные минуты по учёту времени. */
export interface Totals extends Counts { minutes: number }

/**
 * Задача человека со временем за период. Время без задачи — `id: null`, `hidden: false`; задача
 * закрытого проекта, которую смотрящему не видно, — `hidden: true` без номера и названия: имя
 * закрытого дела — ровно то, что от смотрящего скрывают.
 */
export interface StatsTask { id: string | null; key: string | null; title: string | null; hidden: boolean; minutes: number }

export interface StatsRow extends Totals {
  id: string;
  name: string;
  /** Сколько у человека или в проекте сейчас в работе — рядом с итогом периода. */
  open: number;
}

export interface StatsPerson extends StatsRow {
  /** На что ушло время: до `TASKS_PER_PERSON` задач, от большего к меньшему. */
  tasks: StatsTask[];
}

export interface Stats {
  period: Period;
  from: string;
  to: string;
  tz: string;
  label: string | null;
  totals: Totals;
  people: StatsPerson[];
  projects: StatsRow[];
}

/** Сколько задач показывать у человека: список для взгляда, а не отчёт. */
const TASKS_PER_PERSON = 30;

const MONTHS: Record<string, string[]> = {
  ru: ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  tr: ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'],
  vi: ['tháng 1', 'tháng 2', 'tháng 3', 'tháng 4', 'tháng 5', 'tháng 6', 'tháng 7', 'tháng 8', 'tháng 9', 'tháng 10', 'tháng 11', 'tháng 12'],
};

const monthName = (month: number, lang: string): string => (MONTHS[lang] ?? MONTHS.en!)[month - 1]!;

/**
 * Границы периода в часовом поясе организации (спека stats-page). «Сегодня» у всех в компании одно
 * и то же: иначе числа людей не складываются в число компании.
 *
 * Скользящие окна («7 дней», «30 дней») и календарные месяцы считаются по-разному и называются
 * по-разному — подменять одно другим нельзя: в начале месяца они расходятся сильно.
 */
export function periodRange(period: Period, tz: string, now: Date, lang = 'en'): Range {
  const p = localParts(now, tz);
  const startOfDay = (y: number, m: number, d: number): Date => zonedToUtc(y, m, d, 0, 0, tz);
  const dayStart = startOfDay(p.year, p.month, p.day);
  switch (period) {
    case 'today':
      return { from: dayStart, to: now, label: null };
    case 'yesterday': {
      const prev = localParts(new Date(dayStart.getTime() - 12 * 3600_000), tz);
      return { from: startOfDay(prev.year, prev.month, prev.day), to: dayStart, label: null };
    }
    case '7d':
    case '30d': {
      const days = period === '7d' ? 6 : 29;
      // Через календарь, а не вычитанием 7×24 часов: в неделю с переводом часов суток не 24 часа,
      // и окно съехало бы на час, тихо захватив или потеряв край дня.
      const back = localParts(new Date(dayStart.getTime() - days * 86_400_000 - 12 * 3600_000), tz);
      return { from: startOfDay(back.year, back.month, back.day), to: now, label: null };
    }
    case 'this_month':
      return { from: startOfDay(p.year, p.month, 1), to: now, label: monthName(p.month, lang) };
    case 'last_month': {
      const year = p.month === 1 ? p.year - 1 : p.year;
      const month = p.month === 1 ? 12 : p.month - 1;
      return { from: startOfDay(year, month, 1), to: startOfDay(p.year, p.month, 1), label: monthName(month, lang) };
    }
    default:
      throw new AppError('validation_failed', `Unknown period: ${period}`);
  }
}

/**
 * Итоги организации за период. `viewerId` — тот, кто смотрит: владелец и админ видят всю компанию,
 * остальные только себя (чужая выработка — не их дело, спека stats-page).
 *
 * Дело считается за тем, кто его делал (`assignee_user_id`), а не за тем, кто нажал кнопку приёмки,
 * и попадает в ту проект, на которой лежит сейчас: проект дела — свойство дела, а не события.
 */
export async function orgStats(
  db: Db, opts: { period: Period; tz: string; lang?: string; viewerId: string; wholeOrg: boolean; now?: Date },
): Promise<Stats> {
  const now = opts.now ?? new Date();
  const range = periodRange(opts.period, opts.tz, now, opts.lang ?? 'en');
  const params = [range.from, range.to, DONE_TYPES, SUBMITTED_TYPES, DROPPED_TYPES, opts.wholeOrg ? null : opts.viewerId];

  // Одно событие на дело в каждой корзине: дело, принятое после доработки дважды, — одно сделанное
  // дело, а не два. Дело, сданное и затем принятое, считается сделанным, а не «ждёт приёмки».
  const counted = `
    with ev as (
      select distinct on (e.task_id, bucket) e.task_id, t.assignee_user_id, t.project_id, bucket
        from events e
        join tasks t on t.id = e.task_id
        join lateral (select case
               when e.type = any($3) then 'done'
               when e.type = any($4) then 'submitted'
               when e.type = any($5) then 'dropped' end as bucket) b on b.bucket is not null
       where e.at >= $1 and e.at < $2
         and ($6::uuid is null or t.assignee_user_id = $6)
       order by e.task_id, bucket, e.at desc
    ),
    fixed as (
      select task_id, assignee_user_id, project_id,
             case when bucket = 'submitted' and exists (
                    select 1 from ev d where d.task_id = ev.task_id and d.bucket = 'done')
                  then null else bucket end as bucket
        from ev
    )
    select assignee_user_id, project_id, bucket, count(*)::int as n from fixed
     where bucket is not null group by 1, 2, 3`;

  const rows = (await db.query(counted, params)).rows as {
    assignee_user_id: string | null; project_id: string | null; bucket: string; n: number;
  }[];

  const zero = (): Totals => ({ done: 0, submitted: 0, dropped: 0, minutes: 0 });
  const totals = zero();
  const byPerson = new Map<string, Totals>();
  const byProject = new Map<string, Totals>();
  const bump = (into: Map<string, Totals>, key: string | null, field: keyof Totals, n: number): void => {
    if (!key) return;
    const cur = into.get(key) ?? zero();
    cur[field] += n;
    into.set(key, cur);
  };
  for (const r of rows) {
    totals[r.bucket as keyof Counts] += r.n;
    bump(byPerson, r.assignee_user_id, r.bucket as keyof Counts, r.n);
    bump(byProject, r.project_id, r.bucket as keyof Counts, r.n);
  }

  // Время — по учёту времени, а не по ленте: окно и арифметика те же, что у `timeReport`, иначе
  // «Итоги» и отчёт по времени за один период разошлись бы. Время считается за тем, кто его вёл
  // (`te.user_id`), — не управляющий видит только своё, как и остальные числа страницы.
  // Дело берётся левым соединением: у `time_entries` граница — только организация, а дело закрытого
  // проекта правило видимости смотрящему не отдаёт — такая запись остаётся временем, но без названия.
  const entries = (await db.query(
    `select te.task_id, te.user_id, te.started_at, te.ended_at, te.minutes, te.source, u.timezone,
            t.id as visible_id, t.title, t.number, t.project_id, p.key as project_key
       from time_entries te
       join users u on u.id = te.user_id
       left join tasks t on t.id = te.task_id
       left join projects p on p.id = t.project_id
      where te.started_at < $2 and coalesce(te.ended_at, $3::timestamptz) > $1
        and ($4::uuid is null or te.user_id = $4)`,
    [range.from, range.to, now, opts.wholeOrg ? null : opts.viewerId])).rows as {
    task_id: string | null; user_id: string; started_at: Date; ended_at: Date | null; minutes: number | null;
    source: 'timer' | 'manual'; timezone: string; visible_id: string | null; title: string | null;
    number: number | null; project_id: string | null; project_key: string | null;
  }[];

  const personTasks = new Map<string, Map<string, StatsTask>>();
  for (const e of entries) {
    const minutes = entryMinutesInRange(e, range.from, range.to, now);
    if (minutes <= 0) continue;
    totals.minutes += minutes;
    bump(byPerson, e.user_id, 'minutes', minutes);
    bump(byProject, e.project_id, 'minutes', minutes);

    const hidden = e.task_id !== null && e.visible_id === null;
    const slot = e.task_id ?? '';
    const tasks = personTasks.get(e.user_id) ?? new Map<string, StatsTask>();
    const cur = tasks.get(slot) ?? (hidden
      ? { id: null, key: null, title: null, hidden: true, minutes: 0 }
      : { id: e.task_id, key: taskKey(e.project_key, e.number), title: e.title, hidden: false, minutes: 0 });
    cur.minutes += minutes;
    tasks.set(slot, cur);
    personTasks.set(e.user_id, tasks);
  }
  const tasksOf = (userId: string): StatsTask[] => [...(personTasks.get(userId)?.values() ?? [])]
    .sort((a, b) => b.minutes - a.minutes || (a.title ?? '').localeCompare(b.title ?? ''))
    .slice(0, TASKS_PER_PERSON);

  // Люди и проекты берутся из справочников, а не из событий: человек без единого дела за период
  // показывается с нулём — пропавший из списка выглядит как ошибка (спека stats-page).
  const people = (await db.query(
    `select u.id, u.display_name as name,
            (select count(*)::int from tasks t where t.assignee_user_id = u.id and t.status = any($2)) as open
       from memberships m join users u on u.id = m.user_id
      where m.org_id = current_setting('app.org_id')::uuid and m.status <> 'removed' and u.anonymized_at is null
        and ($1::uuid is null or u.id = $1)
      order by u.display_name`, [opts.wholeOrg ? null : opts.viewerId, LOAD_STATUSES])).rows as
    { id: string; name: string; open: number }[];

  // Смотрит не управляющий — считаем только его дела, и проекты показываем те, где они есть.
  // Иначе обещание «остальные видят только себя» нарушалось бы самой страницей: рядовой участник
  // видел перечень проектов компании с числом чужих дел в каждом.
  const projects = (await db.query(
    `select p.id, p.name,
            (select count(*)::int from tasks t
              where t.project_id = p.id and t.status = any($1)
                and ($2::uuid is null or t.assignee_user_id = $2)) as open
       from projects p
      where p.status = 'active'
        and ($2::uuid is null or exists (
              select 1 from tasks t where t.project_id = p.id and t.assignee_user_id = $2))
      order by p.private, lower(p.name)`, [LOAD_STATUSES, opts.wholeOrg ? null : opts.viewerId])).rows as
    { id: string; name: string; open: number }[];

  const fill = (list: { id: string; name: string; open: number }[], counts: Map<string, Totals>): StatsRow[] => list
    .map((x) => ({ ...x, ...(counts.get(x.id) ?? zero()) }))
    .sort((a, b) => b.done - a.done || a.name.localeCompare(b.name));

  return {
    period: opts.period, from: range.from.toISOString(), to: range.to.toISOString(), tz: opts.tz,
    label: range.label, totals,
    people: fill(people, byPerson).map((r) => ({ ...r, tasks: tasksOf(r.id) })),
    projects: fill(projects, byProject),
  };
}
