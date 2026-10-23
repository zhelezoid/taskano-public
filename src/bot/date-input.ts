import { localDate } from '../core/calendar.js';
import type { Schedule } from '../core/calendar.js';

// Разбор дат, которые вводит человек текстом («Выбрать дату», срок быстрой записи) — всегда в его
// часовом поясе. Спека telegram-bot: «Выбрать дату» — «ДД.ММ», всегда новая (будущая) дата.

/** «ДД.ММ» → 'YYYY-MM-DD', ближайшая будущая (сегодня или позже); прошедшая дата — на следующий год. */
export function parseDayMonth(text: string, schedule: Schedule, now: Date): string | null {
  const m = /^(\d{1,2})[.\/](\d{1,2})\.?$/.exec(text.trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  const today = localDate(now, schedule.tz);
  const [ty] = today.split('-').map(Number) as [number];
  const candidate = `${ty}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const date = new Date(`${candidate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  if (candidate < today) return `${ty + 1}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return candidate;
}
