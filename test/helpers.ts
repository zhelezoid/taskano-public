import { randomUUID } from 'node:crypto';
import { withGlobal, withOrg, type Db } from '../src/db/pool.js';
import { addMember, createCompanyOrg, ensureUserByEmail } from '../src/core/people.js';
import type { Role } from '../src/core/access.js';
import { setTranslateSchedulerForTests } from '../src/ai/translate-queue.js';

// Окружение тестовой базы задаётся здесь: globalSetup выполняется в другом процессе.
const TEST_DB = process.env.TASKANO_TEST_DB ?? 'taskano_test';
process.env.DATABASE_URL = `postgres://taskano_owner:dev@127.0.0.1:55432/${TEST_DB}`;
process.env.DATABASE_APP_URL = `postgres://taskano_app:dev_app@127.0.0.1:55432/${TEST_DB}`;
process.env.DATABASE_SYSTEM_URL = `postgres://taskano_system:dev_system@127.0.0.1:55432/${TEST_DB}`;

// Тесты не ставят перевод дел в настоящую очередь graphile-worker: createTask и реплики зовут
// постановку после коммита. Тест, которому нужна очередь, подменяет планировщик сам.
setTranslateSchedulerForTests(async () => {});

export const uniq = () => randomUUID().slice(0, 8);

export async function makeUser(opts: { language?: string; country?: string | null; tz?: string; name?: string } = {}): Promise<string> {
  return withGlobal(async (db) => {
    const { user } = await ensureUserByEmail(db, `u-${uniq()}@test.local`, { language: opts.language ?? 'ru', country: opts.country ?? null, verified: true, name: opts.name });
    // Тестовый график: пн–пт 09–18, Europe/Istanbul, без праздников — детерминированные таймеры.
    await db.query(`update users set timezone = $2, country = $3 where id = $1`, [user.id, opts.tz ?? 'Europe/Istanbul', opts.country ?? null]);
    return user.id;
  });
}

export async function makeOrg(ownerId?: string): Promise<{ orgId: string; ownerId: string }> {
  const owner = ownerId ?? (await makeUser());
  // Тестовый календарь задаётся явно: дефолты продукта нейтральные (en/UTC), а проверки таймеров
  // и рабочих окон писались под пн–пт в Стамбуле.
  const orgId = await withGlobal((db) => createCompanyOrg(db, owner, `Org ${uniq()}`, { language: 'ru', timezone: 'Europe/Istanbul' }));
  return { orgId, ownerId: owner };
}

export async function addPerson(orgId: string, role: Role = 'member', opts: Parameters<typeof makeUser>[0] = {}): Promise<string> {
  const userId = await makeUser(opts);
  await withGlobal((db) => addMember(db, orgId, userId, role));
  return userId;
}

export async function makeAgent(orgId: string, ownerId: string, name = `agent-${uniq()}`): Promise<string> {
  return withOrg(orgId, async (db) => {
    const r = await db.query(`insert into agents(org_id, name, owner_user_id) values ($1, $2, $3) returning id`, [orgId, name, ownerId]);
    return r.rows[0].id as string;
  });
}

/** Транзакция организации. `actorUserId` — человек, которому видны его закрытые проекты (спека projects). */
export const inOrg = <T>(orgId: string, fn: (db: Db) => Promise<T>, actorUserId?: string) =>
  withOrg(orgId, fn, { actorUserId });

/** Понедельник 2026-09-21 10:00 по Стамбулу (UTC+3) = 07:00 UTC. */
export const MON_10 = new Date('2026-09-21T07:00:00Z');
export const minutes = (d: Date, m: number) => new Date(d.getTime() + m * 60000);

/**
 * Дождаться, пока горизонт видимости пройдёт уже записанные события.
 *
 * Лента событий отдаёт только транзакции старше `pg_snapshot_xmin` (спека core-data-model —
 * защита от потери событий). Горизонт общий на весь кластер, поэтому чужая открытая транзакция
 * (параллельный тестовый файл) подвешивает выдачу и тест падает плавающе. Ждём ровно того, что
 * тесту нужно как предусловие, а не того, что он проверяет. Черновик: events-horizon-holdback.
 */
export async function waitForEvents(orgId: string, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await withOrg(orgId, (db) => db.query(
      `select coalesce(max(xid) < pg_snapshot_xmin(pg_current_snapshot()), true) as visible from events`));
    if (r.rows[0].visible) return;
    if (Date.now() > until) throw new Error('горизонт видимости событий не сдвинулся за отведённое время');
    await new Promise((res) => setTimeout(res, 25));
  }
}

/** Cookie браузера из ответа «код верный»: согласие принимается только с ним (аудит 07.10). */
export function loginCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw as string[] : raw ? [String(raw)] : [];
  return list.map((c) => c.split(';')[0]!).filter((c) => c.startsWith('tk_c_')).join('; ');
}
