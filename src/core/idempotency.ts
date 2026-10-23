import { createHash } from 'node:crypto';
import type { Db } from '../db/pool.js';
import { AppError } from './errors.js';

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

export function requestHash(request: unknown): string {
  return createHash('sha256').update(stableStringify(request)).digest('hex');
}

/**
 * Тот же ключ + то же тело → сохранённый ответ; тот же ключ + другое тело → idempotency_conflict.
 * Вставка ключа идёт в той же транзакции, что и создание: параллельный дубль ждёт на
 * первичном ключе и после коммита первого получает конфликт вставки → читает готовый ответ.
 */
export async function withIdempotency<T>(
  db: Db,
  actor: string,
  key: string,
  request: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const hash = requestHash(request);
  const existing = await db.query(
    'select request_hash, response from idempotency_keys where actor = $1 and key = $2',
    [actor, key],
  );
  if (existing.rowCount) {
    const row = existing.rows[0];
    if (row.request_hash !== hash) {
      throw new AppError('idempotency_conflict', 'This idempotency_key was already used with different arguments', row.response);
    }
    return row.response as T;
  }
  await db.query('savepoint idem');
  const ins = await db.query(
    `insert into idempotency_keys(org_id, actor, key, request_hash, response)
     values (current_setting('app.org_id')::uuid, $1, $2, $3, 'null'::jsonb)
     on conflict do nothing`,
    [actor, key, hash],
  );
  if (!ins.rowCount) {
    await db.query('rollback to savepoint idem');
    return withIdempotency(db, actor, key, request, fn);
  }
  const result = await fn();
  await db.query('update idempotency_keys set response = $3 where actor = $1 and key = $2', [actor, key, JSON.stringify(result ?? null)]);
  return result;
}
