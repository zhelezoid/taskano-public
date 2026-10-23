import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { withGlobal } from '../db/pool.js';
import { randomToken, sha256 } from '../core/crypto.js';
import { env } from '../config/env.js';

// OAuth 2.1 + DCR для коннектора claude.ai (спека mcp-and-oauth). Токен принадлежит человеку.
// Тексты ошибок протокола — латиницей: SDK кладёт их в заголовок WWW-Authenticate, кириллица там роняет ответ в 500.

export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 60 * 86400;
export const PENDING_TTL_MS = 30 * 60 * 1000;

// Законные клиенты — только известные: claude.ai, ChatGPT и клиенты на компьютере человека (Claude
// Code). Регистрация с любым другим адресом возврата позволила бы выманить у человека вход фишинговой
// ссылкой (аудит безопасности, п.2).
const ALLOWED_REDIRECTS = [
  'https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback',
  // ChatGPT (Apps SDK, developers.openai.com/apps-sdk/build/auth): общий адрес при поддержке issuer
  // identification и адрес на подключение — ниже шаблоном.
  'https://chatgpt.com/connector_platform_oauth_redirect',
];
const CHATGPT_CALLBACK = /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/;

/** Адрес возврата на этой же машине (RFC 8252, §7.3): так входят клиенты на компьютере — Claude Code.
 *  Код уходит на компьютер самого человека, а не на чужой сервер, поэтому фишинговой ссылкой его не
 *  перехватить; порт любой — клиент поднимает его на время входа. */
function isLoopback(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')
      && !u.username && !u.password;
  } catch { return false; }
}

