import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import './helpers.js';
import { closePools, withGlobal, withSystem } from '../src/db/pool.js';
import { createApp } from '../src/web/app.js';
import { miniappRoutes } from '../src/web/miniapp-api.js';
import { createTask } from '../src/core/tasks.js';
import { createProject } from '../src/core/projects.js';
import { addMember } from '../src/core/people.js';
import { issueReadToken } from '../src/core/read-tokens.js';
import {
  AGENT_TOKEN_DAILY_LIMIT, AGENT_TOKEN_LIMIT, issueAgentToken, revokeAgentToken, verifyAgentToken,
} from '../src/core/agent-tokens.js';
import { AGENT_TOKEN_TOOLS } from '../src/mcp/server.js';
import { inToolCtx } from '../src/mcp/context.js';
import { addPerson, inOrg, makeAgent, makeOrg, MON_10, uniq } from './helpers.js';

// Токен агента для серверной программы (спека agent-tokens): шесть инструментов /mcp от имени одного
// агента одной организации. Проверяем через те же входы, что зовут программа и приложение, на одном
// приложении целиком — чтобы видеть и закрепление, и то, что соседние входы токен не принимают.

afterAll(closePools);

const BOT_TOKEN = 'test-bot-token-agent-tokens';
const app = createApp({ extraRoutes: (a) => miniappRoutes(a, { botToken: BOT_TOKEN }) });
const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };
const user = (userId: string) => ({ kind: 'user' as const, userId });

let tgSeq = 1_400_000_000;

function initDataFor(telegramUserId: number, ageSeconds = 0): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000) - ageSeconds),
    user: JSON.stringify({ id: telegramUserId, first_name: 'Test' }),
  });
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

async function linkTelegram(userId: string): Promise<number> {
  const tg = (tgSeq += 1);
  await withGlobal((db) => db.query(
    `insert into telegram_links(user_id, telegram_user_id, chat_id) values ($1, $2, $3)`, [userId, tg, tg]));
  return tg;
}

/**
 * Свой адрес на каждый запрос: неудачи считаются по адресу, и десяток проверок «→ 401» в одном файле
 * иначе упёрся бы в потолок неудач сам о себя. Проверка потолка задаёт адрес явно.
 */
const randomIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;

function mcp(token: string, body: Record<string, unknown>, ip = randomIp()) {
  return request(app).post('/mcp').set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', ip)
    .set('Accept', 'application/json, text/event-stream').send({ jsonrpc: '2.0', id: 1, ...body });
}

async function tool(token: string, name: string, args: Record<string, unknown> = {}): Promise<{ status: number; isError: boolean; data: any }> {
  const r = await mcp(token, { method: 'tools/call', params: { name, arguments: args } });
  if (r.status !== 200) return { status: r.status, isError: true, data: r.body };
  const result = r.body.result;
  if (!result) return { status: r.status, isError: true, data: r.body.error };
  const text = result.content[0].text as string;
  let data: any;
  try { data = JSON.parse(text); } catch { data = { message: text }; }
  return { status: r.status, isError: Boolean(result.isError), data };
}

const taskArgs = (assignee: string, extra: Record<string, unknown> = {}) => ({
  title: `сверить остатки ${uniq()}`, assignee, why: 'зачем', done_criteria: 'критерий', due_date: '2026-12-31',
  description: 'как делать: открыть таблицу и свериться', idempotency_key: randomUUID(),
  source: { kind: 'chat', title: 'сторож склада', quote: 'этап не двигается' }, ...extra,
});

/** Компания с владельцем, исполнителем и агентом владельца; токен выпущен владельцем. */
async function world() {
  const { orgId, ownerId } = await makeOrg();
  const member = await addPerson(orgId, 'member');
  const agentName = `wh-${uniq()}`;
  const agentId = await makeAgent(orgId, ownerId, agentName);
  const issued = await issueAgentToken(orgId, ownerId, agentId, 'сервер склада');
  const orgName = (await withGlobal((db) => db.query('select name from orgs where id = $1', [orgId]))).rows[0].name as string;
  return { orgId, orgName, ownerId, member, agentId, agentName, token: issued.token, tokenId: issued.id };
}

