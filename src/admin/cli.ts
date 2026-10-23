import { randomToken, sha256 } from '../core/crypto.js';
import { closePools, withGlobal } from '../db/pool.js';

// Админка владельца продукта (спека pilot-deploy). Запуск в контейнере:
//   docker exec taskano-web node dist/src/admin/cli.js <команда>
// Команды: invite-code [заметка] [дней] · provision-client <почта> <компания> [язык] [пояс] ·
//   set-webhook · resend-invitation <почта> <организация: id или название> ·
//   create-project <организация> <название> [ключ] · project-member <организация> <проект> <человек> [--remove] ·
//   demo-reset · demo-code · trust-org <организация> [потолок бюджета $] · audit-invite-links · status

async function inviteCode(note: string, days: number): Promise<void> {
  const code = `TSK-${randomToken(9)}`;
  await withGlobal(async (db) => {
    await db.query(
      `insert into product_invite_codes(code_hash, note, created_by, expires_at) values ($1, $2, 'admin-cli', now() + make_interval(days => $3))`,
      [sha256(code), note || null, days],
    );
    await db.query(`insert into admin_audit(actor, action, payload) values ('admin-cli', 'invite_code_created', $1)`, [{ note, days }]);
  });
  // Код показывается один раз: в базе только хэш.
  process.stdout.write(`${code}\n`);
}

/**
 * Подписать клиента: человек + его компания, без инвайт-кода. Клиенту остаётся войти по почте —
 * организация уже ждёт его, и setup.md ведёт его агента с шага «подтвердите язык и часовой пояс».
 * Язык и часовой пояс за клиента не угадываются (`provisionClient`): их назовёт он сам.
 */
async function provision(email: string, company: string, language?: string, timezone?: string): Promise<void> {
  if (!email || !company) throw new Error('provision-client <почта> <компания> [язык] [часовой пояс]');
  const { provisionClient } = await import('../core/people.js');
  const r = await withGlobal(async (db) => {
    const out = await provisionClient(db, email, company, { language, timezone });
    await db.query(`insert into admin_audit(actor, action, payload) values ('admin-cli', 'client_provisioned', $1)`,
      [{ email, company, org_id: out.orgId, created: out.created }]);
    return out;
  });
  process.stdout.write(`${JSON.stringify({ ...r, email, company }, null, 2)}\n`);
}

async function status(): Promise<void> {
  const r = await withGlobal((db) => db.query(`
    select (select count(*) from orgs where kind = 'company') as companies,
           (select count(*) from users where anonymized_at is null) as users,
           (select count(*) from telegram_links where blocked_at is null) as telegram,
           (select count(*) from product_invite_codes where used_by_org is null and (expires_at is null or expires_at > now())) as free_codes,
           (select extract(epoch from now() - max(at))::int from admin_audit where action = 'worker_heartbeat') as heartbeat_age_s`));
  process.stdout.write(`${JSON.stringify(r.rows[0], null, 2)}\n`);
}

/**
 * Проект в компании (спека projects-stage2). Заводится от имени владельца организации: у проекта есть
 * хозяин, и это должен быть человек, а не «админка». Ключ считает сервер, если его не назвали.
 */
async function createBoard(orgRef: string, name: string, key?: string): Promise<void> {
  const { withOrg } = await import('../db/pool.js');
  const { createProject } = await import('../core/projects.js');
  const byId = /^[0-9a-f-]{36}$/i.test(orgRef);
  const found = await withGlobal(async (db) => (await db.query(
    byId ? `select id, owner_user_id from orgs where id = $1 and kind = 'company'`
         : `select id, owner_user_id from orgs where lower(name) = lower($1) and kind = 'company'`, [orgRef])).rows);
  if (found.length !== 1) throw new Error(`организация «${orgRef}»: найдено ${found.length}`);
  const org = found[0] as { id: string; owner_user_id: string };
  const project = await withOrg(org.id, (db) => createProject(db, { name, key: key ?? null },
    { kind: 'user', userId: org.owner_user_id }), { actorUserId: org.owner_user_id });
  process.stdout.write(`проект «${project.name}» (${project.key}) заведена в организации ${orgRef}\n`);
}

