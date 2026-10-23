import type { Db } from '../db/pool.js';
import { notify } from '../core/notify.js';

// Бюджет AI организации на месяц (спека step-lifecycle-and-queue / core-data-model, `ai_usage`).

export async function runAiBudget(db: Db, orgId: string, now: Date): Promise<void> {
  const org = (await db.query('select owner_user_id, ai_budget_usd_month, translation_paused_at from orgs where id = $1', [orgId])).rows[0];
  if (!org) return;
  const usage = await db.query(
    `select coalesce(sum(usd), 0) as usd from ai_usage where org_id = $1 and at >= date_trunc('month', $2::timestamptz)`,
    [orgId, now],
  );
  if (Number(usage.rows[0].usd) < Number(org.ai_budget_usd_month)) {
    // Бюджет подняли или начался новый месяц — перевод и разбор чатов возвращаются. Без этого пауза,
    // раз поставленная, не снималась никогда, а лендинг и скилл обещают «до повышения бюджета».
    if (org.translation_paused_at) await db.query('update orgs set translation_paused_at = null where id = $1', [orgId]);
    return;
  }

  const monthKey = now.toISOString().slice(0, 7);
  const pausedThisMonth = org.translation_paused_at && new Date(org.translation_paused_at).toISOString().slice(0, 7) === monthKey;
  if (!pausedThisMonth) {
    await db.query('update orgs set translation_paused_at = $2 where id = $1', [orgId, now]);
  }
  await notify(db, { userId: org.owner_user_id, kind: 'ai_budget_exceeded', level: 'decision', dedupeKey: `ai_budget:${orgId}:${monthKey}` });
}
