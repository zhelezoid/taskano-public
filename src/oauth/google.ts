import { createHash } from 'node:crypto';
import { Router } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { withGlobal } from '../db/pool.js';
import { demoLoginEmail, env, googleLoginEnabled } from '../config/env.js';
import { randomToken, safeEqual, sha256 } from '../core/crypto.js';
import { ensureUserByEmail, mayEnter } from '../core/people.js';
import { logger } from '../log.js';
import { clientKey, rateLimit } from '../web/rate-limit.js';
import { langFromRequest } from '../web/accept-language.js';
import { DEMO_PEOPLE_DOMAIN } from '../email/send.js';
import { emailForm, googleCookieName, loadPending, page, readCookie, TEXT } from './pages.js';

// Вход через Google на странице подключения к Claude (спека google-login):
// вторая кнопка рядом с входом по коду. Код OAuth выдаёт то же согласие, что и после кода из почты.
//
// В лог не попадают code, id_token, state, cookie и секрет клиента — только причина отказа.

export interface GoogleEndpoints { authUrl: string; tokenUrl: string; jwksUrl: string }

/** Адреса Google. Тесты подменяют token и JWKS своими (createApp({ google })). */
export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
};

// Оба вида записи издателя Google документирует как законные.
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const STATE_TTL_MS = 10 * 60 * 1000;
const EXCHANGE_TIMEOUT_MS = 10_000;
// Служебные демо-адреса (спека demo-access) входят только постоянным кодом, а вымышленные люди
// демо-компании (@demo.taskano.app) не входят вовсе — даже если такой ящик окажется у кого-то в Google.
const DEMO_ADDRESS_RE = /^demo[a-z0-9-]*@taskano\.app$/;
const isDemoAddress = (email: string) =>
  email === demoLoginEmail() || DEMO_ADDRESS_RE.test(email) || email.endsWith(`@${DEMO_PEOPLE_DOMAIN}`);

// Набор ключей Google кэшируется jose внутри (по заголовкам кэша и при неизвестном kid обновляется).
const keySets = new Map<string, JWTVerifyGetKey>();
function keySet(url: string): JWTVerifyGetKey {
  let ks = keySets.get(url);
  if (!ks) { ks = createRemoteJWKSet(new URL(url)); keySets.set(url, ks); }
  return ks;
}

const callbackUrl = () => `${env.publicUrl}/oauth/google/callback`;
const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

type Verified = { email: string; sub: string } | { status: 400 | 502 };

const GOOGLE_MAIL = new Set(['gmail.com', 'googlemail.com']);

/** Адрес, которым распоряжается Google: gmail или домен Workspace, совпадающий с claim `hd`. */
export function googleOwnsEmail(email: string, hd: unknown): boolean {
  const domain = email.trim().toLowerCase().split('@')[1] ?? '';
  if (GOOGLE_MAIL.has(domain)) return true;
  return typeof hd === 'string' && hd.toLowerCase() === domain;
}

/** Отказ внутри транзакции входа: откатывает и заведённого было человека. */
class LoginRefused extends Error {
  constructor(readonly reason: 'pending_taken' | 'sub_mismatch' | 'not_invited') { super(reason); }
}