/**
 * Состав проекта (спека projects-stage2): кого пускают к её делам. Через админку —
 * потому что владелец добавляет людей и тогда, когда до разговора с агентом руки не дошли.
 */
async function projectMember(orgRef: string, projectRef: string, person: string, remove: boolean): Promise<void> {
  const { withOrg } = await import('../db/pool.js');
  const { addProjectMember, removeProjectMember } = await import('../core/projects.js');
  const org = await findCompany(orgRef);
  const fn = remove ? removeProjectMember : addProjectMember;
  const r = await withOrg(org.id, (db) => fn(db, projectRef, person, { kind: 'user', userId: org.owner_user_id }),
    { actorUserId: org.owner_user_id });
  process.stdout.write(`${remove ? 'снят с проекта' : 'добавлен в проект'} «${r.project.name}»: ${r.user_id}\n`);
}

/** Компания по id или названию: названия не уникальны, поэтому id — надёжный способ её назвать. */
async function findCompany(ref: string): Promise<{ id: string; owner_user_id: string }> {
  const byId = /^[0-9a-f-]{36}$/i.test(ref);
  const found = await withGlobal(async (db) => (await db.query(
    byId ? `select id, owner_user_id from orgs where id = $1 and kind = 'company'`
         : `select id, owner_user_id from orgs where lower(name) = lower($1) and kind = 'company'`, [ref])).rows);
  if (found.length !== 1) throw new Error(`организация «${ref}»: найдено ${found.length}`);
  return found[0] as { id: string; owner_user_id: string };
}

/**
 * Новый код демо-входа (спека demo-access). Код печатается один раз и нигде не хранится; в .env идёт
 * строка с хэшем, снятым той же нормализацией, что сверяет вход. Прежние токены демо-владельца
 * отзываются: смена кода после утечки иначе не выгнала бы того, кто уже вошёл.
 */
async function demoCode(): Promise<void> {
  const { generateDemoCode, demoCodeHash } = await import('../core/demo-code.js');
  const { DEMO_OWNER_EMAIL } = await import('./demo-seed.js');
  const code = generateDemoCode();
  const revoked = await withGlobal(async (db) => {
    const r = await db.query(
      `update oauth_tokens t set revoked_at = now() from user_emails e
        where e.user_id = t.user_id and lower(e.email::text) = $1 and t.revoked_at is null`, [DEMO_OWNER_EMAIL]);
    await db.query(`insert into admin_audit(actor, action, payload) values ('admin-cli', 'demo_code_issued', $1)`, [{ revoked_tokens: r.rowCount }]);
    return r.rowCount ?? 0;
  });
  process.stdout.write(`код (в портал каталога; здесь показан один раз): ${code}\n`
    + `в /opt/taskano/.env, затем перезапуск web:\nDEMO_LOGIN_EMAIL=${DEMO_OWNER_EMAIL}\nDEMO_LOGIN_CODE_SHA256=${demoCodeHash(code)}\n`
    + `отозвано токенов демо-владельца: ${revoked}\n`);
}

/**
 * Снять ограничения компании, заведённой без инвайт-кода (спека open-signup): писем-приглашений
 * больше, чем 30, и потолок бюджета AI — названный (по умолчанию 20 $). Бюджет не трогаем: его
 * поднимает сам владелец компании до потолка.
 */
