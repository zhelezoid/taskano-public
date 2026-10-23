import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Интерфейс бота — только эти файлы (спека telegram-bot). Нет ключа в языке → en → сам ключ
// (виднее, что перевод не хватает, чем упасть).

export const LANGS = ['ru', 'tr', 'vi', 'en'] as const;
export type Lang = (typeof LANGS)[number];

const DIR = dirname(fileURLToPath(import.meta.url));

function load(lang: Lang): Record<string, string> {
  return JSON.parse(readFileSync(join(DIR, `${lang}.json`), 'utf8')) as Record<string, string>;
}

const DICTS: Record<Lang, Record<string, string>> = { ru: load('ru'), tr: load('tr'), vi: load('vi'), en: load('en') };

export function isLang(v: string | null | undefined): v is Lang {
  return !!v && (LANGS as readonly string[]).includes(v);
}

export function t(lang: string | null | undefined, key: string, params: Record<string, string | number> = {}): string {
  const dict = isLang(lang) ? DICTS[lang] : DICTS.en;
  let s = dict[key] ?? DICTS.en[key] ?? key;
  for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

export function dictKeys(lang: Lang): string[] {
  return Object.keys(DICTS[lang]);
}

/** Русское согласование числительного с существительным: 1 день, 2 дня, 5 дней. */
export function pluralRu(n: number, forms: readonly [string, string, string]): string {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return forms[0];
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return forms[1];
  return forms[2];
}

/** «2 дня» / «2 days» / «2 gün» / «2 ngày» — числительные ru/tr/vi/en не совпадают по правилам
 * согласования (тюркские и вьетнамский не склоняют число), поэтому не отдельный i18n-ключ на слово. */
export function daysLabel(lang: string, days: number): string {
  if (lang === 'ru') return `${days} ${pluralRu(days, ['день', 'дня', 'дней'])}`;
  if (lang === 'tr') return `${days} gün`;
  if (lang === 'vi') return `${days} ngày`;
  return `${days} day${days === 1 ? '' : 's'}`;
}

const DATE_LOCALE: Record<Lang, string> = { ru: 'ru-RU', tr: 'tr-TR', vi: 'vi-VN', en: 'en-US' };

/**
 * Дата по-человечески на языке получателя (спека bot-messages): «вчера», «завтра», «22 сентября»,
 * а не `2026-09-22` как в базе. Обе даты — локальные календарные `YYYY-MM-DD` получателя; год
 * называется, только если он не текущий.
 */
export function humanDate(lang: string, date: string, today: string): string {
  const diff = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  if (diff === 0) return t(lang, 'date.today');
  if (diff === -1) return t(lang, 'date.yesterday');
  if (diff === 1) return t(lang, 'date.tomorrow');
  const locale = DATE_LOCALE[isLang(lang) ? lang : 'en'];
  const sameYear = date.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' })
    .format(new Date(`${date}T00:00:00Z`));
}

/**
 * Дата и время по-человечески в поясе получателя: «21 октября, 14:30». Для отметок «когда сделано»
 * (подтверждение объявления): `humanDate` отвечает на «какой день», здесь нужен ещё и час.
 */
export function humanDateTime(lang: string, at: Date, timeZone: string): string {
  const locale = DATE_LOCALE[isLang(lang) ? lang : 'en'];
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(at);
}
