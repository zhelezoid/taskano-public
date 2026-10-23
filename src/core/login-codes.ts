import type { Db } from '../db/pool.js';
import { AppError } from './errors.js';
import { safeEqual, sha256, sixDigitCode } from './crypto.js';

// Код входа на почту: 10 минут, 5 попыток на код. Код привязан к цели (oauth|bot) и, для OAuth,
// к конкретной странице входа. Лимиты — против подбора и рассылки писем на чужие адреса
// (аудит безопасности, п.3). Отправка письма — вызывающий (email/send.ts).

export const CODE_TTL_MS = 10 * 60 * 1000;
export const RESEND_INTERVAL_MS = 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const LIMITS = { perEmailHour: 5, perEmailDay: 20, perPending: 5, globalHour: 500, failedPerEmailHour: 10 };

export type CodePurpose = 'oauth' | 'bot';

async function count(db: Db, sql: string, params: unknown[]): Promise<number> {
  return (await db.query(sql, params)).rows[0].n as number;
}

export async function issueLoginCode(
  db: Db, email: string, purpose: CodePurpose, opts: { pendingId?: string | null; now?: Date } = {},
): Promise<string> {
  const now = opts.now ?? new Date();
  const normalized = email.trim().toLowerCase();
  const last = await db.query(`select sent_at from login_codes where email = $1 order by sent_at desc limit 1`, [normalized]);
  if (last.rowCount && now.getTime() - new Date(last.rows[0].sent_at).getTime() < RESEND_INTERVAL_MS) {
    throw new AppError('limit_exceeded', 'A code was already sent, a new one can be requested in a minute');
  }
  const hour = new Date(now.getTime() - 3600_000);
  const day = new Date(now.getTime() - 86400_000);
  if (await count(db, `select count(*)::int as n from login_codes where email = $1 and sent_at > $2`, [normalized, hour]) >= LIMITS.perEmailHour
    || await count(db, `select count(*)::int as n from login_codes where email = $1 and sent_at > $2`, [normalized, day]) >= LIMITS.perEmailDay) {
    throw new AppError('limit_exceeded', 'Too many codes for this email. Try again later');
  }
  if (opts.pendingId && await count(db, `select count(*)::int as n from login_codes where pending_id = $1`, [opts.pendingId]) >= LIMITS.perPending) {
    throw new AppError('limit_exceeded', 'Too many codes for this sign-in. Start the sign-in again');
  }
  if (await count(db, `select count(*)::int as n from login_codes where sent_at > $1`, [hour]) >= LIMITS.globalHour) {
    throw new AppError('limit_exceeded', 'The service is temporarily not sending codes. Try again later');
  }
  const code = sixDigitCode();
  await db.query(
    `insert into login_codes(email, purpose, pending_id, code_hash, expires_at, sent_at) values ($1, $2, $3, $4, $5, $6)`,
    [normalized, purpose, opts.pendingId ?? null, sha256(`${normalized}:${code}`), new Date(now.getTime() + CODE_TTL_MS), now],
  );
  return code;
}

export async function verifyLoginCode(
  db: Db, email: string, code: string, opts: { purpose: CodePurpose; pendingId?: string | null; now?: Date },
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const normalized = email.trim().toLowerCase();
  // Неудачи считаются в пределах того же входа (цель + страница входа), а не на всю почту: иначе любой,
  // кто знает адрес, десятком неверных кодов в боте закрывал владельцу вход и в коннектор на час
  // (аудит безопасности 07.10). Подбор и так ограничен: кодов на почту — 5 в час, попыток на код — 5.
  const failed = await count(db,
    `select coalesce(sum(attempts), 0)::int as n from login_codes
      where email = $1 and purpose = $2 and pending_id is not distinct from $3 and sent_at > $4`,
    [normalized, opts.purpose, opts.pendingId ?? null, new Date(now.getTime() - 3600_000)]);
  if (failed >= LIMITS.failedPerEmailHour) return false;
  const r = await db.query(
    `select id, code_hash, attempts, expires_at from login_codes
      where email = $1 and purpose = $2 and pending_id is not distinct from $3 and consumed_at is null
      order by sent_at desc limit 1 for update`,
    [normalized, opts.purpose, opts.pendingId ?? null],
  );
  const row = r.rows[0];
  if (!row || new Date(row.expires_at) < now || row.attempts >= MAX_ATTEMPTS) return false;
  const ok = safeEqual(row.code_hash, sha256(`${normalized}:${code.trim()}`));
  if (ok) await db.query('update login_codes set consumed_at = $2 where id = $1', [row.id, now]);
  else await db.query('update login_codes set attempts = attempts + 1 where id = $1', [row.id]);
  return ok;
}