/** Проверка id_token: подпись по JWKS, iss, aud, срок, nonce, подтверждённая почта. */
async function verifiedEmail(idToken: string, jwksUrl: string, nonceHash: string): Promise<Verified> {
  try {
    const { payload } = await jwtVerify(idToken, keySet(jwksUrl), {
      issuer: ISSUERS, audience: env.googleClientId, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub'],
      // Небольшой допуск на расхождение часов; токен старше 10 минут для входа уже не годится.
      clockTolerance: '60s', maxTokenAge: '10m',
    });
    let reason = '';
    // Несколько получателей — токен выписан не только нам; тогда наш client id обязан стоять в azp (OIDC Core 3.1.3.7).
    if ((Array.isArray(payload.aud) || payload.azp !== undefined) && payload.azp !== env.googleClientId) reason = 'azp';
    else if (typeof payload.nonce !== 'string' || !safeEqual(sha256(payload.nonce), nonceHash)) reason = 'nonce';
    else if (payload.email_verified !== true) reason = 'email_not_verified';
    else if (typeof payload.email !== 'string') reason = 'no_email';
    // Почте из Google верим, только если ею распоряжается Google (gmail) или домен Workspace (claim hd):
    // личный аккаунт Google на чужой рабочий адрес, подтверждённый когда-то, иначе входил бы в чужой
    // Taskano раньше настоящего владельца адреса (аудит безопасности 07.10). Такой почте — вход кодом.
    else if (!googleOwnsEmail(payload.email, payload.hd)) reason = 'untrusted_domain';
    if (reason) {
      logger.warn({ reason }, 'google login: token rejected');
      return { status: 400 };
    }
    return { email: (payload.email as string).trim().toLowerCase(), sub: payload.sub! };
  } catch (e) {
    // Ошибки jose несут код (ERR_JWT_EXPIRED, ERR_JWS_SIGNATURE_VERIFICATION_FAILED…) — его и пишем:
    // в самих объектах ошибок лежит содержимое токена. Без кода — не достучались до ключей Google.
    const code = (e as { code?: unknown }).code;
    const down = typeof code !== 'string' || code === 'ERR_JWKS_TIMEOUT';
    logger.warn({ reason: typeof code === 'string' ? code : 'jwks_unreachable' }, 'google login: token rejected');
    return { status: down ? 502 : 400 };
  }
}

