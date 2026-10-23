import { withOrg } from '../db/pool.js';
import { decrypt } from '../core/crypto.js';
import { notify } from '../core/notify.js';
import { ZERO_CURSOR } from '../core/events.js';
import { isWorkingTime, windowSchedule, workingMinutesBetween } from '../core/calendar.js';
import { logger } from '../log.js';
import { drainAgentEvents } from './drain-events.js';

// Адаптер `/fire` — единственное место знания о формате (спека agent-runtime, «Edge cases»).

const FIRE_MINUTES_GAP = 15;                     // склейка: не чаще одного /fire в 15 минут
// Поводы разбудить рутину раньше расписания (спека agent-runtime). Сданная работа — такой же повод,
// как вопрос: человек закончил и ждёт приёмки, а узнать об этом через час — значит держать его в
// подвешенном состоянии ровно тогда, когда он свободен для следующего дела.
const BLOCKING_EVENT_TYPES = ['question', 'unclear', 'declined', 'person_idle', 'task_submitted'] as const;
type BlockingEventType = (typeof BLOCKING_EVENT_TYPES)[number];

type FetchFn = typeof fetch;
let fetchImpl: FetchFn = globalThis.fetch;

/** Подмена сети в тестах — единственный способ подать /fire без реального HTTP. */
export function setFetchForTests(fn: FetchFn): void {
  fetchImpl = fn;
}
export function resetFetch(): void {
  fetchImpl = globalThis.fetch;
}

export type FireResult = 'fired' | 'broken' | 'no_runner' | 'error';