export function isAllowedRedirect(uri: string): boolean {
  const extra = (process.env.OAUTH_EXTRA_REDIRECTS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (ALLOWED_REDIRECTS.includes(uri) || extra.includes(uri)) return true;
  if (CHATGPT_CALLBACK.test(uri)) return true;
  return isLoopback(uri);
}

/** Ошибка, после которой нужно отозвать токены отдельной транзакцией (иначе откат унесёт отзыв). */
type Revoke = { family?: string; userId?: string; clientId?: string };

class ClientsStore implements OAuthRegisteredClientsStore {
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return withGlobal(async (db) => {
      const r = await db.query('select metadata from oauth_clients where client_id = $1', [clientId]);
      return r.rows[0]?.metadata as OAuthClientInformationFull | undefined;
    });
  }

  async registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): Promise<OAuthClientInformationFull> {
    const bad = (client.redirect_uris ?? []).filter((u) => !isAllowedRedirect(String(u)));
    if (!client.redirect_uris?.length || bad.length) {
      throw new InvalidClientMetadataError(`redirect_uri not allowed: ${bad.join(', ') || 'missing'}`);
    }
    // Только публичные клиенты (PKCE): секрет не выдаём и не храним.
    const { client_secret: _s, client_secret_expires_at: _e, ...rest } = client as OAuthClientInformationFull;
    const full = {
      ...rest,
      token_endpoint_auth_method: 'none',
      client_id: `tsk_${randomToken(16)}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    } as OAuthClientInformationFull;
    await withGlobal((db) => db.query(
      'insert into oauth_clients(client_id, client_secret_hash, metadata) values ($1, null, $2)',
      [full.client_id, full],
    ));
    return full;
  }
}

export class TaskanoOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new ClientsStore();

  /** Начало входа: запоминаем параметры и ведём человека на нашу страницу (почта → код → согласие). */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const id = randomUUID();
    await withGlobal((db) => db.query(
      'insert into oauth_pending(id, client_id, params, expires_at) values ($1, $2, $3, $4)',
      [id, client.client_id, { ...params, resource: params.resource?.toString() }, new Date(Date.now() + PENDING_TTL_MS)],
    ));
    res.redirect(302, `${env.publicUrl}/oauth/login/${id}`);
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, code: string): Promise<string> {
    return withGlobal(async (db) => {
      const r = await db.query('select code_challenge from oauth_codes where code_hash = $1', [sha256(code)]);
      if (!r.rowCount) throw new InvalidGrantError('Unknown authorization code');
      return r.rows[0].code_challenge as string;
    });
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL,
  ): Promise<OAuthTokens> {
    const outcome = await withGlobal(async (db): Promise<OAuthTokens | { error: string; revoke?: Revoke }> => {
      const r = await db.query('select * from oauth_codes where code_hash = $1 for update', [sha256(code)]);
      const row = r.rows[0];
      if (!row || row.client_id !== client.client_id) return { error: 'Authorization code not found' };
      // Повтор кода = признак перехвата: отзываем всё, что было выдано этому клиенту по этому человеку.
      if (row.used_at) return { error: 'Authorization code already used', revoke: { userId: row.user_id, clientId: client.client_id } };
      if (new Date(row.expires_at) < new Date()) return { error: 'Authorization code expired' };
      if (redirectUri && redirectUri !== row.redirect_uri) return { error: 'redirect_uri mismatch' };
      if (resource && row.resource && resource.toString() !== row.resource) return { error: 'resource mismatch' };
      await db.query('update oauth_codes set used_at = now() where code_hash = $1', [row.code_hash]);
      return issueTokens(db, client.client_id, row.user_id, row.scopes, row.resource, randomUUID());
    });
    return settle(outcome);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const outcome = await withGlobal(async (db): Promise<OAuthTokens | { error: string; revoke?: Revoke }> => {
      const r = await db.query(`select * from oauth_tokens where token_hash = $1 and kind = 'refresh' for update`, [sha256(refreshToken)]);
      const row = r.rows[0];
      if (!row || row.client_id !== client.client_id) return { error: 'Refresh token not found' };
      // Предъявлен уже ротированный токен — цепочка скомпрометирована (спека, edge cases).
      if (row.revoked_at || row.rotated_at) return { error: 'Refresh token revoked', revoke: { family: row.family } };
      if (new Date(row.expires_at) < new Date()) return { error: 'Refresh token expired' };
      if (resource && row.resource && resource.toString() !== row.resource) return { error: 'resource mismatch' };
      await db.query('update oauth_tokens set rotated_at = now() where token_hash = $1', [row.token_hash]);
      const granted: string[] = scopes?.length ? scopes.filter((s) => row.scopes.includes(s)) : row.scopes;
      return issueTokens(db, client.client_id, row.user_id, granted, row.resource, row.family);
    });
    return settle(outcome);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    return withGlobal(async (db) => {
      const r = await db.query(
        `select t.*, u.anonymized_at from oauth_tokens t join users u on u.id = t.user_id where t.token_hash = $1 and t.kind = 'access'`,
        [sha256(token)],
      );
      const row = r.rows[0];
      if (!row || row.revoked_at || row.anonymized_at || new Date(row.expires_at) < new Date()) throw new InvalidTokenError('Invalid or expired token');
      return {
        token, clientId: row.client_id, scopes: row.scopes,
        expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000),
        resource: row.resource ? new URL(row.resource) : undefined,
        extra: { userId: row.user_id },
      };
    });
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await withGlobal(async (db) => {
      const r = await db.query('select family, client_id from oauth_tokens where token_hash = $1', [sha256(request.token)]);
      if (r.rows[0]?.client_id === client.client_id) {
        await db.query('update oauth_tokens set revoked_at = now() where family = $1 and revoked_at is null', [r.rows[0].family]);
      }
    });
  }
}

/** Отзыв — отдельной транзакцией, которая коммитится ДО ошибки клиенту (аудит безопасности, п.1). */
async function settle(outcome: OAuthTokens | { error: string; revoke?: Revoke }): Promise<OAuthTokens> {
  if (!('error' in outcome)) return outcome;
  const rv = outcome.revoke;
  if (rv?.family) {
    await withGlobal((db) => db.query('update oauth_tokens set revoked_at = now() where family = $1 and revoked_at is null', [rv.family]));
  } else if (rv?.userId && rv.clientId) {
    await withGlobal((db) => db.query('update oauth_tokens set revoked_at = now() where user_id = $1 and client_id = $2 and revoked_at is null', [rv.userId, rv.clientId]));
  }
  throw new InvalidGrantError(outcome.error);
}

async function issueTokens(
  db: import('../db/pool.js').Db, clientId: string, userId: string, scopes: string[], resource: string | null, family: string,
): Promise<OAuthTokens> {
  const access = randomToken();
  const refresh = randomToken();
  const now = Date.now();
  await db.query(
    `insert into oauth_tokens(token_hash, kind, family, client_id, user_id, scopes, resource, expires_at)
     values ($1, 'access', $3, $4, $5, $6, $7, $8), ($2, 'refresh', $3, $4, $5, $6, $7, $9)`,
    [sha256(access), sha256(refresh), family, clientId, userId, scopes, resource,
      new Date(now + ACCESS_TTL_S * 1000), new Date(now + REFRESH_TTL_S * 1000)],
  );
  return { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scopes.join(' ') };
}

/** Выдать код авторизации после входа и согласия (вызывает страница входа). */
export async function issueAuthorizationCode(pendingId: string, userId: string): Promise<string> {
  return withGlobal(async (db) => {
    const r = await db.query('select * from oauth_pending where id = $1 for update', [pendingId]);
    const p = r.rows[0];
    if (!p || new Date(p.expires_at) < new Date()) throw new Error('Сессия входа истекла, начните заново');
    const params = p.params as { state?: string; scopes?: string[]; codeChallenge: string; redirectUri: string; resource?: string };
    const code = randomToken();
    await db.query(
      `insert into oauth_codes(code_hash, client_id, user_id, code_challenge, redirect_uri, scopes, resource, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, now() + interval '5 minutes')`,
      [sha256(code), p.client_id, userId, params.codeChallenge, params.redirectUri, params.scopes ?? [], params.resource ?? null],
    );
    await db.query('delete from oauth_pending where id = $1', [pendingId]);
    const url = new URL(params.redirectUri);
    url.searchParams.set('code', code);
    if (params.state) url.searchParams.set('state', params.state);
    return url.toString();
  });
}
