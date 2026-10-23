import { afterAll, describe, expect, it } from 'vitest';
import { closePools } from '../src/db/pool.js';
import { tickOrg } from '../src/worker/tick.js';
import { invitePerson } from '../src/core/invitations.js';
import { outbox } from '../src/email/send.js';
import { inOrg, makeOrg, minutes, uniq, MON_10 } from './helpers.js';

// Бюджет AI (src/worker/budget.ts) и таймеры приглашений (src/worker/invitations.ts) —
// спека translation-and-email («Бюджет месяца организации превышен»/«Напоминание о приглашении»)
// и step-lifecycle-and-queue.md («Таймеры», эскалация 5 дней). Оба вызываются из runTick, но здесь
// тикаем свою организацию (`tickOrg`): `runTick` обходит ВСЕ организации базы, а тестовая за прогон
// разрастается до сотен — один такой тик доходил до 8 секунд, и проверки падали по таймауту, ничего
// при этом не проверив. Сам обход организаций покрыт в worker.test.ts.

afterAll(closePools);

async function notifications(orgId: string, kind: string, userId: string) {
  return inOrg(orgId, (db) => db.query(`select * from notifications where kind = $1 and user_id = $2`, [kind, userId]));
}

const DAY_MS = 24 * 60;

describe('бюджет AI (runAiBudget)', () => {
  it('расход ниже месячного бюджета — пауза не наступает, уведомления нет', async () => {
    const { orgId, ownerId } = await makeOrg();
    // Дефолтный бюджет организации — 20 usd/месяц (orgs.ai_budget_usd_month).
    await inOrg(orgId, (db) => db.query(
      `insert into ai_usage(org_id, fn, model, input_tokens, output_tokens, usd, at) values ($1, 'translate', 'claude-haiku-4-5', 1000, 500, 5.00, $2)`,
      [orgId, MON_10],
    ));

    await tickOrg(orgId, MON_10);

    const org = await inOrg(orgId, (db) => db.query('select translation_paused_at from orgs where id = $1', [orgId]));
    expect(org.rows[0].translation_paused_at).toBeNull();
    const notif = await notifications(orgId, 'ai_budget_exceeded', ownerId);
    expect(notif.rowCount).toBe(0);
  });

  it('расход выше бюджета — пауза перевода и одно уведомление владельцу, повторный тик не задваивает', async () => {
    const { orgId, ownerId } = await makeOrg();
    await inOrg(orgId, (db) => db.query(
      `insert into ai_usage(org_id, fn, model, input_tokens, output_tokens, usd, at) values ($1, 'translate', 'claude-haiku-4-5', 20000, 10000, 25.00, $2)`,
      [orgId, MON_10],
    ));

    await tickOrg(orgId, MON_10);
    const org1 = await inOrg(orgId, (db) => db.query('select translation_paused_at from orgs where id = $1', [orgId]));
    expect(org1.rows[0].translation_paused_at).not.toBeNull();
    const notif1 = await notifications(orgId, 'ai_budget_exceeded', ownerId);
    expect(notif1.rowCount).toBe(1);

    await tickOrg(orgId, minutes(MON_10, 5));
    const notif2 = await notifications(orgId, 'ai_budget_exceeded', ownerId);
    expect(notif2.rowCount).toBe(1);
    const org2 = await inOrg(orgId, (db) => db.query('select translation_paused_at from orgs where id = $1', [orgId]));
    expect(new Date(org2.rows[0].translation_paused_at).getTime()).toBe(new Date(org1.rows[0].translation_paused_at).getTime());
  });

  it('пауза снимается: бюджет подняли — со следующего тика; новый месяц — сама', async () => {
    const paused = async (orgId: string) => (await inOrg(orgId, (db) => db.query('select translation_paused_at from orgs where id = $1', [orgId]))).rows[0].translation_paused_at;
    const { orgId } = await makeOrg();
    await inOrg(orgId, (db) => db.query(
      `insert into ai_usage(org_id, fn, model, input_tokens, output_tokens, usd, at) values ($1, 'translate', 'claude-haiku-4-5', 20000, 10000, 25.00, $2)`,
      [orgId, MON_10],
    ));
    await tickOrg(orgId, MON_10);
    expect(await paused(orgId)).not.toBeNull();

    await inOrg(orgId, (db) => db.query('update orgs set ai_budget_usd_month = 50 where id = $1', [orgId]));
    await tickOrg(orgId, minutes(MON_10, 5));
    expect(await paused(orgId)).toBeNull();

    await inOrg(orgId, (db) => db.query('update orgs set ai_budget_usd_month = 20 where id = $1', [orgId]));
    await tickOrg(orgId, minutes(MON_10, 10));
    expect(await paused(orgId)).not.toBeNull();
    // Через 40 дней расход прошлого месяца не считается — перевод возвращается без действий владельца.
    await tickOrg(orgId, minutes(MON_10, 40 * DAY_MS));
    expect(await paused(orgId)).toBeNull();
  });
});

