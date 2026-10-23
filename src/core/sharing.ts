import type { Db } from '../db/pool.js';
import { AppError } from './errors.js';
import { emit } from './events.js';
import type { Task } from './types.js';

// Пометка «рабочее» у личного дела (спека owner-feedback): владелец говорит, что дело
// про бизнес, — и агенты названной компании видят его в блоке owner_activity. Непомеченное личное
// не видит никто. Ставит пометку только владелец пространства и только на свою компанию.

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Поставить или снять пометку. Вызывается внутри `withOrg(<личное пространство>)`: задача берётся
 * под RLS, поэтому чужое личное дело сюда не попадёт даже по прямому id.
 */
export async function setTaskShare(db: Db, taskId: string, userId: string, sharedOrgId: string | null): Promise<Task> {
  if (!UUID.test(taskId)) throw new AppError('not_found', 'Personal task not found');
  const t = (await db.query('select * from tasks where id = $1 for update', [taskId])).rows[0] as Task | undefined;
  if (!t || t.assignee_user_id !== userId) throw new AppError('not_found', 'Personal task not found');

  const space = (await db.query(`select kind from orgs where id = $1`, [t.org_id])).rows[0];
  if (space?.kind !== 'personal') throw new AppError('validation_failed', 'share_with — for a personal item only');

  if (sharedOrgId !== null) {
    const target = (await db.query('select kind from orgs where id = $1', [sharedOrgId])).rows[0];
    if (target?.kind !== 'company') throw new AppError('validation_failed', 'share_with — the name of your company');
    // Пометить можно только на свою компанию: членство проверяем здесь, триггер миграции 005 — второй рубеж.
    const m = await db.query(
      `select 1 from memberships where org_id = $1 and user_id = $2 and status = 'active'`, [sharedOrgId, userId]);
    if (!m.rowCount) throw new AppError('forbidden', 'You are not a member of this organization');
  }
  if (t.shared_org_id === sharedOrgId) return t;

  await db.query(
    'update tasks set shared_org_id = $2, version = version + 1, updated_at = now() where id = $1', [taskId, sharedOrgId]);
  await emit(db, { type: 'task_updated', taskId, actorUserId: userId, data: { fields: ['shared_org_id'] } });
  return (await db.query('select * from tasks where id = $1', [taskId])).rows[0] as Task;
}
