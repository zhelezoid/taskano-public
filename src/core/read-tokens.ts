import { withGlobal } from '../db/pool.js';
import { randomToken, sha256 } from './crypto.js';
import { AppError } from './errors.js';
import { notify } from './notify.js';
import { ensurePersonalOrg } from './people.js';

// Токен только на чтение для программ человека (спека read-tokens): фоновая программа на его
// компьютере раз в несколько минут читает ленту «что нового». OAuth для неё хрупок — повтор старого
// refresh гасит всю цепочку, — поэтому токен постоянный, а безопасность держат три вещи: он только
// на чтение, человек отзывает его сам, и в базе лежит лишь хэш.

export const READ_TOKEN_PREFIX = 'tkr_';
/** Больше пяти действующих — уже не «программа на своём компьютере», а раздача доступа. */
export const READ_TOKEN_LIMIT = 5;
const LABEL_MAX = 100;

export interface ReadTokenInfo {
  id: string;
  label: string;
  created_at: Date;
  last_used_at: Date | null;
}

function cleanLabel(raw: unknown): string {
  const label = typeof raw === 'string'
    ? raw.replace(/[\u0000-\u001f\u007f​-‏﻿]/g, '').trim()
    : '';
  if (!label) throw new AppError('validation_failed', 'A name is required — what program the token is for');
  if (label.length > LABEL_MAX) throw new AppError('validation_failed', `The name is longer than ${LABEL_MAX} characters`);
  return label;
}

/** Выпустить токен. Сырой токен возвращается ровно здесь и больше нигде — его не хранит и база. */
/** Не больше стольких выпусков за сутки (вместе с отозванными). */
export const READ_TOKEN_DAILY_LIMIT = 20;

export async function issueReadToken(userId: string, label: string): Promise<{ id: string; token: string }> {
  const name = cleanLabel(label);
  return withGlobal(async (db) => {
    // Строка человека под блокировкой: два одновременных выпуска иначе оба увидели бы четыре
    // действующих и оставили шесть.
    const user = await db.query(`select 1 from users where id = $1 and anonymized_at is null for update`, [userId]);
    if (!user.rowCount) throw new AppError('not_found', 'User not found');
    const active = (await db.query(
      `select count(*)::int as n from read_tokens where user_id = $1 and revoked_at is null`, [userId])).rows[0].n as number;
    if (active >= READ_TOKEN_LIMIT) {
      throw new AppError('limit_exceeded', `No more than ${READ_TOKEN_LIMIT} active tokens — revoke one you no longer use`, { limit: READ_TOKEN_LIMIT });
    }
    // Выпуск и отзыв по кругу растили бы таблицу без предела (ревью 08.10).
    const today = (await db.query(
      `select count(*)::int as n from read_tokens where user_id = $1 and created_at > now() - interval '24 hours'`, [userId])).rows[0].n as number;
    if (today >= READ_TOKEN_DAILY_LIMIT) {
      throw new AppError('limit_exceeded', `No more than ${READ_TOKEN_DAILY_LIMIT} tokens a day`, { limit: READ_TOKEN_DAILY_LIMIT });
    }
    const token = READ_TOKEN_PREFIX + randomToken(32);
    const r = await db.query(
      `insert into read_tokens(user_id, label, token_hash) values ($1, $2, $3) returning id`, [userId, name, sha256(token)]);
    // Человек узнаёт о выпуске в боте: подпись приложения живёт сутки, а токен — бессрочно, и
    // выпущенный чужими руками иначе остался бы незамеченным (ревью 08.10). Сообщение — в личное
    // пространство: токен принадлежит человеку, а не компании.
    const personal = await ensurePersonalOrg(db, userId);
    await db.query(`select set_config('app.org_id', $1, true)`, [personal]);
    await notify(db, { userId, kind: 'read_token_issued', level: 'glance', payload: { label: name } });
    return { id: r.rows[0].id as string, token };
  });
}

/** Действующие токены человека — без самих токенов: их показывают один раз, при выпуске. */
export async function listReadTokens(userId: string): Promise<ReadTokenInfo[]> {
  return withGlobal(async (db) => (await db.query(
    `select id, label, created_at, last_used_at from read_tokens
      where user_id = $1 and revoked_at is null order by created_at desc`, [userId])).rows as ReadTokenInfo[]);
}

/** Отозвать свой токен. Чужой и уже отозванный — «не найдено»: о чужих токенах знать незачем. */
export async function revokeReadToken(userId: string, id: string): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new AppError('not_found', 'Token not found');
  const r = await withGlobal((db) => db.query(
    `update read_tokens set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null`, [id, userId]));
  if (!r.rowCount) throw new AppError('not_found', 'Token not found');
}

/**
 * Кто стоит за токеном. `null` — неизвестный, отозванный или человек удалён (анонимизирован): всё это
 * для программы одинаково «нет доступа». Сравнение по хэшу — индексом, сырой токен в запрос не идёт.
 * Отметка «пользовались» — не чаще раза в минуту: программа ходит каждые три минуты по нескольким
 * компаниям, и запись на каждый запрос была бы лишней нагрузкой без пользы человеку.
 */
export async function verifyReadToken(raw: string | null | undefined): Promise<{ tokenId: string; userId: string } | null> {
  if (typeof raw !== 'string' || !raw.startsWith(READ_TOKEN_PREFIX) || raw.length > 200) return null;
  return withGlobal(async (db) => {
    const r = await db.query(
      `select t.id, t.user_id from read_tokens t join users u on u.id = t.user_id
        where t.token_hash = $1 and t.revoked_at is null and u.anonymized_at is null`, [sha256(raw)]);
    const row = r.rows[0] as { id: string; user_id: string } | undefined;
    if (!row) return null;
    await db.query(
      `update read_tokens set last_used_at = now()
        where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`, [row.id]);
    return { tokenId: row.id, userId: row.user_id };
  });
}
