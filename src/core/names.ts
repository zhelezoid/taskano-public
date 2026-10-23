import { AppError } from './errors.js';

// Названия и имена, которые уходят в письма с домена taskano.app и в уведомления (спека open-signup).
// Регистрация открыта, поэтому название компании и имя приглашённого — чужой текст в нашем письме:
// без переводов строк, управляющих символов и ссылок, иначе письмо-приглашение становится фишингом.

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const LINK = /(https?:\/\/|www\.|[a-z0-9-]+\.(com|net|org|io|app|co|ru|info|biz|xyz|me|link|site|online|top|shop)\b)/i;

export function assertPlainName(value: string, field: string, max: number): string {
  const v = value.trim();
  if (!v) throw new AppError('validation_failed', `${field} is required`);
  if (v.length > max) throw new AppError('validation_failed', `${field} is longer than ${max} characters`);
  if (CONTROL.test(v)) throw new AppError('validation_failed', `${field} must be one line of plain text`);
  if (LINK.test(v)) throw new AppError('validation_failed', `${field} must not contain links or web addresses`);
  return v;
}

/** Для строки в Telegram владельцу продукта: одна строка и не длиннее `max`. */
export const oneLine = (s: string, max: number): string => s.replace(/\s+/g, ' ').trim().slice(0, max);
