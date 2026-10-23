import { withSystem, type Db } from '../db/pool.js';
import { untrusted } from '../mcp/context.js';

// Блок `owner_activity` в get_briefing (спека owner-feedback): что человек сделал сам
// с прошлого ack_briefing — закрыл, отменил, поставил, решил. Агент видит в сводке только свои
// задачи, поэтому без этого блока он ставит шаг на уже сделанное.
//
// Изоляция. Личные дела лежат в отдельной организации (`kind = 'personal'`), сводка читается под
// withOrg(<компания>) — RLS их не отдаст. Политику RLS на tasks мы НЕ расширяем: «видно, если
// org_id = текущая» — единственное правило для всех запросов приложения, и любое его послабление
// открыло бы личное не только этой выборке, но и правкам, джойнам, боту и Mini App. Вместо этого —
// одна узкая выборка под withSystem строго с фильтром `shared_org_id = <эта организация>`
// (только чтение, только помеченные дела). Непомеченное личное не видит никто.
//
// Дела закрытых проектов (спека projects) сюда не попадают: блок читает агент, а закрытый проект
// для агента не существует. Сводка идёт под человеком (у `get_briefing` нет аргумента `agent`),
// и RLS её выборки не отсечёт — поэтому `private_owner_user_id is null` стоит в самих запросах.

/** Запас назад при подтверждении окна (как REVIEW_OVERLAP_MS в блоке групп). */
export const OWNER_ACTIVITY_OVERLAP_MS = 5 * 60000;

const CLOSED_LIMIT = 50;
const CREATED_LIMIT = 50;
const DECISION_LIMIT = 30;

const DONE_STATUSES = ['done', 'resolved'];
const CANCELLED_STATUSES = ['cancelled'];
/** Что показываем в блоке: сделано и отменено. */
const REPORTED_STATUSES = [...DONE_STATUSES, ...CANCELLED_STATUSES];
/** Закрытые в любом смысле: поставленное и закрытое в одном окне идёт одной строкой — в `done`. */
const CLOSED_STATUSES = [...REPORTED_STATUSES, 'declined'];

// Кто закрыл задачу: последнее закрывающее событие по ней (имена — EVENT_TYPE в core/lifecycle.ts).
const CLOSE_EVENTS = ['task_accepted', 'auto_accepted', 'cancelled', 'waiting_resolved', 'declined'];

// «Решение: …» в языках продукта (ru/tr/vi/en) — так человек фиксирует решение в комментарии.
// Плюс `owner_instruction` — указание владельца при разборе предложения агента.
export const DECISION_PREFIX = '^\\s*(решени[ея]|karar|quyết định|decision)\\s*[:—–-]';

type Untrusted = ReturnType<typeof untrusted>;
type Where = 'company' | 'personal';

export interface OwnerActivityBlock {
  since: string | null;
  done: ClosedItem[];
  cancelled: ClosedItem[];
  created: CreatedItem[];
  decisions: { task: string; text: Untrusted; at: string }[];
}

interface ClosedItem { task: string; title: Untrusted; where: Where; at: string; by: string }
interface CreatedItem { task: string; title: Untrusted; assignee: string; where: Where; at: string }

const iso = (d: Date | string) => new Date(d).toISOString();

interface RawTask { id: string; title: string; status: string; at: Date; assignee_user_id: string; by_user_id: string | null }

/** Задачи компании, поставленные человеком (`author_agent_id is null`), закрытые в окне. */
async function companyClosed(db: Db, window: [Date | null, Date]): Promise<RawTask[]> {
  const r = await db.query(
    `select t.id, t.title, t.status, t.status_changed_at as at, t.assignee_user_id,
            (select e.actor_user_id from events e
              where e.task_id = t.id and e.actor_user_id is not null and e.type = any($3)
              order by e.id desc limit 1) as by_user_id
       from tasks t
      where t.author_agent_id is null and t.status = any($4) and t.private_owner_user_id is null
        and t.status_changed_at > coalesce($1::timestamptz, '-infinity'::timestamptz) and t.status_changed_at <= $2
      order by t.status_changed_at desc limit ${CLOSED_LIMIT}`,
    [...window, CLOSE_EVENTS, REPORTED_STATUSES]);
  return r.rows;
}

/** Помеченные «рабочее» личные дела этой организации, закрытые в окне. Только чтение, BYPASSRLS. */
async function personalClosed(orgId: string, window: [Date | null, Date]): Promise<RawTask[]> {
  return withSystem(async (db) => {
    const r = await db.query(
      `select t.id, t.title, t.status, t.status_changed_at as at, t.assignee_user_id, o.owner_user_id as by_user_id
         from tasks t join orgs o on o.id = t.org_id and o.kind = 'personal'
        where t.shared_org_id = $1 and t.status = any($4)
          and t.status_changed_at > coalesce($2::timestamptz, '-infinity'::timestamptz) and t.status_changed_at <= $3
        order by t.status_changed_at desc limit ${CLOSED_LIMIT}`,
      [orgId, ...window, REPORTED_STATUSES]);
    return r.rows;
  });
}

async function companyCreated(db: Db, window: [Date | null, Date]): Promise<RawTask[]> {
  const r = await db.query(
    `select id, title, status, created_at as at, assignee_user_id, author_user_id as by_user_id
       from tasks
      where author_agent_id is null and not (status = any($3)) and private_owner_user_id is null
        and created_at > coalesce($1::timestamptz, '-infinity'::timestamptz) and created_at <= $2
      order by created_at desc limit ${CREATED_LIMIT}`,
    [...window, CLOSED_STATUSES]);
  return r.rows;
}

