import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withGlobal, type Db } from '../../db/pool.js';
import { AppError } from '../../core/errors.js';
import { sha256, randomToken } from '../../core/crypto.js';
import { assertTimezone, createCompanyOrg, resolvePersonRef, setPersonAbout } from '../../core/people.js';
import { requireAgentControl, requireActorRole, requireMember, loadAgent } from '../../core/access.js';
import { PEOPLE_DIRECTION } from '../../core/queue.js';
import { env } from '../../config/env.js';
import { notifyProductOwner } from '../../core/product-owner.js';
import { assertPlainName, oneLine } from '../../core/names.js';
import { type CallerCtx, inToolCtx, runTool } from '../context.js';
import { ORG, AGENT } from './orientation.js';

// Группа «Настройка» (спека mcp-and-oauth): организация, агенты, runner, методика, люди в очереди
// и профиль человека «кто он и что закрывает» (спека person-profile).
// Праздников здесь нет: в этой версии рабочий календарь — только дни недели (см. src/core/calendar.ts).

/** quotas/weights: ключ — agentName|agentId|'people' → agent.id|'people'. */
async function normalizeDirectionMap(db: Db, map: Record<string, number> | undefined): Promise<Record<string, number> | undefined> {
  if (!map) return undefined;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(map)) {
    if (key === PEOPLE_DIRECTION || /^[0-9a-f-]{36}$/i.test(key)) { out[key] = value; continue; }
    const agent = await loadAgent(db, key);
    out[agent.id] = value;
  }
  return out;
}