async function trustOrg(orgRef: string, cap: number): Promise<void> {
  if (!Number.isFinite(cap) || cap < 0) throw new Error('trust-org <организация> [потолок бюджета $]: потолок — число не меньше 0');
  const org = await findCompany(orgRef);
  await withGlobal(async (db) => {
    await db.query('update orgs set trusted = true, ai_budget_cap_usd = $2 where id = $1', [org.id, cap]);
    await db.query(`insert into admin_audit(actor, action, payload) values ('admin-cli', 'org_trusted', $1)`, [{ org_id: org.id, cap }]);
  });
  process.stdout.write(`компания ${orgRef}: проверенная, потолок бюджета AI $${cap}\n`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'invite-code') await inviteCode(rest[0] ?? '', Number(rest[1] ?? 30));
  else if (cmd === 'provision-client') await provision(rest[0] ?? '', rest[1] ?? '', rest[2], rest[3]);
  else if (cmd === 'create-project') {
    const [orgRef, name, key] = rest;
    if (!orgRef || !name) throw new Error('create-project <организация: id или название> <название проекта> [ключ]');
    await createBoard(orgRef, name, key);
  } else if (cmd === 'project-member') {
    const [orgRef, projectRef, person] = rest;
    if (!orgRef || !projectRef || !person) throw new Error('project-member <организация> <проект> <человек: имя, почта или id> [--remove]');
    await projectMember(orgRef, projectRef, person, rest.includes('--remove'));
  } else if (cmd === 'set-webhook') {
    const { setupWebhook } = await import('../bot/routes.js');
    await setupWebhook();
    process.stdout.write('webhook установлен\n');
  } else if (cmd === 'resend-invitation') {
    const [email, orgRef] = rest;
    if (!email || !orgRef) throw new Error('resend-invitation <email> <организация: id или название>');
    const { withOrg } = await import('../db/pool.js');
    const { resendInvitation } = await import('../core/invitations.js');
    // По id или по названию: названия не уникальны и меняются (`update_org_settings(name)`), поэтому
    // поиск по имени — удобство, а id — единственный надёжный способ назвать организацию.
    const byId = /^[0-9a-f-]{36}$/i.test(orgRef);
    const org = await withGlobal(async (db) => (await db.query(
      byId ? `select id, owner_user_id from orgs where id = $1 and kind = 'company'`
           : `select id, owner_user_id from orgs where lower(name) = lower($1) and kind = 'company'`, [orgRef])).rows);
    if (org.length !== 1) {
      const hint = byId ? '' : ' — назовите организацию по id (её могли переименовать или назвать так же)';
      throw new Error(`организация «${orgRef}»: найдено ${org.length}${hint}`);
    }
    const r = await withOrg(org[0].id, (db) => resendInvitation(db, email, { kind: 'user', userId: org[0].owner_user_id }));
    await withGlobal((db) => db.query(`insert into admin_audit(actor, action, payload) values ('admin-cli', 'invitation_resent', $1)`, [{ email, org: orgRef, org_id: org[0].id }]));
    // Повтор действует по состоянию человека (спека person-presence): вошедшему уходит напоминание про
    // приложение или ничего — печатаем, что именно сделано, а не «отправлено» на всякий случай.
    process.stdout.write(`${r.result}: ${r.sent.length ? r.sent.join(', ') : 'ничего не отправлено'}\n`);
  } else if (cmd === 'demo-reset') {
    // Демо-компания для ревьюера каталога (спека demo-access): снос и наполнение заново, даты — от «сейчас».
    const { demoReset } = await import('./demo-seed.js');
    process.stdout.write(`${JSON.stringify(await demoReset(), null, 2)}\n`);
  } else if (cmd === 'trust-org') {
    if (!rest[0]) throw new Error('trust-org <организация: id или название> [потолок бюджета $]');
    await trustOrg(rest[0], Number(rest[1] ?? 20));
  } else if (cmd === 'demo-code') {
    await demoCode();
  } else if (cmd === 'audit-invite-links') {
    // Только чтение: список для ручной проверки, ничего не отвязывается.
    const { auditInviteLinks } = await import('./invite-links-audit.js');
    const rows = await auditInviteLinks();
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\nподозрительных привязок: ${rows.length}\n`);
  } else if (cmd === 'status') await status();
  else {
    process.stderr.write('Команды: invite-code [заметка] [дней] | provision-client <почта> <компания> [язык] [часовой пояс] | set-webhook | resend-invitation <почта> <организация: id или название> | demo-reset | demo-code | trust-org <организация> [потолок бюджета $] | audit-invite-links | status\n');
    process.exitCode = 2;
  }
}

main().catch((e) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; })
  .finally(() => closePools());