describe('таймеры приглашений (runInvitationTimers)', () => {
  it('pending 2+ дня — одно письмо-напоминание в outbox, повторный тик не задваивает', async () => {
    const { orgId, ownerId } = await makeOrg();
    const email = `invitee-${uniq()}@test.local`;
    await inOrg(orgId, (db) => invitePerson(db, { email, role: 'member', language: 'ru' }, { kind: 'user', userId: ownerId }, MON_10));
    // invitePerson уже отправил письмо-приглашение — отодвигаем created_at назад, чтобы наступил порог напоминания (2 дня).
    const threeDaysAgo = minutes(MON_10, -3 * DAY_MS);
    await inOrg(orgId, (db) => db.query(`update invitations set created_at = $2 where email = $1`, [email, threeDaysAgo]));

    await tickOrg(orgId, MON_10);
    const mailsAfterFirst = outbox.filter((m) => m.to === email);
    expect(mailsAfterFirst).toHaveLength(2); // приглашение + напоминание
    expect(mailsAfterFirst[1]!.subject).toBe('Вас ждут в Taskano');
    const inv1 = await inOrg(orgId, (db) => db.query(`select reminded_at, escalated_at from invitations where email = $1`, [email]));
    expect(inv1.rows[0].reminded_at).not.toBeNull();
    expect(inv1.rows[0].escalated_at).toBeNull(); // до эскалации (5 дней) ещё не дошло

    await tickOrg(orgId, minutes(MON_10, 5));
    const mailsAfterSecond = outbox.filter((m) => m.to === email);
    expect(mailsAfterSecond).toHaveLength(2); // повторный тик не шлёт второе напоминание
  });

  it('pending 5+ дней (напоминание уже отправлено) — invitation_stalled событие и уведомление один раз', async () => {
    const { orgId, ownerId } = await makeOrg();
    const email = `invitee-${uniq()}@test.local`;
    await inOrg(orgId, (db) => invitePerson(db, { email, role: 'member' }, { kind: 'user', userId: ownerId }, MON_10));
    const sixDaysAgo = minutes(MON_10, -6 * DAY_MS);
    const fourDaysAgo = minutes(MON_10, -4 * DAY_MS);
    // reminded_at уже стоит (напоминание отправлено раньше) — изолируем сценарий именно от эскалации.
    await inOrg(orgId, (db) => db.query(
      `update invitations set created_at = $2, reminded_at = $3 where email = $1`, [email, sixDaysAgo, fourDaysAgo],
    ));

    await tickOrg(orgId, MON_10);
    const mails = outbox.filter((m) => m.to === email);
    expect(mails).toHaveLength(1); // только исходное приглашение — новое напоминание не шлём повторно

    const invId = (await inOrg(orgId, (db) => db.query(`select id from invitations where email = $1`, [email]))).rows[0].id as string;
    const ev1 = await inOrg(orgId, (db) => db.query(
      `select 1 from events where type = 'invitation_stalled' and data->>'invitation_id' = $1`, [invId],
    ));
    expect(ev1.rowCount).toBe(1);
    const notif1 = await notifications(orgId, 'invitation_stalled', ownerId);
    expect(notif1.rowCount).toBe(1);

    await tickOrg(orgId, minutes(MON_10, 1));
    const ev2 = await inOrg(orgId, (db) => db.query(
      `select count(*)::int as n from events where type = 'invitation_stalled' and data->>'invitation_id' = $1`, [invId],
    ));
    expect(ev2.rows[0].n).toBe(1);
    const notif2 = await notifications(orgId, 'invitation_stalled', ownerId);
    expect(notif2.rowCount).toBe(1);
  });
});
