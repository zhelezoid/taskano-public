import { withOrg, type Db } from '../db/pool.js';
import { AppError } from './errors.js';
import { emit } from './events.js';
import { notify } from './notify.js';
import { addWorkingMinutes, loadUserSchedule } from './calendar.js';
import { fillSlot } from './queue.js';
import { transition } from './lifecycle.js';
import { t } from '../i18n/index.js';

/** Текст предложения владельцу — на языке организации (его читает человек в боте). */
export async function proposalText(db: Db, key: string, params: Record<string, string>): Promise<string> {
  const r = await db.query(`select language from orgs where id = current_setting('app.org_id')::uuid`);
  return t((r.rows[0]?.language as string) ?? 'en', key, params);
}

// Предложения владельцу агента (уровень «только с согласия») и отменяемые изменения
// (уровень «с правом вето»). Спека step-lifecycle-and-queue.

export type ProposalType = 'goal_change' | 'preempt' | 'plan_failed' | 'step_limit' | 'money' | 'promise' | 'new_direction' | 'other'
  | 'close_task'      // агент просит закрыть задачу, поставленную человеком (спека group-intake, ревизия)
  | 'dialog_task';    // задача из переписки сверх дневного лимита организации (спека group-intake, 1b)
const NEVER_AUTO_ACCEPT: ProposalType[] = ['money', 'promise'];
// Из этих статусов lifecycle допускает «cancel» (RULES.cancel).
const CANCELLABLE = ['draft', 'scheduled', 'ready', 'active', 'in_progress', 'blocked', 'waiting_external', 'submitted', 'rework', 'waiting'];

export interface ProposalInput {
  agentId: string;
  planId?: string | null;
  taskId?: string | null;
  type: ProposalType;
  summary: string;
  payload?: Record<string, unknown>;
  rationale?: string | null;
}

async function agentOwner(db: Db, agentId: string): Promise<string> {
  const r = await db.query('select owner_user_id from agents where id = $1', [agentId]);
  if (!r.rowCount) throw new AppError('not_found', 'Agent not found');
  return r.rows[0].owner_user_id as string;
}

