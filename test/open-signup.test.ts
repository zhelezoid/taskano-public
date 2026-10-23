import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import './helpers.js';
import { closePools, withGlobal, withSystem } from '../src/db/pool.js';
import { sha256 } from '../src/core/crypto.js';
import { INVITE_LIMITS, invitePerson, resendInvitation } from '../src/core/invitations.js';
import { addMember } from '../src/core/people.js';
import { tickOrg } from '../src/worker/tick.js';
import { outbox } from '../src/email/send.js';
import { inOrg, makeOrg, makeUser } from './helpers.js';
import { callTool, connectClient } from './mcp-client.js';

// Спека open-signup: компанию заводит любой вошедший, без инвайт-кода; открытость не превращает
// Taskano в рассыльщик писем-приглашений.

afterAll(closePools);

const parse = (r: Awaited<ReturnType<typeof callTool>>): any => JSON.parse((r.body.result as any).content[0].text);
const isError = (r: Awaited<ReturnType<typeof callTool>>): boolean => Boolean((r.body.result as any).isError);
const uniq = () => randomUUID().slice(0, 8);

async function inviteCode(): Promise<string> {
  const code = `TSK-${uniq()}`;
  await withGlobal((db) => db.query(`insert into product_invite_codes(code_hash, note, created_by) values ($1, 'test', 'test')`, [sha256(code)]));
  return code;
}

describe('create_org без инвайт-кода', () => {
  afterEach(() => { delete process.env.SIGNUP_ORGS_PER_DAY; });

  it('компания создаётся без кода, вход записан в аудит', async () => {
    const token = await connectClient(`open-${uniq()}@test.local`);
    const r = await callTool(token, 'create_org', { name: `Open ${uniq()}` });
    expect(isError(r)).toBe(false);
    const orgId = parse(r).org_id as string;
    const audit = await withGlobal((db) => db.query(`select 1 from admin_audit where action = 'org_created_open' and payload->>'org_id' = $1`, [orgId]));
    expect(audit.rowCount).toBe(1);
  });

  it('пустой код — это «кода нет»; неверный код — отказ, а не создание без него', async () => {
    const token = await connectClient(`open-${uniq()}@test.local`);
    expect(isError(await callTool(token, 'create_org', { name: `Empty ${uniq()}`, invite_code: '  ' }))).toBe(false);
    const bad = await callTool(token, 'create_org', { name: `Bad ${uniq()}`, invite_code: 'no-such-code' });
    expect(isError(bad)).toBe(true);
    expect(JSON.stringify(bad.body)).toMatch(/invite code is invalid/);
  });

  it('верный код гасится и в счёт открытой регистрации не идёт', async () => {
    const token = await connectClient(`open-${uniq()}@test.local`);
    const code = await inviteCode();
    const orgId = parse(await callTool(token, 'create_org', { name: `Coded ${uniq()}`, invite_code: code })).org_id as string;
    const row = await withGlobal(async (db) => (await db.query('select used_by_org from product_invite_codes where code_hash = $1', [sha256(code)])).rows[0]);
    expect(row.used_by_org).toBe(orgId);
    const audit = await withGlobal((db) => db.query(`select 1 from admin_audit where action = 'org_created_open' and payload->>'org_id' = $1`, [orgId]));
    expect(audit.rowCount).toBe(0);
  });

  it('четвёртая компания одного человека — отказ', async () => {
    const token = await connectClient(`open-${uniq()}@test.local`);
    for (let i = 0; i < 3; i++) expect(isError(await callTool(token, 'create_org', { name: `Mine ${i} ${uniq()}` }))).toBe(false);
    const fourth = await callTool(token, 'create_org', { name: `Mine 4 ${uniq()}` });
    expect(isError(fourth)).toBe(true);
    expect(JSON.stringify(fourth.body)).toMatch(/three organizations/);
  });

  it('предохранитель продукта: граница суточного потолка — ровно на пределе', async () => {
    // Счёт — по всему продукту: вынести из окна суток всё, что насоздавали другие тесты, иначе граница
    // проверялась бы случайным накопленным числом, а не кодом (ревью диффа).
    // admin_audit только на добавление для ролей приложения — сдвигаем время от имени владельца базы.
    const owner = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await owner.connect();
    await owner.query(`update admin_audit set at = at - interval '25 hours' where action = 'org_created_open'`);
    await owner.end();
    process.env.SIGNUP_ORGS_PER_DAY = '1';
    const token = await connectClient(`open-${uniq()}@test.local`);
    expect(isError(await callTool(token, 'create_org', { name: `First ${uniq()}` }))).toBe(false);
    expect(isError(await callTool(token, 'create_org', { name: `Second ${uniq()}` }))).toBe(true);
  });

  it('предохранитель продукта: при исчерпанном суточном потолке без кода — отказ, с кодом — можно', async () => {
    process.env.SIGNUP_ORGS_PER_DAY = '0';
    const token = await connectClient(`open-${uniq()}@test.local`);
    const refused = await callTool(token, 'create_org', { name: `Late ${uniq()}` });
    expect(isError(refused)).toBe(true);
    expect(JSON.stringify(refused.body)).toMatch(/support@taskano\.app/);
    expect(isError(await callTool(token, 'create_org', { name: `Coded ${uniq()}`, invite_code: await inviteCode() }))).toBe(false);
  });
});

