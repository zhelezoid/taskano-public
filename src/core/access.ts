import type { Db } from '../db/pool.js';
import { AppError } from './errors.js';
import type { Actor } from './types.js';
import { actorAgentId, actorUserId } from './types.js';

export type Role = 'owner' | 'admin' | 'member' | 'guest';

export interface Membership { org_id: string; user_id: string; role: Role; status: string; mode: 'lead' | 'self' }

/** Членство в текущей организации (внутри withOrg). */
export async function membership(db: Db, userId: string): Promise<Membership | null> {
  const r = await db.query(
    `select * from memberships where org_id = current_setting('app.org_id')::uuid and user_id = $1 and status in ('active','invited')`,
    [userId],
  );
  return (r.rows[0] as Membership) ?? null;
}

/** Без roles — «можно назначать задачи» (приглашённый тоже). С roles — право действовать: только активное членство. */
export async function requireMember(db: Db, userId: string, roles?: Role[]): Promise<Membership> {
  const m = await membership(db, userId);
  if (!m) throw new AppError('forbidden', 'The person is not a member of this organization');
  if (roles && (!roles.includes(m.role) || m.status !== 'active')) throw new AppError('forbidden', `Required role: ${roles.join(' or ')}`);
  return m;
}

/**
 * Человек, чьими правами идёт действие: он сам или хозяин агента (спека roles-and-rights).
 * Агент здесь не отдельное лицо — иначе агент рядового исполнителя распоряжался бы компанией
 * шире, чем тот, кто его завёл.
 */
export async function actingUserId(db: Db, actor: Actor): Promise<string | null> {
  const agentId = actorAgentId(actor);
  return agentId ? (await loadAgent(db, agentId)).owner_user_id : actorUserId(actor);
}

/** Роль того, от чьего имени идёт действие: путь через агента не должен быть путём в обход роли. */
export async function requireActorRole(db: Db, actor: Actor, roles: Role[]): Promise<Membership> {
  const userId = await actingUserId(db, actor);
  if (!userId) throw new AppError('forbidden', 'The system does not act on behalf of a person here');
  return requireMember(db, userId, roles);
}

/**
 * То же, что `requireActorRole`, но ответом «да/нет», а не отказом: там, где от роли зависит не
 * доступ к инструменту, а часть ответа (отметки «когда заходил» видит только управляющий).
 */
export async function actorHasRole(db: Db, actor: Actor, roles: Role[]): Promise<boolean> {
  const userId = await actingUserId(db, actor);
  if (!userId) return false;
  const m = await membership(db, userId);
  return Boolean(m && m.status === 'active' && roles.includes(m.role));
}

export interface AgentRow {
  id: string; org_id: string; name: string; description: string; owner_user_id: string;
  status: 'active' | 'paused'; permissions: Record<string, unknown>;
}

export async function loadAgent(db: Db, agentRef: string): Promise<AgentRow> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(agentRef);
  const r = await db.query(`select * from agents where ${isUuid ? 'id = $1' : 'lower(name) = lower($1)'}`, [agentRef]);
  if (!r.rowCount) throw new AppError('not_found', `Agent "${agentRef}" not found`);
  if (r.rowCount > 1) throw new AppError('validation_failed', `The name "${agentRef}" is ambiguous — pass the agent id`);
  return r.rows[0] as AgentRow;
}

/** Действовать от имени агента может его владелец или owner/admin организации. */
export async function requireAgentControl(db: Db, agentRef: string, userId: string): Promise<AgentRow> {
  const agent = await loadAgent(db, agentRef);
  const m = await membership(db, userId);
  if (!m || m.status !== 'active') throw new AppError('forbidden', 'Active membership in the organization is required');
  if (agent.owner_user_id === userId) return agent;
  if (['owner', 'admin'].includes(m.role)) return agent;
  throw new AppError('forbidden', 'Only the agent owner or an admin can act on behalf of this agent');
}