async function timerMinutes(db: Db, key: string, fallback: number): Promise<number> {
  const r = await db.query(`select settings->'timers'->>$1 as v from orgs where id = current_setting('app.org_id')::uuid`, [key]);
  const v = Number(r.rows[0]?.v);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export async function createProposal(db: Db, p: ProposalInput, now: Date = new Date()): Promise<{ id: string; short_id: string; expires_at: Date }> {
  const owner = await agentOwner(db, p.agentId);
  const schedule = await loadUserSchedule(db, owner);
  const expiresAt = addWorkingMinutes(schedule, now, await timerMinutes(db, 'proposal_minutes', 24 * 60));
  const r = await db.query(
    `insert into proposals(org_id, agent_id, plan_id, task_id, type, summary, payload, rationale, default_action, expires_at)
     values (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6, $7, 'reject', $8)
     returning id, short_id::text, expires_at`,
    [p.agentId, p.planId ?? null, p.taskId ?? null, p.type, p.summary, p.payload ?? {}, p.rationale ?? null, expiresAt],
  );
  const row = r.rows[0];
  await notify(db, { userId: owner, kind: 'proposal', level: 'decision', taskId: p.taskId ?? null, payload: { proposal_id: row.id } });
  await emit(db, { type: 'proposal_created', agentId: p.agentId, planId: p.planId ?? null, taskId: p.taskId ?? null, data: { proposal_id: row.id, type: p.type } });
  return row;
}

export type Decision = 'accept' | 'reject' | 'change';

export async function decideProposal(
  db: Db, proposalId: string, decision: Decision, userId: string | null, opts: { text?: string; now?: Date; expired?: boolean } = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const r = await db.query('select * from proposals where id = $1 for update', [proposalId]);
  const p = r.rows[0];
  if (!p) throw new AppError('not_found', 'Proposal not found');
  if (p.status !== 'pending') throw new AppError('conflict', 'Proposal already decided', { status: p.status });
  if (userId) {
    const owner = await agentOwner(db, p.agent_id);
    const role = await db.query(
      `select role from memberships where org_id = current_setting('app.org_id')::uuid and user_id = $1 and status = 'active'`, [userId]);
    if (owner !== userId && !['owner', 'admin'].includes(role.rows[0]?.role)) throw new AppError('forbidden', 'Only the agent owner can decide');
  }
  if (decision === 'accept' && opts.expired && NEVER_AUTO_ACCEPT.includes(p.type)) decision = 'reject';

  if (decision === 'accept') await applyProposal(db, p, userId, now);
  const status = opts.expired ? 'expired' : decision === 'accept' ? 'accepted' : decision === 'change' ? 'changed' : 'rejected';
  await db.query('update proposals set status = $2, decided_by = $3, decided_at = $4 where id = $1', [proposalId, status, userId, now]);
  if (decision === 'change' && opts.text && p.task_id) {
    await db.query(
      `insert into task_messages(org_id, task_id, author_user_id, kind, text) values (current_setting('app.org_id')::uuid, $1, $2, 'owner_instruction', $3)`,
      [p.task_id, userId, opts.text],
    );
  }
  await emit(db, {
    type: 'proposal_decided', agentId: p.agent_id, planId: p.plan_id, taskId: p.task_id, actorUserId: userId,
    data: { proposal_id: p.id, type: p.type, decision: status, ...(opts.text ? { instruction: opts.text } : {}) },
  });
}

async function applyProposal(
  db: Db, p: { type: ProposalType; agent_id: string; payload: Record<string, unknown>; plan_id: string | null; task_id: string | null },
  userId: string | null, now: Date,
): Promise<void> {
  switch (p.type) {
    case 'close_task': {
      // Владелец согласился закрыть задачу человека. Уже закрытую не трогаем.
      if (!p.task_id) break;
      const t = (await db.query('select status from tasks where id = $1', [p.task_id])).rows[0];
      if (!t || !CANCELLABLE.includes(t.status)) break;
      await transition(db, p.task_id, 'cancel', userId ? { kind: 'user', userId } : { kind: 'system' }, { now });
      break;
    }
    case 'dialog_task':
      await applyDialogTask(db, p.agent_id, p.payload, userId, now);
      break;
    case 'goal_change':
      if (p.plan_id && typeof p.payload.goal === 'string') await db.query('update plans set goal = $2 where id = $1', [p.plan_id, p.payload.goal]);
      break;
    case 'plan_failed':
      if (p.plan_id) await db.query(`update plans set status = 'failed', closed_at = $2 where id = $1`, [p.plan_id, now]);
      break;
    case 'step_limit':
      if (p.task_id) await transition(db, p.task_id, 'release', { kind: 'system' }, { now });
      break;
    case 'preempt': {
      if (!p.task_id) break;
      const t = (await db.query('select assignee_user_id, status from tasks where id = $1', [p.task_id])).rows[0];
      if (!t) break;
      await db.query(`update tasks set priority = 'urgent', updated_at = $2, version = version + 1 where id = $1`, [p.task_id, now]);
      // Держателей слота берём через функцию с правами владельца: слот один на человека поперёк
      // компаний, и дело другой компании из этой транзакции не видно — срочное дело молча не
      // активировалось бы (спека multi-company). Гасим только своё: в чужой компании — своей
      // транзакцией, иначе правка прошла бы мимо границы организаций.
      const myOrgId = (await db.query(`select current_setting('app.org_id')::uuid as id`)).rows[0].id as string;
      const holders = await db.query(
        `select id, org_id from person_slot_holders($1) where id <> $2 and status in ('active','in_progress')`,
        [t.assignee_user_id, p.task_id]);
      for (const h of holders.rows) {
        if (h.org_id === myOrgId) await transition(db, h.id, 'deactivate', { kind: 'system' }, { now, skipFill: true });
        // Человек указывается явно: иначе дело закрытого проекта не видно и его собственному
        // хозяину, и срочное дело не вытеснило бы занятый слот (та же причина, что в queue.ts).
        else await withOrg(h.org_id, (other) => transition(other, h.id, 'deactivate', { kind: 'system' }, { now, skipFill: true }), { actorUserId: t.assignee_user_id });
      }
      if (t.status === 'draft') await transition(db, p.task_id, 'release', { kind: 'system' }, { now, skipFill: true });
      await fillSlot(db, t.assignee_user_id, now);
      break;
    }
    default:
      break;                          // деньги, обещания, прочее — сервер не исполняет смысл, агент узнаёт из события
  }
}

/** Принятое предложение задачи из переписки: поставить её как есть от имени агента-автора (процедурно). */
async function applyDialogTask(db: Db, agentId: string, payload: Record<string, unknown>, userId: string | null, now: Date): Promise<void> {
  const str = (k: string) => (typeof payload[k] === 'string' ? (payload[k] as string) : '');
  const origin = str('origin');
  const assignee = str('assignee_user_id');
  if (!origin || !assignee) return;
  // Одна задача на поручение: могла появиться, пока предложение ждало решения.
  const dup = await db.query('select 1 from tasks where origin = $1 and assignee_user_id = $2', [origin, assignee]);
  if (dup.rowCount) return;
  const author = typeof payload.agent_id === 'string' ? payload.agent_id : agentId;
  const owner = await agentOwner(db, author);
  // Импорт по месту: tasks.ts сам импортирует этот модуль.
  const { createTask } = await import('./tasks.js');
  const task = await createTask(db, {
    title: str('title'), why: str('why'), doneCriteria: str('done_criteria'), assigneeUserId: assignee,
    dueDate: str('due_date') || null, rationale: str('rationale') || null, origin,
    // Объяснение везут вместе с предложением: дело, принятое владельцем через неделю, обязано
    // объяснять себя так же, как поставленное сразу (спека task-context).
    description: str('description') || str('rationale') || undefined,
  }, { kind: 'agent', agentId: author, userId: userId ?? owner }, now);
  if (payload.due_assumed === true) await db.query('update tasks set due_assumed = true where id = $1', [task.id]);
}

export async function expireProposals(db: Db, now: Date = new Date()): Promise<number> {
  const r = await db.query(`select id from proposals where status = 'pending' and expires_at <= $1`, [now]);
  for (const row of r.rows) await decideProposal(db, row.id, 'reject', null, { now, expired: true });
  return r.rowCount ?? 0;
}

// ---------------------------------------------------------------- право вето

export type VetoKind = 'reorder' | 'cancel' | 'reschedule' | 'new_person' | 'dialog_task';

export async function recordVetoable(
  db: Db, v: { agentId: string; kind: VetoKind; summary: string; before: unknown; after: unknown; taskId?: string | null }, now: Date = new Date(),
): Promise<string> {
  const owner = await agentOwner(db, v.agentId);
  const r = await db.query(
    `insert into vetoable_changes(org_id, agent_id, kind, summary, before, after, rollback_until)
     values (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6::timestamptz + interval '24 hours') returning id`,
    [v.agentId, v.kind, v.summary, JSON.stringify(v.before), JSON.stringify(v.after), now],
  );
  await notify(db, { userId: owner, kind: 'vetoable', level: 'glance', taskId: v.taskId ?? null, payload: { change_id: r.rows[0].id } });
  return r.rows[0].id as string;
}

export async function rollbackVetoable(db: Db, changeId: string, userId: string, now: Date = new Date()): Promise<void> {
  const r = await db.query('select * from vetoable_changes where id = $1 for update', [changeId]);
  const c = r.rows[0];
  if (!c) throw new AppError('not_found', 'Change not found');
  if (c.rolled_back_at) throw new AppError('conflict', 'Already rolled back');
  if (new Date(c.rollback_until) <= now) throw new AppError('conflict', 'The rollback window (24 h) has passed');
  const owner = await agentOwner(db, c.agent_id);
  if (owner !== userId) throw new AppError('forbidden', 'Only the agent owner can roll back');

  const before = c.before as Record<string, unknown>;
  switch (c.kind as VetoKind) {
    case 'reorder':
      for (const item of (before.positions as { id: string; position: number }[]) ?? []) {
        await db.query('update tasks set position = $2, version = version + 1, updated_at = $3 where id = $1', [item.id, item.position, now]);
      }
      break;
    case 'cancel': {
      // Восстанавливаем только то, что ещё отменено: задачу, ушедшую вперёд, не трогаем (ревью ядра).
      const cur = (await db.query('select status from tasks where id = $1 for update', [before.task_id])).rows[0];
      if (cur?.status !== 'cancelled') throw new AppError('conflict', 'The task has changed since — rollback is impossible');
      await db.query(
        `update tasks set status = $2, version = version + 1, updated_at = $3, status_changed_at = $3 where id = $1`,
        [before.task_id, before.status, now],
      );
      break;
    }
    case 'reschedule': {
      // Перенос срока менял только дату — только её и возвращаем; закрытую задачу не трогаем.
      const cur = (await db.query('select status from tasks where id = $1 for update', [before.task_id])).rows[0];
      if (!cur || ['done', 'declined', 'cancelled', 'resolved'].includes(cur.status)) throw new AppError('conflict', 'The task is already closed — no rollback needed');
      await db.query(`update tasks set due_date = $2::date, version = version + 1, updated_at = $3 where id = $1`, [before.task_id, before.due_date ?? null, now]);
      break;
    }
    case 'new_person':
      await transition(db, before.task_id as string, 'cancel', { kind: 'user', userId }, { now });
      break;
    case 'dialog_task': {
      // Откат задачи из переписки = отмена. Уже закрытую не трогаем — откатывать нечего.
      const cur = (await db.query('select status from tasks where id = $1', [before.task_id])).rows[0];
      if (!cur || !CANCELLABLE.includes(cur.status)) throw new AppError('conflict', 'The task is already closed — no rollback needed');
      await transition(db, before.task_id as string, 'cancel', { kind: 'user', userId }, { now });
      break;
    }
  }
  await db.query('update vetoable_changes set rolled_back_at = $2 where id = $1', [changeId, now]);
  await emit(db, { type: 'vetoed', agentId: c.agent_id, actorUserId: userId, data: { change_id: c.id, kind: c.kind, summary: c.summary } });
  if (before.task_id) {
    const t = (await db.query('select assignee_user_id from tasks where id = $1', [before.task_id])).rows[0];
    if (t) await fillSlot(db, t.assignee_user_id, now);
  }
}