async function personalCreated(orgId: string, window: [Date | null, Date]): Promise<RawTask[]> {
  return withSystem(async (db) => {
    const r = await db.query(
      `select t.id, t.title, t.status, t.created_at as at, t.assignee_user_id, o.owner_user_id as by_user_id
         from tasks t join orgs o on o.id = t.org_id and o.kind = 'personal'
        where t.shared_org_id = $1 and not (t.status = any($4))
          and t.created_at > coalesce($2::timestamptz, '-infinity'::timestamptz) and t.created_at <= $3
        order by t.created_at desc limit ${CREATED_LIMIT}`,
      [orgId, ...window, CLOSED_STATUSES]);
    return r.rows;
  });
}

/** Имена людей для поля `by`: владелец организации — «owner», остальные — по имени. */
async function namesOf(db: Db, ownerUserId: string, ids: (string | null)[]): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (!list.length) return names;
  const r = await db.query('select id, display_name from users where id = any($1::uuid[])', [list]);
  for (const row of r.rows) names.set(row.id, row.id === ownerUserId ? 'owner' : (row.display_name || 'owner'));
  return names;
}

/**
 * Блок `owner_activity`: окно — с прошлого ack_briefing (тот же курсор, как у блока groups).
 * Запоминает границу окна; ack_briefing с тем же курсором её подтверждает.
 */
export async function ownerActivityBriefing(db: Db, orgId: string, ownerUserId: string, now: Date, cursor: string): Promise<OwnerActivityBlock> {
  const state = (await db.query('select acked_until from owner_activity_state')).rows[0];
  const since: Date | null = state?.acked_until ?? null;
  const window: [Date | null, Date] = [since, now];

  const closed = [
    ...(await companyClosed(db, window)).map((t) => ({ t, where: 'company' as const })),
    ...(await personalClosed(orgId, window)).map((t) => ({ t, where: 'personal' as const })),
  ];
  const created = [
    ...(await companyCreated(db, window)).map((t) => ({ t, where: 'company' as const })),
    ...(await personalCreated(orgId, window)).map((t) => ({ t, where: 'personal' as const })),
  ];

  // Решения владельца: комментарий вида «Решение: …» и указание по предложению агента. Только его:
  // иначе любой исполнитель, написав «Решение: …», подложил бы агенту в память чужое «решение».
  const decisions = await db.query(
    `select m.task_id, m.text, m.created_at from task_messages m
       join tasks t on t.id = m.task_id and t.private_owner_user_id is null
      where m.author_user_id = $4
        and (m.kind = 'owner_instruction' or (m.kind = 'comment' and m.text ~* $3))
        and m.created_at > coalesce($1::timestamptz, '-infinity'::timestamptz) and m.created_at <= $2
      order by m.created_at desc limit ${DECISION_LIMIT}`,
    [...window, DECISION_PREFIX, ownerUserId]);

  const names = await namesOf(db, ownerUserId, closed.map((c) => c.t.by_user_id));
  const closedItem = ({ t, where }: { t: RawTask; where: Where }): ClosedItem => ({
    task: t.id, title: untrusted(t.title), where, at: iso(t.at), by: (t.by_user_id && names.get(t.by_user_id)) || 'owner',
  });

  // Запас назад, как в блоке групп: транзакция может закоммититься после чтения сводки. Повтор строки
  // в следующей сводке безвреден, потеря — нет.
  await db.query(
    `insert into owner_activity_state(org_id, pending_until, pending_cursor, updated_at)
     values (current_setting('app.org_id')::uuid, $1, $2, $3)
     on conflict (org_id) do update set pending_until = excluded.pending_until, pending_cursor = excluded.pending_cursor, updated_at = excluded.updated_at`,
    [new Date(now.getTime() - OWNER_ACTIVITY_OVERLAP_MS), cursor, now]);

  return {
    since: since ? iso(since) : null,
    done: closed.filter((c) => DONE_STATUSES.includes(c.t.status)).map(closedItem),
    cancelled: closed.filter((c) => CANCELLED_STATUSES.includes(c.t.status)).map(closedItem),
    created: created.map(({ t, where }) => ({
      task: t.id, title: untrusted(t.title), assignee: t.assignee_user_id, where, at: iso(t.at),
    })),
    decisions: decisions.rows.map((r) => ({ task: r.task_id, text: untrusted(r.text), at: iso(r.created_at) })),
  };
}

/** В блоке есть о чём думать — сводку стоит запускать (`nothing_to_do: false`). */
export function ownerActivityHasContent(b: OwnerActivityBlock): boolean {
  // Своих задач агента здесь нет по построению (только поставленные людьми и личные дела),
  // поэтому дубли, которые агент и так знает, routine не будят.
  return Boolean(b.done.length || b.cancelled.length || b.created.length || b.decisions.length);
}

/** ack_briefing: сводка с этим курсором разобрана — сдвинуть окно блока (только вперёд). */
export async function ackOwnerActivity(db: Db, cursor: string): Promise<void> {
  await db.query(
    `update owner_activity_state
        set acked_until = greatest(coalesce(acked_until, '-infinity'::timestamptz), pending_until), updated_at = now()
      where pending_cursor = $1 and pending_until is not null`, [cursor]);
}
