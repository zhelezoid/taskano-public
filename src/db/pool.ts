import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../log.js';

// Два пула: app (RLS действует) и system (BYPASSRLS — только чтобы перечислить организации
// в фоновых задачах; содержимое затем читается через withOrg). Спека core-data-model.
// Тип date (OID 1082) — строкой 'YYYY-MM-DD': иначе драйвер сдвигает дату в часовой пояс процесса.
pg.types.setTypeParser(1082, (v: string) => v);

let appPool: pg.Pool | undefined;
let systemPool: pg.Pool | undefined;

export function getAppPool(): pg.Pool {
  // Ожидание соединения ограничено: пул на десять, и без таймаута запросы копились бы молча —
  // человек видел бы вечную крутилку вместо честной ошибки.
  appPool ??= new pg.Pool({ connectionString: env.databaseAppUrl, max: 10, connectionTimeoutMillis: 10_000 });
  return appPool;
}
export function getSystemPool(): pg.Pool {
  systemPool ??= new pg.Pool({ connectionString: env.databaseSystemUrl, max: 4, connectionTimeoutMillis: 10_000 });
  return systemPool;
}

export async function closePools(): Promise<void> {
  await Promise.all([appPool?.end(), systemPool?.end()]);
  appPool = undefined;
  systemPool = undefined;
}

export type Db = pg.PoolClient;

const UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * Действующее лицо сессии (спека projects): по нему видны дела закрытых проектов их хозяину.
 * Пусто — значит человека в сессии нет, и закрытое не видно: отказ в безопасную сторону.
 * Агенту подставлять человека нельзя никогда — иначе агент увидит закрытые проекты владельца.
 */
export async function setActor(db: Db, userId: string | null): Promise<void> {
  if (userId !== null && !UUID_RE.test(userId)) throw new Error(`setActor: некорректный user_id ${userId}`);
  await db.query(`select set_config('app.actor_user_id', $1, true)`, [userId ?? '']);
}

/** Глобальный слой (identity): транзакция без org-контекста. RLS-таблицы здесь вернут 0 строк. */
export async function withGlobal<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('app.org_id', '', true), set_config('app.actor_user_id', '', true), set_config('app.background', '', true)`);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Действия «после коммита» открытых транзакций организации: ключ → действие. Ключ схлопывает повторы
// внутри одной транзакции (дело и три реплики подряд — одна постановка перевода).
const afterCommitHooks = new WeakMap<Db, Map<string, () => Promise<void>>>();

/**
 * Выполнить `fn` после коммита транзакции `withOrg`, в которой идёт `db`. Откат — действие
 * отбрасывается: фоновая задача не должна ссылаться на дело, которого нет. Ошибка действия
 * логируется и наружу не выходит: запись уже зафиксирована, и отвечать отказом за неё поздно.
 * Вне `withOrg` (свой клиент без транзакции организации) ждать нечего — выполняется сразу.
 */
export async function afterCommit(db: Db, key: string, fn: () => Promise<void>): Promise<void> {
  const hooks = afterCommitHooks.get(db);
  if (hooks) { hooks.set(key, fn); return; }
  await runHook(key, fn);
}

async function runHook(key: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    logger.warn({ err: e, hook: key }, 'withOrg: действие после коммита не удалось');
  }
}

/** Слой организации: единственный путь к таблицам с RLS. SET LOCAL живёт до конца транзакции,
 *  поэтому переиспользованное соединение пула не унесёт чужой org_id. `actorUserId` — человек,
 *  от имени которого идёт работа (Mini App, бот, коннектор); без него закрытые дела не видны. */
export async function withOrg<T>(
  orgId: string, fn: (db: Db) => Promise<T>, opts: { actorUserId?: string | null; background?: boolean } = {},
): Promise<T> {
  if (!UUID_RE.test(orgId)) throw new Error(`withOrg: некорректный org_id ${orgId}`);
  const actorUserId = opts.actorUserId ?? null;
  if (actorUserId !== null && !UUID_RE.test(actorUserId)) throw new Error(`withOrg: некорректный actor_user_id ${actorUserId}`);
  const client = await getAppPool().connect();
  const hooks = new Map<string, () => Promise<void>>();
  afterCommitHooks.set(client, hooks);
  let result: T;
  try {
    await client.query('begin');
    await client.query(
      `select set_config('app.org_id', $1, true), set_config('app.actor_user_id', $2, true), set_config('app.background', $3, true)`,
      [orgId, actorUserId ?? '', opts.background ? '1' : '']);
    result = await fn(client);
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    afterCommitHooks.delete(client);
    client.release();
  }
  // Соединение уже отдано в пул: действия после коммита (постановка в очередь) его не держат.
  for (const [key, fn] of hooks) await runHook(key, fn);
  return result;
}

/**
 * Фоновое задание по одной организации: таймеры, выпуск по сроку, очередь, дайджест, уборка.
 *
 * Видит и закрытые проекты — иначе дело в закрытом проекте молча выпадало бы из всей автоматики
 * (миграция 009). Граница организаций при этом на месте: снимается ровно приватность, и только
 * здесь. **Звать можно только из фоновых заданий** — ни из запроса человека, ни из инструмента
 * агента: там действующее лицо известно и называется явно через `actorUserId`.
 */
export function withOrgBackground<T>(orgId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  return withOrg(orgId, fn, { background: true });
}

/**
 * Снять приватность на время одной операции внутри уже открытой транзакции — и вернуть обратно.
 * Нужно там, где действующее лицо есть, но работать надо и с чужим закрытым: вывод человека из
 * организации должен убрать за собой его закрытые проекты, которых админ не видит. Граница
 * организаций не трогается. Звать можно только из фоновых заданий и вывода человека.
 */
export async function withPrivacyLifted<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('app.background', '1', true)`);
  try {
    return await fn();
  } finally {
    // Транзакция могла уже уйти в aborted — тогда этот запрос упал бы своей ошибкой и подменил
    // настоящую причину. Приватность от этого не страдает: SET LOCAL живёт до конца транзакции.
    await db.query(`select set_config('app.background', '', true)`).catch(() => {});
  }
}

/** Только перечисление по всем организациям (планировщик). Не читать здесь содержимое задач. */
export async function withSystem<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await getSystemPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