describe('потолок писем-приглашений', () => {
  const invite = (org: { orgId: string; ownerId: string }) => inOrg(org.orgId, (db) => invitePerson(db,
    { email: `inv-${uniq()}@test.local`, role: 'member' }, { kind: 'user', userId: org.ownerId }), org.ownerId);
  const ageInvites = (orgId: string, days: number) => withSystem((db) => db.query(
    `update events set at = at - make_interval(days => $2) where org_id = $1 and type in ('person_invited', 'invitation_resent')`, [orgId, days]));
  const mails = () => outbox.length;

  it('свежая компания: десять писем в сутки, одиннадцатое — отказ и письмо не уходит', async () => {
    const org = await makeOrg();
    for (let i = 0; i < 10; i++) await invite(org);
    const before = mails();
    await expect(invite(org)).rejects.toThrow(/10 invitation emails a day/);
    expect(mails()).toBe(before);
  });

  it('повтор приглашения — тоже письмо и тоже в счёт', async () => {
    const org = await makeOrg();
    const email = `again-${uniq()}@test.local`;
    await inOrg(org.orgId, (db) => invitePerson(db, { email, role: 'member' }, { kind: 'user', userId: org.ownerId }), org.ownerId);
    for (let i = 0; i < 9; i++) await invite(org);
    await expect(inOrg(org.orgId, (db) => resendInvitation(db, email, { kind: 'user', userId: org.ownerId }), org.ownerId))
      .rejects.toThrow(/invitation emails a day/);
  });

  it('свежая компания: не больше тридцати писем за первые семь дней', async () => {
    const org = await makeOrg();
    for (let day = 0; day < 3; day++) {
      for (let i = 0; i < 10; i++) await invite(org);
      await ageInvites(org.orgId, 2);
    }
    await expect(invite(org)).rejects.toThrow(/first 7 days/);
  });

  it('компания старше недели: двадцать в сутки, двадцать первое — отказ', async () => {
    const org = await makeOrg();
    await withSystem((db) => db.query(`update orgs set created_at = now() - interval '8 days' where id = $1`, [org.orgId]));
    for (let i = 0; i < 20; i++) await invite(org);
    await expect(invite(org)).rejects.toThrow(/20 invitation emails a day/);
  });
});

describe('непроверенная компания (заведена без кода)', () => {
  const openOrg = async () => {
    const email = `open-${uniq()}@test.local`;
    const token = await connectClient(email);
    const orgId = parse(await callTool(token, 'create_org', { name: `Open ${uniq()}` })).org_id as string;
    const ownerId = await withGlobal(async (db) => (await db.query('select user_id from user_emails where email = $1', [email])).rows[0].user_id as string);
    return { token, orgId, ownerId };
  };

  it('бюджет AI — 5 $, выше потолка владелец компании не поднимет; после trust-org — может', async () => {
    const { token, orgId } = await openOrg();
    const row = await withGlobal(async (db) => (await db.query('select trusted, ai_budget_usd_month, ai_budget_cap_usd from orgs where id = $1', [orgId])).rows[0]);
    expect(row).toEqual({ trusted: false, ai_budget_usd_month: '5.00', ai_budget_cap_usd: '5.00' });
    const over = await callTool(token, 'update_org_settings', { org: orgId, ai_budget_usd_month: 99999999 });
    expect(isError(over)).toBe(true);
    expect(JSON.stringify(over.body)).toMatch(/at most \$5/);
    expect(isError(await callTool(token, 'update_org_settings', { org: orgId, ai_budget_usd_month: 3 }))).toBe(false);
    await withGlobal((db) => db.query('update orgs set trusted = true, ai_budget_cap_usd = 50 where id = $1', [orgId]));
    expect(isError(await callTool(token, 'update_org_settings', { org: orgId, ai_budget_usd_month: 40 }))).toBe(false);
  });

  it('писем-приглашений — 30 за всё время', async () => {
    const { orgId, ownerId } = await openOrg();
    const inv = () => inOrg(orgId, (db) => invitePerson(db, { email: `inv-${uniq()}@test.local`, role: 'member' }, { kind: 'user', userId: ownerId }), ownerId);
    // Старше недели, чтобы суточные потолки не мешали: проверяется именно «всего».
    await withSystem((db) => db.query(`update orgs set created_at = now() - interval '30 days' where id = $1`, [orgId]));
    for (let batch = 0; batch < 2; batch++) {
      for (let i = 0; i < 15; i++) await inv();
      await withSystem((db) => db.query(`update events set at = at - interval '2 days' where org_id = $1`, [orgId]));
    }
    await expect(inv()).rejects.toThrow(/without an invite code can send 30/);
  });

  it('потолок писем на весь продукт от непроверенных компаний', async () => {
    const { orgId, ownerId } = await openOrg();
    const saved = INVITE_LIMITS.untrustedProductPerDay;
    try {
      INVITE_LIMITS.untrustedProductPerDay = 0;
      await expect(inOrg(orgId, (db) => invitePerson(db, { email: `inv-${uniq()}@test.local`, role: 'member' }, { kind: 'user', userId: ownerId }), ownerId))
        .rejects.toThrow(/not sending invitations from new organizations/);
    } finally {
      INVITE_LIMITS.untrustedProductPerDay = saved;
    }
  });

  it('название со ссылкой или переводом строки не принимается', async () => {
    const token = await connectClient(`open-${uniq()}@test.local`);
    for (const name of ['PayPal Security https://paypal-verify.example/login', 'Acme\n\nVerify your account', 'Go to paypal-verify.com now']) {
      expect(isError(await callTool(token, 'create_org', { name }))).toBe(true);
    }
    expect(isError(await callTool(token, 'create_org', { name: 'Harbour & Co. Ltd' }))).toBe(false);
  });
});

