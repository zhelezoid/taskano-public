import { withGlobal, withOrg, type Db } from '../db/pool.js';
import { loadAgent } from './access.js';
import { randomToken, sha256 } from './crypto.js';
import { AppError } from './errors.js';
import { notify } from './notify.js';

// Постоянный токен агента для серверной программы (спека agent-tokens): программа без человека у
// экрана ставит задачи и тревоги от имени одного агента одной организации. OAuth для неё хрупок —
// повтор старого refresh гасит всю цепочку. Безопасность держат четыре вещи: токен закреплён за
// агентом и организацией и видит только шесть инструментов, у него срок, владелец отзывает его сам,
// и в базе лежит лишь хэш.

export const AGENT_TOKEN_PREFIX = 'tka_';
/** Продления нет: через год — новый токен, старый отозвать. */
export const AGENT_TOKEN_TTL_DAYS = 365;
/** Больше трёх действующих на агента — уже не «сервер и запасной», а раздача доступа. */
export const AGENT_TOKEN_LIMIT = 3;
/** Не больше стольких выпусков за сутки на организацию (вместе с отозванными). */
export const AGENT_TOKEN_DAILY_LIMIT = 20;
const LABEL_MAX = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AgentTokenInfo {
  id: string;
  label: string;
  agent_id: string;
  agent_name: string;
  created_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
}

export interface VerifiedAgentToken {
  tokenId: string;
  orgId: string;
  agentId: string;
  /** Хозяин агента: от его имени идёт вызов, его роль — для проверок прав. */
  ownerUserId: string;
}

function cleanLabel(raw: unknown): string {
  const label = typeof raw === 'string'
    ? raw.replace(/[\u0000-\u001f\u007f​-‏﻿]/g, '').trim()
    : '';
  if (!label) throw new AppError('validation_failed', 'A name is required — what program the token is for');
  if (label.length > LABEL_MAX) throw new AppError('validation_failed', `The name is longer than ${LABEL_MAX} characters`);
  return label;
}

/**
 * Токенами агентов распоряжается только владелец компании. Админ — нет: токен живёт год и действует
 * без человека, а админа увольняют, и выпущенное им пережило бы его (спека agent-tokens).
 */
async function requireOwner(db: Db, orgId: string, userId: string): Promise<void> {
  const r = await db.query(
    `select 1 from memberships m join orgs o on o.id = m.org_id join users u on u.id = m.user_id
      where m.org_id = $1 and m.user_id = $2 and m.status = 'active' and m.role = 'owner'
        and o.kind = 'company' and u.anonymized_at is null`, [orgId, userId]);
  if (!r.rowCount) throw new AppError('forbidden', 'Only the owner of the company can manage agent tokens');
}

/** Чужая или выдуманная организация — тот же отказ, что «не владелец»: о чужом знать незачем. */
function checkOrgId(orgId: unknown): string {
  if (typeof orgId !== 'string' || !UUID_RE.test(orgId)) throw new AppError('forbidden', 'Only the owner of the company can manage agent tokens');
  return orgId;
}

/** Выпустить токен. Сырой токен возвращается ровно здесь и больше нигде — его не хранит и база. */
export async function issueAgentToken(
  orgId: string, userId: string, agentRef: string, label: string,
): Promise<{ id: string; token: string; expires_at: Date }> {
  const org = checkOrgId(orgId);
  const name = cleanLabel(label);
  return withOrg(org, async (db) => {
    await requireOwner(db, org, userId);
    const ref = typeof agentRef === 'string' ? agentRef.trim() : '';
    if (!ref) throw new AppError('validation_failed', 'agent is required — which agent the token acts for');
    // Похожее на id, но не id, ушло бы в запрос как uuid и уронило его в 500.
    if (/^[0-9a-f-]{36}$/i.test(ref) && !UUID_RE.test(ref)) throw new AppError('not_found', `Agent "${ref}" not found`);
    // Агент ищется под RLS организации: агент другой компании здесь просто «не найден».
    const agent = await loadAgent(db, ref);
    // Выпуски организации — под блокировкой: два одновременных иначе оба увидели бы два
    // действующих и оставили четыре, а сотня параллельных обошла бы суточный предел.
    await db.query(`select pg_advisory_xact_lock(hashtextextended('agent_tokens:' || $1, 0))`, [org]);
    const active = (await db.query(
      `select count(*)::int as n from agent_tokens
        where org_id = $1 and agent_id = $2 and revoked_at is null and expires_at > now()`, [org, agent.id])).rows[0].n as number;
    if (active >= AGENT_TOKEN_LIMIT) {
      throw new AppError('limit_exceeded', `No more than ${AGENT_TOKEN_LIMIT} active tokens per agent — revoke one you no longer use`, { limit: AGENT_TOKEN_LIMIT });
    }
    // Выпуск и отзыв по кругу растили бы таблицу без предела.
    const today = (await db.query(
      `select count(*)::int as n from agent_tokens where org_id = $1 and created_at > now() - interval '24 hours'`, [org])).rows[0].n as number;
    if (today >= AGENT_TOKEN_DAILY_LIMIT) {
      throw new AppError('limit_exceeded', `No more than ${AGENT_TOKEN_DAILY_LIMIT} agent tokens a day per company`, { limit: AGENT_TOKEN_DAILY_LIMIT });
    }
    const token = AGENT_TOKEN_PREFIX + randomToken(32);
    const r = await db.query(
      `insert into agent_tokens(org_id, agent_id, issued_by_user_id, agent_owner_user_id, label, token_hash, expires_at)
       values ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7::int)) returning id, expires_at`,
      [org, agent.id, userId, agent.owner_user_id, name, sha256(token), AGENT_TOKEN_TTL_DAYS]);
    // Владелец узнаёт о выпуске в боте: подпись приложения живёт сутки, а токен — год, и выпущенный
    // чужими руками иначе остался бы незамеченным. Сообщение — в пространство компании: токен её.
    await notify(db, { userId, kind: 'agent_token_issued', level: 'glance', payload: { label: name, agent_name: agent.name } });
    return { id: r.rows[0].id as string, token, expires_at: r.rows[0].expires_at as Date };
  });
}

