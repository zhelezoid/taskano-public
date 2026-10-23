import { assertProductionEnv, env } from './config/env.js';
import { logger } from './log.js';

// Одна кодовая база, две роли: TASKANO_ROLE=web | worker (спека pilot-deploy).
async function main(): Promise<void> {
  assertProductionEnv();
  const role = process.env.TASKANO_ROLE ?? 'web';
  if (role === 'web') {
    const { startWeb } = await import('./web/start.js');
    await startWeb();
  } else if (role === 'worker') {
    const { startWorker } = await import('./worker/start.js');
    await startWorker();
  } else {
    throw new Error(`Неизвестная роль TASKANO_ROLE=${role}`);
  }
  logger.info({ role, port: env.port }, 'taskano started');
}

// Необработанный отказ промиса Node 22 считает смертельным и гасит процесс молча — в логе пусто,
// а web несёт и Mini App, и `/mcp`, и вебхук бота. Записываем причину перед выходом: без неё
// падение видно только по рестарту контейнера, а по чему именно упало — неизвестно.
process.on('unhandledRejection', (e) => { logger.fatal({ err: e }, 'unhandled rejection'); process.exit(1); });

main().catch((e) => { logger.fatal({ err: e }, 'startup failed'); process.exit(1); });