/** POST на runners.fire_url с заголовками research-preview API. */
export async function fireRunner(orgId: string, text: string, now: Date = new Date()): Promise<FireResult> {
  const runner = await withOrg(orgId, (db) => db.query(
    `select fire_url, fire_token_enc from runners where org_id = $1`, [orgId],
  )).then((r) => r.rows[0] as { fire_url: string; fire_token_enc: string } | undefined);
  if (!runner) return 'no_runner';

  let status: number | null = null;
  try {
    const res = await fetchImpl(runner.fire_url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${decrypt(runner.fire_token_enc, orgId)}`,
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ text }),
    });
    status = res.status;
  } catch (e) {
    logger.error({ err: e, orgId }, 'fire: сеть недоступна');
  }

  if (status === 401 || status === 403) {
    await withOrg(orgId, async (db) => {
      await db.query(`update runners set status = 'broken', last_fire_error = $2, updated_at = $3 where org_id = $1`, [orgId, `HTTP ${status}`, now]);
      const owner = (await db.query(`select owner_user_id from orgs where id = current_setting('app.org_id')::uuid`)).rows[0].owner_user_id;
      // Исполнитель один на организацию и работает за всех её агентов — их и называем (спека bot-messages).
      const agentIds = (await db.query(`select id from agents where org_id = current_setting('app.org_id')::uuid order by name`)).rows.map((r) => r.id as string);
      await notify(db, { userId: owner, kind: 'runner_broken', level: 'decision', payload: { agent_ids: agentIds }, dedupeKey: `runner_broken:${orgId}` });
    });
    return 'broken';
  }

  await withOrg(orgId, (db) => db.query(
    `update runners set last_fired_at = $2, updated_at = $2, last_fire_error = $3 where org_id = $1`,
    [orgId, now, status === null ? 'network unavailable' : null],
  ));
  return status === null ? 'error' : 'fired';
}

function cursorGreater(a: { xid: bigint; id: bigint }, b: { xid: bigint; id: bigint }): boolean {
  return a.xid > b.xid || (a.xid === b.xid && a.id > b.id);
}

function toBig(cursor: string): { xid: bigint; id: bigint } {
  const [xid, id] = cursor.split(':');
  return { xid: BigInt(xid ?? '0'), id: BigInt(id ?? '0') };
}

/** Решение «звать ли /fire сейчас» — процедурное, без содержательных решений (спека, «Не-цели»). */
export async function maybeFire(orgId: string, now: Date = new Date()): Promise<FireResult | 'skipped'> {
  const plan = await withOrg(orgId, async (db) => {
    const runner = (await db.query(`select status, last_fired_at, last_briefing_at from runners where org_id = $1`, [orgId])).rows[0];
    if (!runner || runner.status === 'broken') return null;

    const org = (await db.query(`select agent_window from orgs where id = current_setting('app.org_id')::uuid`)).rows[0];
    const schedule = windowSchedule(org.agent_window);
    if (!isWorkingTime(schedule, now)) return null;

    if (runner.last_fired_at) {
      const sinceLastFire = now.getTime() - new Date(runner.last_fired_at).getTime();
      if (sinceLastFire < FIRE_MINUTES_GAP * 60000) return null;
    }

    const threshold = [runner.last_fired_at, runner.last_briefing_at]
      .filter((d): d is string => !!d)
      .map((d) => new Date(d).getTime())
      .reduce((max, t) => Math.max(max, t), 0);

    const agents = (await db.query(`select id from agents where org_id = current_setting('app.org_id')::uuid`)).rows as { id: string }[];
    // Счётчики заводятся из самого списка поводов: добавленный повод иначе молча остался бы без
    // счётчика и не разбудил бы рутину.
    const counts = Object.fromEntries(BLOCKING_EVENT_TYPES.map((t) => [t, 0])) as Record<BlockingEventType, number>;
    for (const a of agents) {
      const cursorRow = (await db.query(`select cursor from agent_cursors where org_id = current_setting('app.org_id')::uuid and agent_id = $1`, [a.id])).rows[0];
      const { events } = await drainAgentEvents(db, cursorRow?.cursor ?? ZERO_CURSOR, a.id);
      for (const e of events) {
        if ((BLOCKING_EVENT_TYPES as readonly string[]).includes(e.type) && new Date(e.at).getTime() > threshold) {
          counts[e.type as BlockingEventType]++;
        }
      }
    }
    const total = Object.values(counts).reduce((s, v) => s + v, 0);
    if (total === 0) return null;
    return counts;
  });
  if (!plan) return 'skipped';
  return fireRunner(orgId, summarize(plan), now);
}

const LABELS: Record<BlockingEventType, [string, string]> = {
  question: ['question', 'questions'],
  unclear: ['unclear', 'unclear'],
  declined: ['declined', 'declined'],
  person_idle: ['idle person', 'idle people'],
  task_submitted: ['submitted result', 'submitted results'],
};

/** Короткое описание без содержимого задач (спека: «2 вопроса, 1 простой»). */
function summarize(counts: Record<BlockingEventType, number>): string {
  const parts: string[] = [];
  for (const type of BLOCKING_EVENT_TYPES) {
    const n = counts[type];
    if (n > 0) parts.push(`${n} ${LABELS[type][n === 1 ? 0 : 1]}`);
  }
  return parts.join(', ');
}

/** Событие автоначала (спека auto-start): само начало и взятие, которое оно сделало. */
function isAutoStartEvent(e: { type: string; data: unknown }): boolean {
  if (e.type === 'task_auto_started') return true;
  return e.type === 'task_taken' && typeof (e.data as { auto?: unknown } | null)?.auto === 'string';
}

/** Деградация: routine молчит 2 рабочих часа окна при ожидающих событиях → «Взгляд» владельцу. */
export async function checkSilence(orgId: string, now: Date = new Date()): Promise<void> {
  await withOrg(orgId, async (db) => {
    const runner = (await db.query(`select last_briefing_at from runners where org_id = $1`, [orgId])).rows[0];
    if (!runner) return;
    const org = (await db.query(`select agent_window, owner_user_id from orgs where id = current_setting('app.org_id')::uuid`)).rows[0];
    const schedule = windowSchedule(org.agent_window);
    const agents = (await db.query(`select id from agents where org_id = current_setting('app.org_id')::uuid`)).rows as { id: string }[];
    let waiting = 0;
    // Чьих событий ждут — те агенты и названы в уведомлении (спека bot-messages: без «?»).
    const silent: string[] = [];
    for (const a of agents) {
      const cursorRow = (await db.query(`select cursor from agent_cursors where org_id = current_setting('app.org_id')::uuid and agent_id = $1`, [a.id])).rows[0];
      const { events } = await drainAgentEvents(db, cursorRow?.cursor ?? ZERO_CURSOR, a.id);
      // Реплика рутину не будит (спека task-comments), значит накопившиеся реплики — не признак
      // сломанного раннера: «Взгляд» владельцу от них слать не за что. То же — взятие, которое
      // реплика или фото сделали сами (спека auto-start): это всё ещё «одна реплика».
      const pending = events.filter((e) => e.type !== 'comment' && !isAutoStartEvent(e)).length;
      waiting += pending;
      if (pending) silent.push(a.id);
    }
    if (!waiting || !runner.last_briefing_at) return;
    const idleHours = workingMinutesBetween(schedule, new Date(runner.last_briefing_at), now) / 60;
    if (idleHours >= 2) {
      const day = now.toISOString().slice(0, 10);
      await notify(db, { userId: org.owner_user_id, kind: 'agents_silent', level: 'glance', payload: { agent_ids: silent }, dedupeKey: `agents_silent:${day}` });
    }
  });
}

export { cursorGreater, toBig };
