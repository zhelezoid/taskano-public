import { makeWorkerUtils, type WorkerUtils } from 'graphile-worker';
import { env } from '../config/env.js';

// Постановка фонового разбора группы (спека group-intake, «Разбор»): одна задача graphile-worker на
// группу (jobKey), каждое новое сообщение сдвигает запуск на 90 с (jobKeyMode 'replace') — альбом и
// соседние реплики собираются в одну пачку. Тесты подменяют планировщик и зовут разбор напрямую.

export const GROUP_ANALYZE_DELAY_MS = 90_000;

export interface GroupAnalyzePayload { orgId: string; groupId: string }
export type ScheduleGroupAnalyze = (payload: GroupAnalyzePayload, runAt: Date) => Promise<void>;

let utils: Promise<WorkerUtils> | undefined;
let override: ScheduleGroupAnalyze | undefined;

async function workerUtils(): Promise<WorkerUtils> {
  utils ??= (async () => {
    const u = await makeWorkerUtils({ connectionString: env.databaseSystemUrl });
    // Web может получить сообщение раньше, чем worker впервые поднял свою схему.
    await u.migrate();
    return u;
  })();
  return utils;
}

const graphileSchedule: ScheduleGroupAnalyze = async (payload, runAt) => {
  const u = await workerUtils();
  await u.addJob('group_analyze', payload, { jobKey: `group:${payload.groupId}`, jobKeyMode: 'replace', runAt, maxAttempts: 3, queueName: 'groups' });
};

export function setGroupAnalyzeSchedulerForTests(fn: ScheduleGroupAnalyze | undefined): void {
  override = fn;
}

export async function scheduleGroupAnalyze(payload: GroupAnalyzePayload, runAt: Date): Promise<void> {
  await (override ?? graphileSchedule)(payload, runAt);
}
