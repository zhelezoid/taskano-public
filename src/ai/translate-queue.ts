import { makeWorkerUtils, type WorkerUtils } from 'graphile-worker';
import { env } from '../config/env.js';
import { afterCommit, type Db } from '../db/pool.js';

// Постановка фонового перевода дела (спека translation-prefetch): одна задача graphile-worker на дело
// (jobKey), правки подряд схлопываются (jobKeyMode 'replace') в один перевод. Очередь `translate` —
// строго по одной задаче: иначе пачка переводов заняла бы все места воркера, и таймеры с доставкой
// уведомлений ждали бы её. Отстал фон — не беда: карточка при открытии догревает недостающее сама. Ставится строго после
// коммита записи — задача не должна ссылаться на дело, которого откат убрал. Тесты подменяют
// планировщик записью в массив и зовут саму задачу напрямую (как в groups/schedule.ts).

export interface TranslateTaskPayload { orgId: string; taskId: string }
export type ScheduleTranslateTask = (payload: TranslateTaskPayload) => Promise<void>;

let utils: Promise<WorkerUtils> | undefined;
let override: ScheduleTranslateTask | undefined;

async function workerUtils(): Promise<WorkerUtils> {
  utils ??= (async () => {
    const u = await makeWorkerUtils({ connectionString: env.databaseSystemUrl });
    // Web может записать дело раньше, чем worker впервые поднял свою схему.
    await u.migrate();
    return u;
  })();
  // Сбой подключения (база перезапускается при выкатке) не должен выключить перевод до рестарта web:
  // отклонённое обещание не храним — следующая постановка попробует заново.
  utils.catch(() => { utils = undefined; });
  return utils;
}

const graphileSchedule: ScheduleTranslateTask = async (payload) => {
  const u = await workerUtils();
  await u.addJob('translate_task', payload, {
    jobKey: `tr:${payload.taskId}`, jobKeyMode: 'replace', maxAttempts: 2, queueName: 'translate',
  });
};

export function setTranslateSchedulerForTests(fn: ScheduleTranslateTask | undefined): void {
  override = fn;
}

/** Закрыть соединение планировщика (тест, который ставит задачу в настоящий graphile-worker). */
export async function releaseTranslateScheduler(): Promise<void> {
  const u = await utils;
  utils = undefined;
  await u?.release();
}

/**
 * Поставить перевод дела `taskId` в очередь после коммита текущей транзакции. Звать после записи
 * дела или реплики; сам перевод в транзакции записи не идёт и её не задерживает.
 */
export async function enqueueTaskTranslation(db: Db, taskId: string): Promise<void> {
  const orgId = (await db.query(`select current_setting('app.org_id') as org_id`)).rows[0].org_id as string;
  await afterCommit(db, `translate:${taskId}`, () => (override ?? graphileSchedule)({ orgId, taskId }));
}
