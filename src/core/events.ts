import type { Db } from '../db/pool.js';

// Курсор — пара (xid, id). Отдаём только события транзакций старше горизонта видимости
// (xid < pg_snapshot_xmin): незакоммиченная транзакция не может «вставить» событие позади
// уже отданного курсора. Порядок по id при параллельных транзакциях не монотонен — поэтому
// сортировка по (xid, id). Спека core-data-model, «Курсор событий без потерь».

export interface EventInput {
  type: string;
  taskId?: string | null;
  planId?: string | null;
  agentId?: string | null;          // адресат-агент; по умолчанию — автор задачи-агент
  actorUserId?: string | null;
  actorAgentId?: string | null;
  data?: Record<string, unknown>;
  /**
   * Время события. По умолчанию — время базы. Передаётся там, где вызывающий уже решил, «когда»
   * это произошло (переход по делу): иначе событие о смене статуса оказывается на десятки
   * миллисекунд новее самой смены, и проверки вида «с тех пор ничего не двигалось» видят движение
   * там, где его не было.
   */
  at?: Date | null;
}

export interface EventRow {
  id: string;
  xid: string;
  at: Date;
  type: string;
  task_id: string | null;
  plan_id: string | null;
  agent_id: string | null;
  actor_user_id: string | null;
  actor_agent_id: string | null;
  data: Record<string, unknown>;
}

export const ZERO_CURSOR = '0:0';

export function encodeCursor(xid: string, id: string): string {
  return `${xid}:${id}`;
}

export function decodeCursor(cursor: string | null | undefined): { xid: string; id: string } {
  const m = /^(\d+):(\d+)$/.exec(cursor ?? ZERO_CURSOR);
  if (!m) return { xid: '0', id: '0' };
  return { xid: m[1]!, id: m[2]! };
}

export async function emit(db: Db, e: EventInput): Promise<void> {
  let agentId = e.agentId ?? null;
  let planId = e.planId ?? null;
  if (e.taskId && (agentId === null || planId === null)) {
    const t = await db.query('select author_agent_id, plan_id from tasks where id = $1', [e.taskId]);
    agentId ??= t.rows[0]?.author_agent_id ?? null;
    planId ??= t.rows[0]?.plan_id ?? null;
  }
  await db.query(
    `insert into events(org_id, agent_id, task_id, plan_id, actor_user_id, actor_agent_id, type, data, at)
     values (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6, $7, coalesce($8, now()))`,
    [agentId, e.taskId ?? null, planId, e.actorUserId ?? null, e.actorAgentId ?? null, e.type, e.data ?? {}, e.at ?? null],
  );
}

export async function readEvents(
  db: Db,
  cursor: string | null | undefined,
  opts: { agentId?: string | null; limit?: number } = {},
): Promise<{ events: EventRow[]; cursor: string; hasMore: boolean }> {
  const c = decodeCursor(cursor);
  const limit = Math.min(opts.limit ?? 200, 1000);
  // Один оператор = один снимок: читаем все видимые события организации, фильтр по агенту — после.
  // Курсор двигаем ровно до последней ПРОЧИТАННОЙ строки, а не до отдельно запрошенного «горизонта»:
  // второй запрос видел бы транзакции, закоммиченные между запросами, и курсор перепрыгнул бы их (ревью ядра).
  // Приватность держит правило на `tasks` (спека projects). Событие само по себе под ним не ходит,
  // поэтому видимость дела спрашиваем джойном: он отфильтрован тем же правилом. Курсор двигаем по
  // последней ПРОЧИТАННОЙ строке, а не по последней отданной, — иначе он застревал бы на закрытых.
  const res = await db.query(
    `select e.id::text, e.xid::text, e.at, e.type, e.task_id, e.plan_id, e.agent_id,
            e.actor_user_id, e.actor_agent_id, e.data,
            (e.task_id is null or t.id is not null) as visible
       from events e
       left join tasks t on t.id = e.task_id
      where (e.xid, e.id) > ($1::xid8, $2::bigint)
        and e.xid < pg_snapshot_xmin(pg_current_snapshot())
      order by e.xid, e.id
      limit $3`,
    [c.xid, c.id, limit],
  );
  const all = res.rows as (EventRow & { visible: boolean })[];
  const last = all.at(-1);
  const visible = all.filter((e) => e.visible).map(({ visible: _v, ...e }) => e as EventRow);
  const events = opts.agentId ? visible.filter((e) => e.agent_id === opts.agentId) : visible;
  return { events, cursor: last ? encodeCursor(last.xid, last.id) : encodeCursor(c.xid, c.id), hasMore: all.length === limit };
}

/**
 * События про проект без дела (`project_created`, `board_member_*`, `project_closed/opened`) несут в
 * `data` имя проекта, а имя закрытой доски — ровно то, что от посторонних скрывают (миграция 015).
 * Оставляем только события проектов, видимых под RLS тому, кто читает; удалённый проект не виден
 * никому. Вызывать под тем же действующим лицом, что и остальное чтение (ревью безопасности 08.10).
 */
export async function dropHiddenProjectEvents<T extends { task_id: string | null; data: Record<string, unknown> }>(
  db: Db, events: T[],
): Promise<T[]> {
  const pid = (e: T): string | null => (!e.task_id && typeof e.data?.project_id === 'string' ? e.data.project_id : null);
  const ids = [...new Set(events.map(pid).filter((x): x is string => !!x))];
  if (!ids.length) return events;
  const seen = new Set((await db.query('select id from projects where id = any($1::uuid[])', [ids])).rows.map((r) => r.id as string));
  return events.filter((e) => { const p = pid(e); return !p || seen.has(p); });
}
