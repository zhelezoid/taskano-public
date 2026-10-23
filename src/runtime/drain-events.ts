import type { Db } from '../db/pool.js';
import { readEvents, type EventRow } from '../core/events.js';

// `readEvents` теперь фильтрует по агенту ПОСЛЕ чтения пачки всех событий организации и двигает
// курсор до последней прочитанной строки (а не до последнего события агента) — при большом потоке
// чужих событий агент может получить пустую пачку с `hasMore: true`. Здесь читаем, пока не выберем
// всё видимое (спека agent-runtime: курсор не теряет событий).

const MAX_BATCHES = 200;

export async function drainAgentEvents(
  db: Db, startCursor: string, agentId: string, limit = 500,
): Promise<{ events: EventRow[]; cursor: string }> {
  let cursor = startCursor;
  const events: EventRow[] = [];
  for (let i = 0; i < MAX_BATCHES; i++) {
    const page = await readEvents(db, cursor, { agentId, limit });
    events.push(...page.events);
    cursor = page.cursor;
    if (!page.hasMore) break;
  }
  return { events, cursor };
}
