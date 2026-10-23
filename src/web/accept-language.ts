import type { Request } from 'express';
import { LANGS, type Lang } from '../i18n/index.js';

// Язык серверных страниц (вход OAuth, подключение исполнителя) — по `Accept-Language` браузера.
// Сервер общий для организаций разных стран, поэтому умолчание — английский, а не русский.
export function langFromRequest(req: Request): Lang {
  const h = (req.headers['accept-language'] ?? '').toLowerCase();
  for (const l of LANGS) if (h.startsWith(l) || h.includes(`,${l}`)) return l;
  return 'en';
}
