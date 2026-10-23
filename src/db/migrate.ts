import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { env } from '../config/env.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

function credentials(url: string): { user: string; password: string } {
  const u = new URL(url);
  return { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
}

/** Применяет SQL-миграции под владельцем схемы и заводит роли app/system с правами. */
export async function migrate(ownerUrl = env.databaseUrl): Promise<string[]> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock(727001)');
    await client.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
    const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name as string));
    // Сами роли заводим до миграций: миграции выдают им права на свои объекты (`grant execute on
    // function ... to taskano_app`), и на чистом кластере такая миграция падала бы на
    // несуществующей роли — то есть продукт не разворачивался бы с нуля. Права на таблицы и
    // отзывы — после: тех таблиц ещё нет.
    await createRoles(client);
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations(name) values ($1)', [file]);
        await client.query('commit');
        applied.push(file);
      } catch (e) {
        await client.query('rollback');
        throw new Error(`Миграция ${file} не применилась: ${(e as Error).message}`);
      }
    }
    await ensureRoles(client);
    await assertSlotFunctionsSeeEverything(client);
  } finally {
    await client.query('select pg_advisory_unlock(727001)').catch(() => {});
    await client.end();
  }
  return applied;
}

/**
 * Слот «Сейчас» и суточные лимиты считаются функциями `security definer` (миграции 017/018): они
 * смотрят дела человека во всех его компаниях поверх RLS. Но на `tasks` и `notifications` включён
 * `force row level security` — политики применяются и к владельцу таблиц. Значит работает это лишь
 * пока владелец функций обходит RLS; иначе функции молча вернут только текущую организацию, и
 * человек снова получит по делу «Сейчас» от каждой компании — без единой ошибки в логах.
 *
 * Молчаливую поломку меняем на громкую: развёртывание падает здесь, а не через неделю у человека.
 */
async function assertSlotFunctionsSeeEverything(client: pg.Client): Promise<void> {
  const r = await client.query(
    `select r.rolname, r.rolsuper or r.rolbypassrls as bypasses
       from pg_proc p join pg_roles r on r.oid = p.proowner
      where p.proname = 'person_slot_holders'`,
  );
  const row = r.rows[0] as { rolname: string; bypasses: boolean } | undefined;
  if (!row) throw new Error('Функция person_slot_holders не найдена — миграция 017 не применилась');
  if (!row.bypasses) {
    throw new Error(
      `Владелец функций слота (${row.rolname}) не обходит RLS: слот «Сейчас» и суточные лимиты `
      + 'посчитаются только по текущей компании. Нужно `alter role ... bypassrls` либо переназначить '
      + 'владельца функций 017/018 на роль с этим правом.',
    );
  }
}

/** Сами роли и доступ к схеме — всё, что нужно миграциям, чтобы выдавать им права на свои объекты. */
async function createRoles(client: pg.Client): Promise<void> {
  const db = (await client.query('select current_database() as d')).rows[0].d as string;
  for (const [role, opts] of [[credentials(env.databaseAppUrl), 'NOBYPASSRLS'], [credentials(env.databaseSystemUrl), 'BYPASSRLS']] as const) {
    const exists = (await client.query('select 1 from pg_roles where rolname = $1', [role.user])).rowCount;
    const ident = client.escapeIdentifier(role.user);
    const pass = client.escapeLiteral(role.password);
    await client.query(`${exists ? 'alter' : 'create'} role ${ident} login ${opts} nosuperuser password ${pass}`);
    await client.query(`grant connect on database ${client.escapeIdentifier(db)} to ${ident}`);
    await client.query(`grant usage on schema public to ${ident}`);
  }
}

async function ensureRoles(client: pg.Client): Promise<void> {
  const app = credentials(env.databaseAppUrl);
  const system = credentials(env.databaseSystemUrl);
  const db = (await client.query('select current_database() as d')).rows[0].d as string;
  await createRoles(client);
  for (const [role] of [[app], [system]] as const) {
    const ident = client.escapeIdentifier(role.user);
    await client.query(`grant select, insert, update, delete on all tables in schema public to ${ident}`);
    await client.query(`grant usage, select on all sequences in schema public to ${ident}`);
    // Горизонт видимости событий (pg_snapshot_xmin) общий на весь кластер: зависшая транзакция
    // задерживает ленту событий всем. Поэтому зависания обрываются (core-data-model, edge cases).
    await client.query(`alter role ${ident} set idle_in_transaction_session_timeout = '60s'`);
    await client.query(`alter role ${ident} set statement_timeout = '60s'`);
  }
  // Приложению не нужно трогать журнал миграций и переписывать аудит (аудит безопасности, п.5).
  const appIdent = client.escapeIdentifier(app.user);
  await client.query(`revoke all on schema_migrations from ${appIdent}`);
  await client.query(`revoke update, delete on admin_audit, agent_audit from ${appIdent}`);
  // Объявление не правят и не отзывают, получателя не вычёркивают (спека announcements, миграция 032):
  // выданное выше «всё на все таблицы» перекрыло бы узкие права миграции, поэтому отзываем здесь.
  await client.query(`revoke update, delete on announcements from ${appIdent}`);
  await client.query(`revoke update, delete on announcement_recipients from ${appIdent}`);
  await client.query(`grant update (confirmed_at, confirmed_via, reminded_count, last_reminded_at) on announcement_recipients to ${appIdent}`);
  // Тревогу закрывают, а не удаляют; получателя тревоги не вычёркивают (спека announcement-alerts).
  await client.query(`revoke delete on announcement_alerts, announcement_alert_recipients from ${appIdent}`);
  // Токен агента отзывают отметкой, а не удаляют: удаление обнулило бы agent_audit.agent_token_id, и
  // пропал бы след того, что сделано утёкшим токеном (спека agent-tokens, ревью безопасности 22.10).
  await client.query(`revoke delete on agent_tokens from ${appIdent}`);
  // graphile-worker ставит свою схему сам под system-ролью.
  await client.query(`grant create on database ${client.escapeIdentifier(db)} to ${client.escapeIdentifier(system.user)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().then((a) => { console.log(`Применено миграций: ${a.length}`, a); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