/** Действующие токены компании — без самих токенов: их показывают один раз, при выпуске. */
export async function listAgentTokens(orgId: string, userId: string): Promise<AgentTokenInfo[]> {
  const org = checkOrgId(orgId);
  return withOrg(org, async (db) => {
    await requireOwner(db, org, userId);
    return (await db.query(
      `select t.id, t.label, t.agent_id, a.name as agent_name, t.created_at, t.expires_at, t.last_used_at
         from agent_tokens t join agents a on a.org_id = t.org_id and a.id = t.agent_id
        where t.org_id = $1 and t.revoked_at is null and t.expires_at > now()
        order by t.created_at desc`, [org])).rows as AgentTokenInfo[];
  });
}

/** Отозвать токен компании. Чужой и уже отозванный — «не найдено». */
export async function revokeAgentToken(orgId: string, userId: string, id: string): Promise<void> {
  const org = checkOrgId(orgId);
  await withOrg(org, async (db) => {
    await requireOwner(db, org, userId);
    if (typeof id !== 'string' || !UUID_RE.test(id)) throw new AppError('not_found', 'Token not found');
    const r = await db.query(
      `update agent_tokens set revoked_at = now() where id = $1 and org_id = $2 and revoked_at is null`, [id, org]);
    if (!r.rowCount) throw new AppError('not_found', 'Token not found');
  });
}

/**
 * Кто стоит за токеном. `null` — для программы одинаково «нет доступа»: неизвестный, отозванный,
 * истёкший; агент удалён; хозяин агента вышел из компании или анонимизирован; выпустивший больше не
 * владелец компании или анонимизирован — уволенный владелец не оставляет после себя действующий
 * токен. Всё проверяется на каждом запросе, а не при выпуске: права за год меняются.
 * Отметка «пользовались» — не чаще раза в минуту: программа ходит часто, запись на каждый запрос
 * была бы лишней нагрузкой без пользы человеку.
 */
export async function verifyAgentToken(raw: string | null | undefined): Promise<VerifiedAgentToken | null> {
  if (typeof raw !== 'string' || !raw.startsWith(AGENT_TOKEN_PREFIX) || raw.length > 200) return null;
  return withGlobal(async (db) => {
    const t = (await db.query(
      `select id, org_id, agent_id, issued_by_user_id, agent_owner_user_id from agent_tokens
        where token_hash = $1 and revoked_at is null and expires_at > now()`, [sha256(raw)])).rows[0] as
      { id: string; org_id: string; agent_id: string; issued_by_user_id: string; agent_owner_user_id: string } | undefined;
    if (!t) return null;
    // Таблица токенов глобальная, а агенты — под RLS организации: без org_id в транзакции запрос к
    // ним молча вернул бы ноль строк, и действующий токен считался бы мёртвым. Организация — из
    // строки токена, до конца этой транзакции.
    await db.query(`select set_config('app.org_id', $1, true)`, [t.org_id]);
    const r = await db.query(
      `select a.owner_user_id
         from agents a
         join memberships mo on mo.org_id = a.org_id and mo.user_id = a.owner_user_id and mo.status = 'active'
         join users uo on uo.id = a.owner_user_id and uo.anonymized_at is null
         join memberships mi on mi.org_id = a.org_id and mi.user_id = $3 and mi.status = 'active' and mi.role = 'owner'
         join users ui on ui.id = mi.user_id and ui.anonymized_at is null
        where a.org_id = $1 and a.id = $2 and a.owner_user_id = $4`, [t.org_id, t.agent_id, t.issued_by_user_id, t.agent_owner_user_id]);
    const row = r.rows[0] as { owner_user_id: string } | undefined;
    if (!row) return null;
    await db.query(
      `update agent_tokens set last_used_at = now()
        where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`, [t.id]);
    return { tokenId: t.id, orgId: t.org_id, agentId: t.agent_id, ownerUserId: row.owner_user_id };
  });
}