/** Маршруты входа через Google. Без GOOGLE_CLIENT_ID/SECRET их нет вовсе — 404, как до этой спеки. */
export function googleRouter(endpoints: Partial<GoogleEndpoints> = {}): Router {
  const ep: GoogleEndpoints = { ...GOOGLE_ENDPOINTS, ...endpoints };
  const r = Router();
  r.use('/oauth/google', (_req, _res, next) => (googleLoginEnabled() ? next() : next('router')));
  r.use('/oauth/google', rateLimit({ windowMs: 60_000, max: 20, key: clientKey }));

  r.get('/oauth/google/start/:pendingId', async (req, res) => {
    const l = langFromRequest(req);
    const p = await loadPending(req.params.pendingId);
    if (!p) return page(res, l, `<p class="err">${TEXT[l]!.expired}</p>`, 410);
    if (p.user_id) return res.redirect(302, `/oauth/login/${p.id}`);
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken();
    const cookie = randomToken();
    await withGlobal((db) => db.query(
      `insert into oauth_google_states(state_hash, pending_id, cookie_hash, nonce_hash, code_verifier, expires_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [sha256(state), p.id, sha256(cookie), sha256(nonce), verifier, new Date(Date.now() + STATE_TTL_MS)],
    ));
    // Привязка к браузеру: обратный вызов и согласие примут только этот cookie.
    res.cookie(googleCookieName(p.id), cookie, { httpOnly: true, secure: true, sameSite: 'lax', path: '/oauth', maxAge: STATE_TTL_MS });
    const url = new URL(ep.authUrl);
    url.search = new URLSearchParams({
      client_id: env.googleClientId, redirect_uri: callbackUrl(), response_type: 'code', scope: 'openid email profile',
      state, nonce, code_challenge: s256(verifier), code_challenge_method: 'S256', prompt: 'select_account',
    }).toString();
    res.set('Cache-Control', 'no-store').redirect(302, url.toString());
  });

  r.get('/oauth/google/callback', async (req, res) => {
    const l = langFromRequest(req);
    const t = TEXT[l]!;
    const failed = () => page(res, l, `<p class="err">${t.google_failed}</p>`, 400);
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!state) return failed();
    // state одноразовый: забираем его одним запросом, и повтор (или параллельный дубль) уже не найдёт строку.
    const row = await withGlobal(async (db) => (await db.query(
      `update oauth_google_states set used_at = now()
        where state_hash = $1 and used_at is null and expires_at > now()
        returning pending_id, cookie_hash, nonce_hash, code_verifier`, [sha256(state)])).rows[0] as
      { pending_id: string; cookie_hash: string; nonce_hash: string; code_verifier: string } | undefined);
    if (!row) {
      logger.warn({ reason: 'state' }, 'google login: unknown, used or expired state');
      return failed();
    }
    // Чужой браузер получает только строку отказа, без формы: в фишинговом сценарии это сессия входа
    // злоумышленника, и форма кода на ней привязала бы к ней почту жертвы.
    const cookie = readCookie(req, googleCookieName(row.pending_id));
    if (!cookie || !safeEqual(sha256(cookie), row.cookie_hash)) {
      logger.warn({ reason: cookie ? 'cookie_mismatch' : 'no_cookie', pending_id: row.pending_id }, 'google login: other browser');
      return failed();
    }
    const p = await loadPending(row.pending_id);
    if (!p) return page(res, l, `<p class="err">${t.expired}</p>`, 410);
    // Дальше браузер тот же, что начал вход: можно сразу предложить войти кодом.
    const retry = (status: number) => page(res, l, emailForm(p.id, l, t.google_failed), status);

    if (req.query.error !== undefined) {
      if (req.query.error === 'access_denied') return page(res, l, emailForm(p.id, l, '', t.google_cancelled));
      logger.warn({ reason: 'provider_error', error: String(req.query.error).slice(0, 64), pending_id: p.id }, 'google login: error from Google');
      return retry(400);
    }
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) return retry(400);

    let idToken: string;
    try {
      const resp = await fetch(ep.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code, redirect_uri: callbackUrl(), code_verifier: row.code_verifier,
          client_id: env.googleClientId, client_secret: env.googleClientSecret,
        }),
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      });
      const body = await resp.json().catch(() => null) as { id_token?: unknown; error?: unknown } | null;
      if (!resp.ok || typeof body?.id_token !== 'string') {
        // Из ответа — только код ошибки протокола (invalid_grant и т.п.), тело целиком не пишем.
        const error = typeof body?.error === 'string' ? body.error.slice(0, 64) : undefined;
        logger.warn({ reason: 'exchange', status: resp.status, error, pending_id: p.id }, 'google login: code exchange failed');
        return retry(502);
      }
      idToken = body.id_token;
    } catch (e) {
      logger.warn({ reason: 'exchange', error: (e as Error).name, pending_id: p.id }, 'google login: Google unreachable');
      return retry(502);
    }

    const v = await verifiedEmail(idToken, ep.jwksUrl, row.nonce_hash);
    if ('status' in v) return retry(v.status);
    if (isDemoAddress(v.email)) {
      logger.warn({ reason: 'demo_address', pending_id: p.id }, 'google login: demo address');
      return retry(400);
    }
    try {
      await withGlobal(async (db) => {
        // Тот же вызов, что после верного кода: почта подтверждена — Google проверил её за нас.
        if (!(await mayEnter(db, v.email))) throw new LoginRefused('not_invited');
        const { user } = await ensureUserByEmail(db, v.email, { language: l, verified: true });
        // Аккаунт Google запоминается при первом входе. Та же почта с другим sub — уже другой аккаунт
        // Google (адрес домена Workspace отдали новому сотруднику): в чужой Taskano он не входит.
        const bound = await db.query(
          'update users set google_sub = coalesce(google_sub, $2) where id = $1 returning google_sub', [user.id, v.sub]);
        if (bound.rows[0]?.google_sub !== v.sub) throw new LoginRefused('sub_mismatch');
        // Сессию, в которую тем временем вошли кодом, Google не перехватывает.
        const taken = await db.query(
          'update oauth_pending set user_id = $2, via_google_cookie_hash = $3 where id = $1 and user_id is null',
          [p.id, user.id, row.cookie_hash]);
        if (!taken.rowCount) throw new LoginRefused('pending_taken');
      });
    } catch (e) {
      const reason = e instanceof LoginRefused ? e.reason : 'user';
      logger.warn({ reason, error: e instanceof LoginRefused ? undefined : (e as Error).name, pending_id: p.id }, 'google login: user not accepted');
      // В занятую сессию форма кода не нужна: войти в неё уже нельзя ни так, ни так.
      if (reason === 'not_invited') return page(res, l, emailForm(p.id, l, t.closed), 403);
      return reason === 'pending_taken' ? failed() : retry(400);
    }
    // На страницу входа, а не согласие прямо здесь: code и state уходят из адресной строки и истории,
    // а обновление страницы не повторяет одноразовый обратный вызов. Страница покажет согласие.
    res.redirect(302, `/oauth/login/${p.id}`);
  });

  return r;
}
