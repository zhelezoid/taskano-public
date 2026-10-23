import { run } from 'graphile-worker';
import { env } from '../config/env.js';
import { logger } from '../log.js';
import { runTick } from './tick.js';
import { runCleanup } from './cleanup.js';
import { runGroupAnalyzeJob } from './group-analyze.js';
import { runTranslateJob } from './translate.js';
import type { GroupAnalyzePayload } from '../groups/schedule.js';

// Роль `worker` (спека pilot-deploy): graphile-worker на DATABASE_SYSTEM_URL. Логика самих задач —
// чистые функции (`runTick`, `runCleanup`, `analyzeGroup`), тесты вызывают их напрямую с параметром
// `now`, минуя graphile-worker целиком.

export async function startWorker(): Promise<void> {
  const runner = await run({
    connectionString: env.databaseSystemUrl,
    // Три очереди: `main` (tick, cleanup — строго по одному), `groups` (разбор групп, сеть + модель —
    // секунды) и `translate` (перевод дел заранее — тоже модель). Разбор и перевод не должны
    // задерживать доставку уведомлений и таймеры всех организаций.
    concurrency: 3,
    noHandleSignals: false,
    crontab: '* * * * * tick ?queue=main\n0 3 * * * cleanup ?queue=main',
    taskList: {
      tick: async () => { await runTick(new Date()); },
      cleanup: async () => { await runCleanup(new Date()); },
      // Разбор рабочей группы (спека group-intake): ставит webhook с jobKey на группу.
      group_analyze: async (payload) => { await runGroupAnalyzeJob(payload as GroupAnalyzePayload, new Date()); },
      // Перевод дела на языки участников заранее (спека translation-prefetch): очередь `translate`.
      translate_task: async (payload) => { await runTranslateJob(payload); },
    },
  });
  logger.info('worker: graphile-worker запущен (tick — ежеминутно, cleanup — 03:00 UTC, group_analyze — по сообщениям групп)');
  await runner.promise;
}