export function registerSetupTools(server: McpServer, caller: CallerCtx): void {
  server.registerTool('create_org', {
    description: 'Create an organization (company) owned by the caller. No invite code is needed; an invite code, if the '
      + 'person has one, is checked and used up. The limit is three organizations per person.',
    inputSchema: { name: z.string().min(1), invite_code: z.string().optional() },
    annotations: { title: 'Create an organization', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (args) => runTool(async () => {
    if (env.internalOnly) throw new AppError('forbidden', 'Taskano is an internal tool: new organizations are not created here');
    const code = args.invite_code?.trim();
    const orgId = await withGlobal(async (db) => {
      // Код передан — человек явно им пользуется: неверный код — отказ, а не тихое создание без него.
      if (code) {
        const codeHash = sha256(code);
        const row = (await db.query(
          'select code_hash, used_by_org, expires_at from product_invite_codes where code_hash = $1 for update', [codeHash],
        )).rows[0];
        if (!row || row.used_by_org || (row.expires_at && new Date(row.expires_at) < new Date())) {
          throw new AppError('forbidden', 'The invite code is invalid or already used');
        }
        const id = await createCompanyOrg(db, caller.userId, args.name);
        await db.query('update product_invite_codes set used_by_org = $2, used_at = now() where code_hash = $1', [codeHash, id]);
        return id;
      }
      // Открытая регистрация (спека open-signup): предохранитель на весь продукт. Замок — чтобы два
      // одновременных входа на пределе не прошли оба.
      await db.query(`select pg_advisory_xact_lock(hashtext('taskano:open-signup'))`);
      const today = (await db.query(
        `select count(*)::int as n from admin_audit where action = 'org_created_open' and at > now() - interval '24 hours'`)).rows[0].n as number;
      if (today >= env.signupOrgsPerDay) {
        throw new AppError('limit_exceeded', 'Taskano is not accepting new companies right now. Try again tomorrow or write to support@taskano.app');
      }
      const id = await createCompanyOrg(db, caller.userId, args.name);
      // Непроверенная: бюджет AI и его потолок — 5 $, писем-приглашений — 30 за всё время, пока
      // владелец продукта не снимет ограничения (`cli.js trust-org`). Спека open-signup.
      await db.query(`update orgs set trusted = false, ai_budget_usd_month = 5, ai_budget_cap_usd = 5 where id = $1`, [id]);
      await db.query(`insert into admin_audit(actor, action, payload) values ('mcp', 'org_created_open', $1)`,
        [{ org_id: id, user_id: caller.userId }]);
      return id;
    });
    if (!code) void notifyProductOwner(`New company without an invite code: ${oneLine(args.name, 100)} (${orgId})`);
    return { org_id: orgId };
  }));

  server.registerTool('update_org_settings', {
    description: 'Organization settings: name, language, time zone, agent working window, glossary, invitation domains, '
      + 'AI budget, timers and autonomy. Owner or admin only.',
    inputSchema: {
      org: ORG, name: z.string().trim().min(1).max(80).optional(), language: z.string().optional(), timezone: z.string().optional(),
      agent_window: z.object({ tz: z.string(), days: z.array(z.number()), start: z.string(), end: z.string() }).optional(),
      glossary: z.array(z.string()).optional(), invite_domains: z.array(z.string()).nullable().optional(),
      ai_budget_usd_month: z.number().nonnegative().optional(),
      timers: z.record(z.string(), z.number()).optional(), autonomy: z.record(z.string(), z.unknown()).optional(),
    },
    annotations: { title: 'Change the settings of the organization', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, { org: args.org }, { write: true, tool: 'update_org_settings' }, async ({ db, userId }) => {
    await requireMember(db, userId, ['owner', 'admin']);
    if (args.timezone) assertTimezone(args.timezone);
    if (args.agent_window) assertTimezone(args.agent_window.tz);
    if (args.ai_budget_usd_month !== undefined) {
      // Потолок держит владелец продукта: бюджет — его деньги на Anthropic (спека open-signup).
      const cap = Number((await db.query(`select ai_budget_cap_usd from orgs where id = current_setting('app.org_id')::uuid`)).rows[0].ai_budget_cap_usd);
      if (args.ai_budget_usd_month > cap) {
        throw new AppError('limit_exceeded', `The AI budget of this organization can be at most $${cap} a month. Write to support@taskano.app to raise the limit`);
      }
    }
    const cols: Record<string, unknown> = {
      name: args.name === undefined ? undefined : assertPlainName(args.name, 'Organization name', 80), language: args.language, timezone: args.timezone,
      agent_window: args.agent_window ? JSON.stringify(args.agent_window) : undefined,
      glossary: args.glossary, invite_domains: args.invite_domains, ai_budget_usd_month: args.ai_budget_usd_month,
    };
    const entries = Object.entries(cols).filter(([, v]) => v !== undefined);
    if (entries.length) {
      const sets = entries.map(([k], i) => `${k} = $${i + 1}`);
      await db.query(`update orgs set ${sets.join(', ')} where id = current_setting('app.org_id')::uuid`, entries.map(([, v]) => v));
    }
    if (args.timers || args.autonomy) {
      const patch: Record<string, unknown> = {};
      if (args.timers) patch.timers = args.timers;
      if (args.autonomy) patch.autonomy = args.autonomy;
      await db.query(`update orgs set settings = settings || $1::jsonb where id = current_setting('app.org_id')::uuid`, [JSON.stringify(patch)]);
    }
    return { ok: true };
  })));

  server.registerTool('create_agent', {
    description: 'Create an agent (an area of work) in the organization. The owner defaults to the caller. Owner or admin only.',
    inputSchema: { org: ORG, name: z.string().min(1), description: z.string().optional(), owner: z.string().optional() },
    annotations: { title: 'Create an agent', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, { org: args.org }, { write: true, tool: 'create_agent' }, async ({ db, userId }) => {
    await requireMember(db, userId, ['owner', 'admin']);
    const ownerUserId = args.owner ? await resolvePersonRef(db, args.owner) : userId;
    const r = await db.query(
      `insert into agents(org_id, name, description, owner_user_id) values (current_setting('app.org_id')::uuid, $1, $2, $3) returning *`,
      [args.name.trim(), args.description ?? '', ownerUserId],
    );
    return r.rows[0];
  })));

  server.registerTool('update_agent', {
    description: 'Change an agent: pause/resume, description, permissions. Allowed for the owner of the agent or an owner/admin of the organization.',
    inputSchema: {
      org: ORG, agent: z.string().min(1), status: z.enum(['active', 'paused']).optional(),
      description: z.string().optional(), permissions: z.record(z.string(), z.unknown()).optional(),
    },
    annotations: { title: 'Change an agent', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, { org: args.org }, { write: true, tool: 'update_agent' }, async ({ db, userId }) => {
    // Запись, а не чтение: меняются статус, описание и права агента. `agent` из аргументов сюда не
    // передаётся намеренно — это тот, КОГО меняют, а не тот, ОТ ЧЬЕГО имени идёт вызов; иначе
    // снятого с паузы агента было бы не вернуть в работу (ограничитель «агент на паузе»).
    const agent = await requireAgentControl(db, args.agent, userId);
    const cols: Record<string, unknown> = {
      status: args.status, description: args.description,
      permissions: args.permissions ? JSON.stringify(args.permissions) : undefined,
    };
    const entries = Object.entries(cols).filter(([, v]) => v !== undefined);
    if (entries.length) {
      const sets = entries.map(([k], i) => `${k} = $${i + 2}`);
      await db.query(`update agents set ${sets.join(', ')} where id = $1`, [agent.id, ...entries.map(([, v]) => v)]);
    }
    return (await db.query('select * from agents where id = $1', [agent.id])).rows[0];
  })));

  server.registerTool('connect_runner', {
    description: 'A one-time link to the runner connection page (where the fire URL and the token are entered). '
      + 'Valid for 30 minutes. Owner or admin only.',
    inputSchema: { org: ORG },
    annotations: { title: 'Connect the routine runner', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'connect_runner' }, async ({ db, userId, orgId }) => {
    await requireMember(db, userId, ['owner', 'admin']);
    const token = randomToken();
    await db.query(
      `insert into runner_links(token_hash, org_id, created_by, expires_at) values ($1, $2, $3, now() + interval '30 minutes')`,
      [sha256(token), orgId, userId],
    );
    return { url: `${env.publicUrl}/runner/${token}` };
  })));

  server.registerTool('get_setup_status', {
    description: 'Setup status: whether there are agents, people in Telegram, whether the runner is connected, whether there is at least one task from an agent.',
    inputSchema: { org: ORG },
    annotations: { title: 'Setup status', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: false, tool: 'get_setup_status' }, async ({ db }) => {
    const agents = await db.query('select count(*)::int as n from agents');
    const peopleInTelegram = await db.query(
      `select count(*)::int as n from memberships m join telegram_links tl on tl.user_id = m.user_id where m.status = 'active'`);
    const runner = await db.query(`select status from runners where org_id = current_setting('app.org_id')::uuid`);
    const agentTask = await db.query(`select count(*)::int as n from tasks where author_agent_id is not null`);
    return {
      has_org: true, agents: agents.rows[0].n, people_in_telegram: peopleInTelegram.rows[0].n,
      runner_connected: runner.rows[0]?.status === 'ok', has_agent_task: agentTask.rows[0].n > 0,
    };
  })));

  server.registerTool('get_playbook', {
    description: 'The way this organization works (the playbook): its text and when it was last changed. Empty when nobody has written it.',
    inputSchema: { org: ORG },
    annotations: { title: 'The playbook of the organization', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: false, tool: 'get_playbook' }, async ({ db }) => {
    const r = await db.query(`select text, updated_at from playbooks where org_id = current_setting('app.org_id')::uuid`);
    return r.rows[0] ?? { text: '', updated_at: null };
  })));

  server.registerTool('set_playbook', {
    description: 'Record the way this organization works (the playbook) — the whole text at once, replacing the previous one. '
      + 'Every agent of the organization reads it, so only an owner or an admin writes it.',
    inputSchema: { org: ORG, agent: AGENT, text: z.string() },
    annotations: { title: 'Write the playbook', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, args, { write: true, tool: 'set_playbook' }, async ({ db, actor }) => {
    // Методику каждый агент организации читает как указание к работе — переписать её может только
    // тот, кто за компанию отвечает (спека roles-and-rights).
    await requireActorRole(db, actor, ['owner', 'admin']);
    await db.query(
      `insert into playbooks(org_id, text) values (current_setting('app.org_id')::uuid, $1)
       on conflict (org_id) do update set text = excluded.text, updated_at = now()`,
      [args.text],
    );
    return { ok: true };
  })));

  server.registerTool('set_person_settings', {
    description: 'Settings of a person in the organization: about — who they are and what they close (their trade, what they '
      + 'are good at, what not to give them, what they already know; null — erase it), name (as they are seen in emails and '
      + 'notifications), mode, quotas and weights across areas, daily step limit, working hours and country. '
      + 'Quotas, limits, working hours and the settings of another person — owner or admin only; '
      + 'about and their own name a person changes for themselves, and about from an agent is refused: '
      + 'it is the words of people about people. about is then shown in the list of people and in the review of the person.',
    inputSchema: {
      org: ORG, person: z.string().min(1), name: z.string().trim().min(1).max(80).optional(), mode: z.enum(['lead', 'self']).optional(),
      about: z.string().nullable().optional().describe('A paragraph in the words of people, up to 2000 characters; null — erase'),
      quotas: z.record(z.string(), z.number()).optional(), weights: z.record(z.string(), z.number()).optional(),
      daily_step_limit: z.number().int().positive().optional(), work_days: z.array(z.number().int().min(1).max(7)).optional(),
      work_start: z.string().optional(), work_end: z.string().optional(), timezone: z.string().optional(), country: z.string().optional(),
    },
    annotations: { title: 'Change the settings and the profile of a person', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, (args) => runTool(() => inToolCtx(caller, { org: args.org }, { write: true, tool: 'set_person_settings' }, async ({ db, userId, actor }) => {
    const personId = await resolvePersonRef(db, args.person);
    if (args.timezone) assertTimezone(args.timezone);
    // Право спрашивается по полю, а не по имени инструмента (спека connector-surface): профиль о
    // человеке и своё имя пишет сам человек, квоты и рабочие часы — тот, кто распоряжается компанией.
    // Права самого профиля проверяет setPersonAbout: агенту он не доверен ни в каком случае.
    const own = ['org', 'person', 'name', 'about'];
    const ownOnly = personId === userId && Object.entries(args).every(([k, v]) => own.includes(k) || v === undefined);
    const aboutOnly = Object.entries(args).every(([k, v]) => ['org', 'person', 'about'].includes(k) || v === undefined);
    await requireMember(db, userId, ownOnly || aboutOnly ? undefined : ['owner', 'admin']);
    // Имя, пояс, рабочие дни и часы, страна лежат в общей `users` — это человек целиком, а не его
    // место в компании. Чужие их меняет владелец или админ, только если человек больше ни в одной
    // компании не состоит: иначе посторонний с открытой регистрацией приглашал сотрудника чужой
    // компании и переписывал ему часы и имя (ревью диффа open-signup).
    const shared = ['name', 'work_days', 'work_start', 'work_end', 'timezone', 'country'].some((k) => (args as Record<string, unknown>)[k] !== undefined);
    if (shared && personId !== userId) {
      const elsewhere = (await db.query(
        `select 1 from memberships m join orgs o on o.id = m.org_id
          where m.user_id = $1 and o.kind = 'company' and m.status in ('active', 'invited')
            and m.org_id <> current_setting('app.org_id')::uuid limit 1`, [personId])).rowCount;
      if (elsewhere) {
        throw new AppError('forbidden', 'This person also works in another organization: their name, time zone, working days and hours '
          + 'are theirs to change, from the Taskano app');
      }
    }
    if (args.about !== undefined) await setPersonAbout(db, personId, args.about, actor);
    if (args.name) await db.query('update users set display_name = $2 where id = $1', [personId, assertPlainName(args.name, 'name', 60)]);
    if (args.mode) {
      await db.query(`update memberships set mode = $2 where org_id = current_setting('app.org_id')::uuid and user_id = $1`, [personId, args.mode]);
    }
    const quotas = await normalizeDirectionMap(db, args.quotas);
    const weights = await normalizeDirectionMap(db, args.weights);
    if (quotas || weights || args.daily_step_limit !== undefined) {
      await db.query(
        `insert into queue_settings(org_id, user_id, quotas, weights, daily_step_limit)
         values (current_setting('app.org_id')::uuid, $1, coalesce($2::jsonb, '{}'::jsonb), coalesce($3::jsonb, '{}'::jsonb), coalesce($4, 20))
         on conflict (org_id, user_id) do update set
           quotas = coalesce($2::jsonb, queue_settings.quotas), weights = coalesce($3::jsonb, queue_settings.weights),
           daily_step_limit = coalesce($4, queue_settings.daily_step_limit)`,
        [personId, quotas ? JSON.stringify(quotas) : null, weights ? JSON.stringify(weights) : null, args.daily_step_limit ?? null],
      );
    }
    const userCols: Record<string, unknown> = {
      work_days: args.work_days, work_start: args.work_start, work_end: args.work_end, timezone: args.timezone, country: args.country,
    };
    const entries = Object.entries(userCols).filter(([, v]) => v !== undefined);
    if (entries.length) {
      const sets = entries.map(([k], i) => `${k} = $${i + 2}`);
      await db.query(`update users set ${sets.join(', ')} where id = $1`, [personId, ...entries.map(([, v]) => v)]);
    }
    return { ok: true };
  })));

}
