import pg from 'pg';

// Отдельная база taskano_test пересоздаётся на каждый прогон: тесты не зависят от dev-данных.
const ADMIN = 'postgres://taskano_owner:dev@127.0.0.1:55432/taskano';
// Своя база на каждого параллельного исполнителя: TASKANO_TEST_DB=taskano_test_<имя>.
export const TEST_DB = process.env.TASKANO_TEST_DB ?? 'taskano_test';

export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${TEST_DB}' and pid <> pg_backend_pid()`);
  await admin.query(`drop database if exists ${TEST_DB}`);
  await admin.query(`create database ${TEST_DB}`);
  await admin.end();
  process.env.DATABASE_URL = `postgres://taskano_owner:dev@127.0.0.1:55432/${TEST_DB}`;
  process.env.DATABASE_APP_URL = `postgres://taskano_app:dev_app@127.0.0.1:55432/${TEST_DB}`;
  process.env.DATABASE_SYSTEM_URL = `postgres://taskano_system:dev_system@127.0.0.1:55432/${TEST_DB}`;
  const { migrate } = await import('../src/db/migrate.js');
  await migrate(process.env.DATABASE_URL);
}
