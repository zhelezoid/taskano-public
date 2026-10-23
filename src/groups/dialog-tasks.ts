import type { Db } from '../db/pool.js';
import { t } from '../i18n/index.js';
import { localDate, localParts, loadUserSchedule, nextWorkingStart, zonedToUtc, type Schedule } from '../core/calendar.js';

// Задачи из переписки рабочей группы (спека group-intake, этап 1b): служебный агент
// «Секретарь», срок по умолчанию, дневной лимит организации и строка владельцу для права вето.

/** Не больше стольких задач из диалога в день на организацию; сверх — предложение от «Секретаря». */
export const DIALOG_TASK_DAILY_LIMIT = 10;

export interface AgentRef { id: string; name: string; status: string; owner_user_id: string }

/**
 * «Секретарь» организации: создаётся при подключении первой группы или лениво при первой задаче из
 * диалога; владелец — всегда владелец организации (ему идут откат и предложения). Чужого агента с тем же
 * именем не подхватываем: смена владельца молча отняла бы агента у того, кто его завёл, а оставить прежнего
 * владельца — значит слать вето не владельцу организации. Имя занято — «Секретарь (2)», «(3)»…
 * Подхватываем только агента владельца организации без служебной роли.
 */
export async function ensureSecretary(db: Db): Promise<AgentRef> {
  const org = (await db.query(`select owner_user_id, language from orgs where id = current_setting('app.org_id')::uuid`)).rows[0];
  const base = t(org.language, 'group.secretary_name');
  for (let i = 1; i <= 20; i++) {
    const found = await db.query(`select id, name, status, owner_user_id from agents where system_role = 'secretary'`);
    if (found.rowCount) return found.rows[0] as AgentRef;
    const name = i === 1 ? base : `${base} (${i})`;
    const same = (await db.query('select id, owner_user_id, system_role from agents where lower(name) = lower($1)', [name])).rows[0];
    if (same) {
      if (same.owner_user_id !== org.owner_user_id || same.system_role) continue;
      const r = await db.query(
        `update agents set system_role = 'secretary' where id = $1 and system_role is null returning id, name, status, owner_user_id`, [same.id]);
      if (r.rowCount) return r.rows[0] as AgentRef;
      continue;
    }
    const r = await db.query(
      `insert into agents(org_id, name, description, owner_user_id, system_role)
       values (current_setting('app.org_id')::uuid, $1, $2, $3, 'secretary')
       on conflict (org_id, lower(name)) do nothing
       returning id, name, status, owner_user_id`,
      [name, t(org.language, 'group.secretary_description'), org.owner_user_id],
    );
    if (r.rowCount) return r.rows[0] as AgentRef;
  }
  throw new Error('ensureSecretary: не удалось подобрать свободное имя');
}

/** Следующий рабочий день исполнителя ('YYYY-MM-DD' в его поясе) — срок, если в переписке он не назван. */
export function nextWorkingDay(s: Schedule, now: Date): string {
  const p = localParts(now, s.tz);
  const tomorrow = zonedToUtc(p.year, p.month, p.day + 1, 0, 0, s.tz);
  return localDate(nextWorkingStart(s, tomorrow), s.tz);
}

/** Сколько задач из диалога организация получила с начала дня (пояс владельца организации). */
export async function dialogTasksToday(db: Db, now: Date): Promise<number> {
  const owner = (await db.query(`select owner_user_id from orgs where id = current_setting('app.org_id')::uuid`)).rows[0].owner_user_id as string;
  const { tz } = await loadUserSchedule(db, owner);
  const [y, m, d] = localDate(now, tz).split('-').map(Number) as [number, number, number];
  const r = await db.query(
    `select count(*)::int as n from tasks where origin like 'group:%' and author_agent_id is not null and created_at >= $1`,
    [zonedToUtc(y, m, d, 0, 0, tz)],
  );
  return r.rows[0].n as number;
}

/** origin задачи из диалога: `group:<group_id>:<telegram_message_id>`. */
export function dialogOrigin(groupId: string, telegramMessageId: string | number): string {
  return `group:${groupId}:${telegramMessageId}`;
}

export function parseDialogOrigin(origin: string | null | undefined): { groupId: string; messageId: string } | null {
  const m = /^group:([0-9a-f-]{36}):(\d{1,20})$/i.exec(origin ?? '');
  return m ? { groupId: m[1]!, messageId: m[2]! } : null;
}

/**
 * Текст для владельца агента на его языке: «Секретарь поставил Аня: <задача> — из группы <название>»
 * (строка «Взгляд» с кнопкой «Откатить» или предложение сверх лимита).
 */
export async function dialogTaskLine(
  db: Db, key: 'group.task_created_line' | 'group.task_proposal', agentId: string, assigneeUserId: string, title: string, groupId: string,
): Promise<string> {
  const a = (await db.query(
    `select a.name, u.language from agents a join users u on u.id = a.owner_user_id where a.id = $1`, [agentId])).rows[0];
  const name = (await db.query('select display_name from users where id = $1', [assigneeUserId])).rows[0]?.display_name || '?';
  const group = (await db.query('select title from group_chats where id = $1', [groupId])).rows[0]?.title ?? '';
  return t(a?.language, key, { agent: a?.name ?? '', name, title, group });
}