describe('гонка и напоминания в потолке приглашений', () => {
  it('параллельные приглашения не проходят потолок', async () => {
    const org = await makeOrg();
    const results = await Promise.allSettled(Array.from({ length: 18 }, () => inOrg(org.orgId,
      (db) => invitePerson(db, { email: `race-${uniq()}@test.local`, role: 'member' }, { kind: 'user', userId: org.ownerId }), org.ownerId)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
  });

  it('напоминание воркера — письмо в счёт; сверх потолка не уходит', async () => {
    const org = await makeOrg();
    for (let i = 0; i < 10; i++) {
      await inOrg(org.orgId, (db) => invitePerson(db, { email: `rem-${uniq()}@test.local`, role: 'member' }, { kind: 'user', userId: org.ownerId }), org.ownerId);
    }
    // Приглашениям три дня, но их события — «сегодня»: суточный потолок свежей компании исчерпан.
    await withSystem((db) => db.query(`update invitations set created_at = now() - interval '3 days' where org_id = $1`, [org.orgId]));
    const before = outbox.length;
    await tickOrg(org.orgId, new Date());
    expect(outbox.length).toBe(before);
    const reminded = await withSystem(async (db) => (await db.query(`select count(*)::int as n from events where org_id = $1 and type = 'invitation_reminded'`, [org.orgId])).rows[0].n);
    expect(reminded).toBe(0);
  });
});

describe('чужой профиль', () => {
  it('имя и часы человека из другой компании не переписать; своего единственного — можно', async () => {
    const victimOrg = await makeOrg();
    const victim = await makeUser();
    await withGlobal((db) => addMember(db, victimOrg.orgId, victim, 'member'));
    const email = await withGlobal(async (db) => (await db.query('select email::text from user_emails where user_id = $1', [victim])).rows[0].email as string);

    const attackerEmail = `att-${uniq()}@test.local`;
    const token = await connectClient(attackerEmail);
    const orgId = parse(await callTool(token, 'create_org', { name: `Att ${uniq()}` })).org_id as string;
    expect(isError(await callTool(token, 'invite_person', { org: orgId, email }))).toBe(false);
    const r = await callTool(token, 'set_person_settings', { org: orgId, person: email, name: 'PWNED', work_start: '03:00', work_end: '04:00' });
    expect(isError(r)).toBe(true);
    expect(JSON.stringify(r.body)).toMatch(/another organization/);
    const after = await withGlobal(async (db) => (await db.query('select display_name, work_start from users where id = $1', [victim])).rows[0]);
    expect(after.display_name).not.toBe('PWNED');

    const fresh = `fresh-${uniq()}@test.local`;
    expect(isError(await callTool(token, 'invite_person', { org: orgId, email: fresh }))).toBe(false);
    expect(isError(await callTool(token, 'set_person_settings', { org: orgId, person: fresh, timezone: 'Europe/Berlin' }))).toBe(false);
  });

  it('имя приглашённого со ссылкой не принимается', async () => {
    const org = await makeOrg();
    await expect(inOrg(org.orgId, (db) => invitePerson(db, { email: `n-${uniq()}@test.local`, name: 'your account is locked, go to https://x.example', role: 'member' },
      { kind: 'user', userId: org.ownerId }), org.ownerId)).rejects.toThrow(/links/);
  });
});
