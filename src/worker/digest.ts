import type { Db } from '../db/pool.js';
import { notify } from '../core/notify.js';
import { loadUserSchedule, localDate, localParts } from '../core/calendar.js';

// Дайджест по началу рабочего дня человека (спека telegram-bot, «Дайджест») и недельная сводка
// застрявших планов владельцу по понедельникам (step-lifecycle-and-queue, «Автопилот»).

const DIGEST_WINDOW_MINUTES = 15;
const STUCK_PLAN_DAYS = 7;

function minutesSinceWorkStart(schedule: { start: string }, at: Date, tz: string): number {
  const p = localParts(at, tz);
  const [sh, sm] = schedule.start.split(':').map(Number) as [number, number];
  return p.hour * 60 + p.minute - (sh * 60 + sm);
}

/** Начало рабочего дня человека: рабочий день, времени прошло от work_start не больше окна дайджеста. */
async function isDigestMoment(db: Db, userId: string, now: Date): Promise<{ inWindow: boolean; today: string; monday: boolean }> {
  const schedule = await loadUserSchedule(db, userId);
  const p = localParts(now, schedule.tz);
  const isWorkingDay = schedule.days.includes(p.weekday) && !schedule.holidays.has(localDate(now, schedule.tz));
  const since = minutesSinceWorkStart(schedule, now, schedule.tz);
  return { inWindow: isWorkingDay && since >= 0 && since < DIGEST_WINDOW_MINUTES, today: localDate(now, schedule.tz), monday: p.weekday === 1 };
}

/**
 * Одна организация на человека, куда уходит уведомление `digest` (спека telegram-bot: «Одно
 * сообщение» — человек в нескольких организациях получает не N дайджестов, а один; deliver.ts
 * собирает в него данные по всем организациям). Личное пространство — если есть, иначе первая по
 * `created_at` из активных членств (`orgs`/`memberships` — глобальный слой, без RLS, виден из любого
 * org-контекста).
 */
async function canonicalOrgId(db: Db, userId: string): Promise<string | null> {
  const r = await db.query(
    `select o.id from orgs o join memberships m on m.org_id = o.id
      where m.user_id = $1 and m.status = 'active'
      order by (o.kind <> 'personal'), o.created_at
      limit 1`,
    [userId],
  );
  return r.rows[0]?.id ?? null;
}

export async function runDigest(db: Db, orgId: string, now: Date): Promise<void> {
  const people = (await db.query(`select distinct user_id from memberships where org_id = $1 and status = 'active'`, [orgId])).rows as { user_id: string }[];
  for (const { user_id: userId } of people) {
    if ((await canonicalOrgId(db, userId)) !== orgId) continue; // дайджест этого человека уходит из его канонической организации
    const { inWindow, today } = await isDigestMoment(db, userId, now);
    if (!inWindow) continue;
    await notify(db, { userId, kind: 'digest', level: 'work', dedupeKey: `digest:${userId}:${today}` });
  }

  const org = (await db.query('select owner_user_id from orgs where id = $1', [orgId])).rows[0];
  if (!org) return;
  const { inWindow, today, monday } = await isDigestMoment(db, org.owner_user_id, now);
  if (!inWindow || !monday) return;
  const stuck = await db.query(
    `select p.id from plans p
      where p.org_id = $1 and p.status in ('active', 'waiting')
        and not exists (select 1 from events e where e.plan_id = p.id and e.at > $2)`,
    [orgId, new Date(now.getTime() - STUCK_PLAN_DAYS * 86400000)],
  );
  if (stuck.rowCount) {
    await notify(db, {
      userId: org.owner_user_id, kind: 'stuck_summary', level: 'glance',
      payload: { plan_ids: stuck.rows.map((r) => r.id) }, dedupeKey: `stuck_summary:${orgId}:${today}`,
    });
  }
}
