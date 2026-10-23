import { logger } from '../log.js';
import { analyzeGroup } from '../groups/analyze.js';
import { scheduleGroupAnalyze, type GroupAnalyzePayload } from '../groups/schedule.js';

// Обвязка задачи graphile-worker `group_analyze` (спека group-intake): одна пачка за запуск; осталось
// ещё — следующий запуск через паузу (накопленный поток не должен идти в модель подряд без остановки); модель ответила мусором впервые — повтор через паузу, второй раз
// пачка пропускается (analyze.ts).

const RETRY_DELAY_MS = 5 * 60000;
export const NEXT_BATCH_DELAY_MS = 20_000;

function isPayload(p: unknown): p is GroupAnalyzePayload {
  const o = p as Record<string, unknown> | null;
  return !!o && typeof o.orgId === 'string' && typeof o.groupId === 'string';
}

export async function runGroupAnalyzeJob(payload: unknown, now: Date): Promise<void> {
  if (!isPayload(payload)) { logger.warn({ payload }, 'group_analyze: некорректный payload'); return; }
  const r = await analyzeGroup(payload.orgId, payload.groupId, now);
  if (r.status === 'failed' && r.retry) {
    await scheduleGroupAnalyze(payload, new Date(now.getTime() + RETRY_DELAY_MS));
  } else if (r.remaining > 0 && (r.status === 'done' || r.status === 'failed')) {
    await scheduleGroupAnalyze(payload, new Date(now.getTime() + NEXT_BATCH_DELAY_MS));
  }
}