describe('токен агента — /mcp (спека agent-tokens)', () => {
  it('tools/list — ровно шесть инструментов; остальные — «unknown tool»', async () => {
    const w = await world();
    const r = await mcp(w.token, { method: 'tools/list' });
    expect(r.status).toBe(200);
    const names = (r.body.result.tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual([...AGENT_TOKEN_TOOLS].sort());
    expect(names).toHaveLength(6);
    for (const name of ['update_task', 'send_announcement', 'create_org', 'get_briefing']) {
      const call = await tool(w.token, name, {});
      expect(call.isError, name).toBe(true);
      expect(JSON.stringify(call.data), name).toMatch(/not found/i);
    }
  });

  it('create_task от имени агента (журнал с токеном), get_task и find_task её читают; raise_alert и resolve_alert', async () => {
    const w = await world();
    const created = await tool(w.token, 'create_task', taskArgs(w.member));
    expect(created.isError, JSON.stringify(created.data)).toBe(false);
    expect(created.data.author_agent_id).toBe(w.agentId);
    const audit = (await inOrg(w.orgId, (db) => db.query(
      `select agent_id, user_id, agent_token_id from agent_audit where tool = 'create_task' and org_id = $1`, [w.orgId]))).rows;
    expect(audit).toEqual([{ agent_id: w.agentId, user_id: w.ownerId, agent_token_id: w.tokenId }]);
    // Событие дела — от агента, как у любого действия агента.
    const ev = (await inOrg(w.orgId, (db) => db.query(
      `select actor_agent_id from events where task_id = $1 and type = 'task_created'`, [created.data.id]))).rows;
    expect(ev.every((e) => e.actor_agent_id === w.agentId)).toBe(true);

    const got = await tool(w.token, 'get_task', { task: created.data.id });
    expect(got.isError, JSON.stringify(got.data)).toBe(false);
    expect(got.data.task?.id ?? got.data.id).toBe(created.data.id);
    const found = await tool(w.token, 'find_task', { query: created.data.title.split(' ').at(-1) });
    expect(found.isError, JSON.stringify(found.data)).toBe(false);
    expect(JSON.stringify(found.data)).toContain(created.data.id);

    // org — тем же id и тем же именем, agent — тем же id и тем же именем: работают.
    expect((await tool(w.token, 'get_task', { task: created.data.id, org: w.orgId, agent: w.agentId })).isError).toBe(false);
    expect((await tool(w.token, 'get_task', { task: created.data.id, org: w.orgName, agent: w.agentName.toUpperCase() })).isError).toBe(false);

    const key = `shipment-stage:${uniq()}`;
    const raised = await tool(w.token, 'raise_alert', { key, text: 'Заказ стоит в «в пути» третий день', to: 'all' });
    expect(raised.isError, JSON.stringify(raised.data)).toBe(false);
    expect(raised.data.created).toBe(true);
    const status = await tool(w.token, 'announcement_status', {});
    expect(status.isError, JSON.stringify(status.data)).toBe(false);
    expect(status.data.alerts.some((a: { id: string; status: string }) => a.id === raised.data.alert_id && a.status === 'open')).toBe(true);
    const resolved = await tool(w.token, 'resolve_alert', { key, reason: 'этап сдвинулся' });
    expect(resolved.isError, JSON.stringify(resolved.data)).toBe(false);
    expect(resolved.data).toEqual({ resolved: true, alert_id: raised.data.alert_id });
    const tokens = (await inOrg(w.orgId, (db) => db.query(
      `select tool, agent_token_id from agent_audit where org_id = $1 and tool in ('raise_alert', 'resolve_alert')`, [w.orgId]))).rows;
    expect(tokens).toHaveLength(2);
    expect(tokens.every((t) => t.agent_token_id === w.tokenId)).toBe(true);
  });

  it('чужая организация, "personal", чужой агент, share_with → forbidden ответом инструмента, не 500', async () => {
    const w = await world();
    // Хозяин агента состоит и в другой компании: без закрепления resolveOrg её бы нашёл.
    const other = await makeOrg(w.ownerId);
    const otherAgent = await makeAgent(w.orgId, w.ownerId, `other-${uniq()}`);
    const forbidden = async (name: string, args: Record<string, unknown>) => {
      const r = await tool(w.token, name, args);
      expect(r.status, `${name} ${JSON.stringify(args)}`).toBe(200);
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(r.data.code, `${name} ${JSON.stringify(args)}`).toBe('forbidden');
    };
    await forbidden('create_task', taskArgs(w.member, { org: other.orgId }));
    await forbidden('create_task', taskArgs(w.member, { org: 'personal' }));
    await forbidden('create_task', taskArgs(w.member, { agent: otherAgent }));
    await forbidden('create_task', taskArgs(w.member, { share_with: w.orgId }));
    await forbidden('create_task', taskArgs(w.member, { share_with: null }));
    await forbidden('find_task', { org: other.orgId });
    await forbidden('find_task', { org: 'personal' });
    await forbidden('raise_alert', { key: 'k', text: 't', to: 'all', agent: otherAgent });
    await forbidden('announcement_status', { org: 'нет такой' });
    // Ничего не создано ни там, ни там.
    const n = (await inOrg(w.orgId, (db) => db.query('select count(*)::int as n from tasks'))).rows[0].n;
    expect(n).toBe(0);
    expect((await inOrg(other.orgId, (db) => db.query('select count(*)::int as n from tasks'))).rows[0].n).toBe(0);
  });

  it('find_task без org не выходит в другую компанию хозяина агента; закрытая доска хозяина не видна', async () => {
    const w = await world();
    const word = `сейф${uniq()}`;
    const other = await makeOrg(w.ownerId);
    await inOrg(other.orgId, (db) => createTask(db, { ...base, title: `${word} в другой компании`, assigneeUserId: w.ownerId }, user(w.ownerId), MON_10), w.ownerId);
    const secret = await inOrg(w.orgId, (db) => createProject(db, { name: `Найм ${uniq()}`, private: true }, user(w.ownerId)), w.ownerId);
    const hidden = await inOrg(w.orgId, (db) => createTask(db, { ...base, title: `${word} оффер`, assigneeUserId: w.ownerId, project: secret.id }, user(w.ownerId), MON_10), w.ownerId);
    const open = await inOrg(w.orgId, (db) => createTask(db, { ...base, title: `${word} общее`, assigneeUserId: w.member }, user(w.ownerId), MON_10), w.ownerId);

    const found = await tool(w.token, 'find_task', { query: word });
    expect(found.isError, JSON.stringify(found.data)).toBe(false);
    const text = JSON.stringify(found.data);
    expect(text).toContain(open.id);
    expect(text).not.toContain(hidden.id);
    expect(text).not.toContain('в другой компании');
    const peek = await tool(w.token, 'get_task', { task: hidden.id });
    expect(peek.isError).toBe(true);
    expect(peek.data.code).toBe('not_found');
  });

  it('агент на паузе: запись запрещена (agent_paused), чтение работает', async () => {
    const w = await world();
    await inOrg(w.orgId, (db) => db.query(`update agents set status = 'paused' where id = $1`, [w.agentId]));
    const write = await tool(w.token, 'create_task', taskArgs(w.member));
    expect(write.data.code).toBe('agent_paused');
    expect((await tool(w.token, 'find_task', {})).isError).toBe(false);
  });

  it('отозванный, истёкший, неизвестный, испорченный → 401', async () => {
    const w = await world();
    expect((await mcp(w.token, { method: 'tools/list' })).status).toBe(200);
    await revokeAgentToken(w.orgId, w.ownerId, w.tokenId);
    expect((await mcp(w.token, { method: 'tools/list' })).status).toBe(401);

    const w2 = await world();
    await withGlobal((db) => db.query(
      `update agent_tokens set created_at = now() - interval '400 days', expires_at = now() - interval '1 minute' where id = $1`, [w2.tokenId]));
    expect((await mcp(w2.token, { method: 'tools/list' })).status).toBe(401);
    expect(await verifyAgentToken(w2.token)).toBeNull();

    expect((await mcp(`tka_${randomBytes(32).toString('base64url')}`, { method: 'tools/list' })).status).toBe(401);
    expect((await mcp('tka_short', { method: 'tools/list' })).status).toBe(401);
    expect((await mcp(`tka_${'A'.repeat(300)}`, { method: 'tools/list' })).status).toBe(401);
  });

  it('агент удалён; выпустивший стал админом или анонимизирован; хозяин агента вышел или анонимизирован → 401', async () => {
    const tools = (token: string) => mcp(token, { method: 'tools/list' });

    const gone = await world();
    await inOrg(gone.orgId, (db) => db.query('delete from agents where id = $1', [gone.agentId]));
    expect((await tools(gone.token)).status).toBe(401);

    // Выпустивший — владелец; стал админом — токен мёртв, вернули владение — снова жив (проверка на каждом запросе).
    const demoted = await world();
    const heir = await addPerson(demoted.orgId, 'admin');
    expect((await tools(demoted.token)).status).toBe(200);
    await withGlobal(async (db) => {
      await db.query(`update memberships set role = 'owner' where org_id = $1 and user_id = $2`, [demoted.orgId, heir]);
      await db.query(`update memberships set role = 'admin' where org_id = $1 and user_id = $2`, [demoted.orgId, demoted.ownerId]);
    });
    expect((await tools(demoted.token)).status).toBe(401);

    // Выпустивший анонимизирован, а хозяин агента — другой человек и на месте.
    const anon = await makeOrg();
    const keeper = await addPerson(anon.orgId, 'admin');
    const anonAgent = await makeAgent(anon.orgId, keeper);
    const anonToken = await issueAgentToken(anon.orgId, anon.ownerId, anonAgent, 'склад');
    expect((await tools(anonToken.token)).status).toBe(200);
    await withGlobal((db) => db.query('update users set anonymized_at = now() where id = $1', [anon.ownerId]));
    expect((await tools(anonToken.token)).status).toBe(401);

    // Хозяин агента — админ, выпустил владелец: админа вывели из компании — токен мёртв.
    const { orgId, ownerId } = await makeOrg();
    const admin = await addPerson(orgId, 'admin');
    const agentId = await makeAgent(orgId, admin);
    const t = await issueAgentToken(orgId, ownerId, agentId, 'склад');
    expect((await tools(t.token)).status).toBe(200);
    await withGlobal((db) => db.query(`update memberships set status = 'removed' where org_id = $1 and user_id = $2`, [orgId, admin]));
    expect((await tools(t.token)).status).toBe(401);

    const agentId2 = await makeAgent(orgId, ownerId);
    const admin2 = await addPerson(orgId, 'admin');
    await inOrg(orgId, (db) => db.query('update agents set owner_user_id = $2 where id = $1', [agentId2, admin2]));
    const t2 = await issueAgentToken(orgId, ownerId, agentId2, 'склад-2');
    expect((await tools(t2.token)).status).toBe(200);
    await withGlobal((db) => db.query('update users set anonymized_at = now() where id = $1', [admin2]));
    expect((await tools(t2.token)).status).toBe(401);
  });

  it('погасший токен гаснет навсегда: вернули человека или владение — токен не оживает (ревью 22.10)', async () => {
    const tools = (token: string) => mcp(token, { method: 'tools/list' });
    const revokedAt = async (id: string) => (await withSystem((db) => db.query(
      'select revoked_at from agent_tokens where id = $1', [id]))).rows[0].revoked_at as Date | null;

    // Хозяина агента вывели и вернули.
    const { orgId, ownerId } = await makeOrg();
    const admin = await addPerson(orgId, 'admin');
    const agentId = await makeAgent(orgId, admin);
    const t = await issueAgentToken(orgId, ownerId, agentId, 'склад');
    await withGlobal((db) => db.query(`update memberships set status = 'removed' where org_id = $1 and user_id = $2`, [orgId, admin]));
    expect(await revokedAt(t.id)).not.toBeNull();
    await withGlobal((db) => db.query(`update memberships set status = 'active' where org_id = $1 and user_id = $2`, [orgId, admin]));
    expect((await tools(t.token)).status).toBe(401);

    // Выпустившего понизили до админа и вернули владение.
    const w = await world();
    await withGlobal((db) => db.query(`update memberships set role = 'admin' where org_id = $1 and user_id = $2`, [w.orgId, w.ownerId]));
    expect(await revokedAt(w.tokenId)).not.toBeNull();
    await withGlobal((db) => db.query(`update memberships set role = 'owner' where org_id = $1 and user_id = $2`, [w.orgId, w.ownerId]));
    expect((await tools(w.token)).status).toBe(401);

    // Агенту сменили хозяина и вернули прежнего.
    const v = await world();
    const other = await addPerson(v.orgId, 'admin');
    await inOrg(v.orgId, (db) => db.query('update agents set owner_user_id = $2 where id = $1', [v.agentId, other]));
    expect(await revokedAt(v.tokenId)).not.toBeNull();
    await inOrg(v.orgId, (db) => db.query('update agents set owner_user_id = $2 where id = $1', [v.agentId, v.ownerId]));
    expect((await tools(v.token)).status).toBe(401);

    // Анонимизация — тоже отметка в базе, а не только проверка на запросе.
    const a = await world();
    await withGlobal((db) => db.query('update users set anonymized_at = now() where id = $1', [a.ownerId]));
    expect(await revokedAt(a.tokenId)).not.toBeNull();

    // Чужой действующий токен той же компании событие соседа не гасит.
    const s = await world();
    const peer = await addPerson(s.orgId, 'member');
    await withGlobal((db) => db.query(`update memberships set status = 'removed' where org_id = $1 and user_id = $2`, [s.orgId, peer]));
    expect(await revokedAt(s.tokenId)).toBeNull();
    expect((await tools(s.token)).status).toBe(200);
  });

  it('приложение токен не удаляет — только отзывает: след в agent_audit не обнулить', async () => {
    const w = await world();
    await expect(withGlobal((db) => db.query('delete from agent_tokens where id = $1', [w.tokenId])))
      .rejects.toThrow(/permission denied/);
  });

  it('вторая стена — inToolCtx: закреплённый вызов не уходит в другую организацию и к другому агенту', async () => {
    const w = await world();
    const other = await makeOrg(w.ownerId);
    const otherAgent = await makeAgent(w.orgId, w.ownerId);
    const caller = { userId: w.ownerId, pin: { orgId: w.orgId, agentId: w.agentId, tokenId: w.tokenId } };
    const run = (args: { org?: string; agent?: string }) => inToolCtx(caller, args, { write: false, tool: 'get_task' }, async (ctx) => ctx.orgId);
    await expect(run({ org: other.orgId, agent: w.agentId })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(run({ org: w.orgId })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(run({ org: w.orgId, agent: otherAgent })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(run({ org: w.orgId, agent: w.agentId })).resolves.toBe(w.orgId);
  });

  it('вызов идёт от имени хозяина агента: его роль, его организация', async () => {
    const { orgId, ownerId } = await makeOrg();
    const member = await addPerson(orgId, 'member');
    // Агент рядового: тревоги — только владельцу и админу, и токен этого не обходит.
    const agentId = await makeAgent(orgId, member);
    const t = await issueAgentToken(orgId, ownerId, agentId, 'склад');
    const r = await tool(t.token, 'raise_alert', { key: `k-${uniq()}`, text: 'стоит', to: 'all' });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe('forbidden');
  });

  it('чужие токены: tkr_ на /mcp → 401; tka_ на /api/read и в Mini App → 401', async () => {
    const w = await world();
    const { token: readToken } = await issueReadToken(w.ownerId, 'ноутбук');
    expect((await mcp(readToken, { method: 'tools/list' })).status).toBe(401);
    expect((await request(app).get('/api/read/orgs').set('Authorization', `Bearer ${w.token}`)).status).toBe(401);
    await linkTelegram(w.ownerId);
    expect((await request(app).get('/app/api/lists').set('X-Telegram-Init-Data', w.token)).status).toBe(401);
    expect((await request(app).get('/app/api/lists').set('Authorization', `Bearer ${w.token}`)).status).toBe(401);
    expect((await request(app).get(`/app/api/agent-tokens?org=${w.orgId}`).set('Authorization', `Bearer ${w.token}`)).status).toBe(401);
  });

  it('потолок неудач по адресу: упёрся — 429 и в базу не ходит, даже с настоящим токеном', async () => {
    const w = await world();
    const ip = randomIp();
    const junk = `tka_${randomBytes(32).toString('base64url')}`;
    for (let i = 0; i < 30; i++) expect((await mcp(junk, { method: 'tools/list' }, ip)).status).toBe(401);
    expect((await mcp(junk, { method: 'tools/list' }, ip)).status).toBe(429);
    expect((await mcp(w.token, { method: 'tools/list' }, ip)).status).toBe(429);
    // Другой адрес работает.
    expect((await mcp(w.token, { method: 'tools/list' })).status).toBe(200);
  });

  it('потолок — 120 запросов в минуту на токен → 429; другой токен считается отдельно', async () => {
    const w = await world();
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await mcp(w.token, { method: 'tools/list' })).status;
    expect(last).toBe(429);
    const other = await issueAgentToken(w.orgId, w.ownerId, w.agentId, 'второй');
    expect((await mcp(other.token, { method: 'tools/list' })).status).toBe(200);
  });
});

describe('токен агента — выпуск и пределы (спека agent-tokens)', () => {
  it('в базе только sha256; не больше 3 действующих на агента, в том числе при одновременном выпуске', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agentId = await makeAgent(orgId, ownerId);
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => issueAgentToken(orgId, ownerId, agentId, `t${i}`)));
    const issued = results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof issueAgentToken>>>).value);
    expect(issued).toHaveLength(AGENT_TOKEN_LIMIT);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'limit_exceeded')).toBe(true);
    const rows = (await withGlobal((db) => db.query(`select to_jsonb(t)::text as row, token_hash from agent_tokens t where org_id = $1`, [orgId]))).rows;
    expect(rows).toHaveLength(AGENT_TOKEN_LIMIT);
    for (const { token } of issued) {
      expect(token).toMatch(/^tka_[A-Za-z0-9_-]{43}$/);
      const hash = createHash('sha256').update(token).digest('hex');
      expect(rows.some((r) => r.token_hash === hash)).toBe(true);
      expect(rows.some((r) => (r.row as string).includes(token) || (r.row as string).includes(token.slice(4)))).toBe(false);
    }
    // Другой агент той же компании — свой счёт.
    await expect(issueAgentToken(orgId, ownerId, await makeAgent(orgId, ownerId), 'другой')).resolves.toMatchObject({ token: expect.stringMatching(/^tka_/) });
    // Отозвал один — можно выпустить снова.
    await revokeAgentToken(orgId, ownerId, issued[0]!.id);
    await expect(issueAgentToken(orgId, ownerId, agentId, 'вместо')).resolves.toMatchObject({ token: expect.stringMatching(/^tka_/) });
  });

  it('не больше 20 выпусков в сутки на компанию — вместе с отозванными', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agentId = await makeAgent(orgId, ownerId);
    for (let i = 0; i < AGENT_TOKEN_DAILY_LIMIT; i++) {
      const t = await issueAgentToken(orgId, ownerId, agentId, `t${i}`);
      await revokeAgentToken(orgId, ownerId, t.id);
    }
    await expect(issueAgentToken(orgId, ownerId, agentId, 'лишний')).rejects.toMatchObject({ code: 'limit_exceeded' });
    // Другая компания — свой счёт.
    const other = await makeOrg(ownerId);
    await expect(issueAgentToken(other.orgId, ownerId, await makeAgent(other.orgId, ownerId), 'x')).resolves.toBeTruthy();
  });

  it('срок — 365 дней; агент другой компании → not_found; не владелец → forbidden', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agentId = await makeAgent(orgId, ownerId);
    const t = await issueAgentToken(orgId, ownerId, agentId, 'год');
    const days = (new Date(t.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(364.9);
    expect(days).toBeLessThan(365.1);

    const stranger = await makeOrg();
    const theirAgent = await makeAgent(stranger.orgId, stranger.ownerId);
    await expect(issueAgentToken(orgId, ownerId, theirAgent, 'чужой')).rejects.toMatchObject({ code: 'not_found' });
    await expect(issueAgentToken(stranger.orgId, ownerId, theirAgent, 'чужой')).rejects.toMatchObject({ code: 'forbidden' });
    const admin = await addPerson(orgId, 'admin');
    await expect(issueAgentToken(orgId, admin, agentId, 'админ')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(revokeAgentToken(orgId, admin, t.id)).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('токен агента — Mini App (спека agent-tokens)', () => {
  it('выпуск возвращает токен один раз; список без токена, с агентом, сроком и «пользовались»; отзыв работает', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agentName = `wh-${uniq()}`;
    const agentId = await makeAgent(orgId, ownerId, agentName);
    const tg = await linkTelegram(ownerId);
    const mini = (r: request.Test) => r.set('X-Telegram-Init-Data', initDataFor(tg));

    expect((await mini(request(app).post('/app/api/agent-tokens').send({ org: orgId, agent: agentId, label: '  ' }))).status).toBe(400);
    const issued = await mini(request(app).post('/app/api/agent-tokens').send({ org: orgId, agent: agentId, label: 'сервер склада' }));
    expect(issued.status).toBe(200);
    expect(issued.body.token).toMatch(/^tka_[A-Za-z0-9_-]{43}$/);
    expect(issued.body.expires_at).toBeTruthy();
    expect(issued.headers['cache-control']).toBe('no-store');

    const list = await mini(request(app).get(`/app/api/agent-tokens?org=${orgId}`));
    expect(list.status).toBe(200);
    expect(list.body).toEqual([expect.objectContaining({
      id: issued.body.id, label: 'сервер склада', agent_id: agentId, agent_name: agentName,
      expires_at: issued.body.expires_at, last_used_at: null, created_at: expect.any(String),
    })]);
    expect(list.body[0].token).toBeUndefined();
    expect(JSON.stringify(list.body)).not.toContain(issued.body.token);

    expect((await mcp(issued.body.token, { method: 'tools/list' })).status).toBe(200);
    const used = await mini(request(app).get(`/app/api/agent-tokens?org=${orgId}`));
    expect(used.body[0].last_used_at).not.toBeNull();

    // Токен чужой компании своей компанией не отзывается.
    const stranger = await makeOrg();
    const theirs = await issueAgentToken(stranger.orgId, stranger.ownerId, await makeAgent(stranger.orgId, stranger.ownerId), 'чужой');
    expect((await mini(request(app).delete(`/app/api/agent-tokens/${theirs.id}?org=${orgId}`))).status).toBe(404);
    expect((await mini(request(app).delete(`/app/api/agent-tokens/${theirs.id}?org=${stranger.orgId}`))).status).toBe(403);
    expect((await mcp(theirs.token, { method: 'tools/list' })).status).toBe(200);

    const revoked = await mini(request(app).delete(`/app/api/agent-tokens/${issued.body.id}?org=${orgId}`));
    expect(revoked.status).toBe(200);
    expect((await mini(request(app).get(`/app/api/agent-tokens?org=${orgId}`))).body).toEqual([]);
    expect((await mcp(issued.body.token, { method: 'tools/list' })).status).toBe(401);
    expect((await mini(request(app).delete(`/app/api/agent-tokens/${issued.body.id}?org=${orgId}`))).status).toBe(404);
  });

  it('выпуск — только из свежеоткрытого приложения; о выпуске — сообщение в бот выпустившему, в пространство компании', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agentName = `wh-${uniq()}`;
    const agentId = await makeAgent(orgId, ownerId, agentName);
    const tg = await linkTelegram(ownerId);
    const stale = await request(app).post('/app/api/agent-tokens').set('X-Telegram-Init-Data', initDataFor(tg, 20 * 60))
      .send({ org: orgId, agent: agentId, label: 'старая вкладка' });
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('stale_session');
    expect((await withGlobal((db) => db.query('select count(*)::int as n from agent_tokens where org_id = $1', [orgId]))).rows[0].n).toBe(0);
    // Тот же заслон у токена чтения — общая проверка.
    const staleRead = await request(app).post('/app/api/read-tokens').set('X-Telegram-Init-Data', initDataFor(tg, 20 * 60)).send({ label: 'x' });
    expect(staleRead.body.code).toBe('stale_session');

    const fresh = await request(app).post('/app/api/agent-tokens').set('X-Telegram-Init-Data', initDataFor(tg))
      .send({ org: orgId, agent: agentName, label: 'сервер склада' });
    expect(fresh.status).toBe(200);
    const n = await withSystem((db) => db.query(
      `select org_id, level, payload from notifications where user_id = $1 and kind = 'agent_token_issued'`, [ownerId]));
    expect(n.rows).toEqual([{ org_id: orgId, level: 'glance', payload: { label: 'сервер склада', agent_name: agentName } }]);
  });

  it('не владелец → 403; агент другой компании → 404', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agentId = await makeAgent(orgId, ownerId);
    const admin = await addPerson(orgId, 'admin');
    const tg = await linkTelegram(admin);
    const mini = (r: request.Test) => r.set('X-Telegram-Init-Data', initDataFor(tg));
    expect((await mini(request(app).post('/app/api/agent-tokens').send({ org: orgId, agent: agentId, label: 'x' }))).status).toBe(403);
    expect((await mini(request(app).get(`/app/api/agent-tokens?org=${orgId}`))).status).toBe(403);
    expect((await mini(request(app).get('/app/api/agent-tokens'))).status).toBe(403);

    const owner = await linkTelegram(ownerId);
    const stranger = await makeOrg();
    const theirAgent = await makeAgent(stranger.orgId, stranger.ownerId);
    // Владелец своей компании, но агент — чужой.
    await withGlobal((db) => addMember(db, stranger.orgId, ownerId, 'member'));
    const r = await request(app).post('/app/api/agent-tokens').set('X-Telegram-Init-Data', initDataFor(owner))
      .send({ org: orgId, agent: theirAgent, label: 'чужой агент' });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('not_found');
  });
});
