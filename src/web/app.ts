import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { fileURLToPath } from 'node:url';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { env } from '../config/env.js';
import { TaskanoOAuthProvider } from '../oauth/provider.js';
import { oauthPagesRouter } from '../oauth/pages.js';
import { googleRouter, type GoogleEndpoints } from '../oauth/google.js';
import { buildMcpServer } from '../mcp/server.js';
import type { CallerCtx } from '../mcp/context.js';
import { AGENT_TOKEN_PREFIX, verifyAgentToken, type VerifiedAgentToken } from '../core/agent-tokens.js';
import { mergedToolResponse } from '../mcp/merged.js';
import { withGlobal } from '../db/pool.js';
import { logger } from '../log.js';
import { clientKey, failureCeiling, rateLimit } from './rate-limit.js';
import { readRoutes } from './read-api.js';

declare global {
  namespace Express {
    interface Request {
      agentToken?: VerifiedAgentToken;
    }
  }
}

/** Формат токена агента — до похода в базу: мусор отсекается без запроса. */
const AGENT_TOKEN_RE = /^tka_[A-Za-z0-9_-]{43}$/;

/** Ответ на JSON-RPC запрос /mcp от имени `caller` — общий для OAuth человека и токена агента. */
async function serveMcp(req: Request, res: Response, caller: CallerCtx): Promise<void> {
  // Старое имя инструмента у закэшированного skill: отвечаем, чем его звать теперь, а не
  // «unknown tool» — по такому ответу модель придумывает вызов заново (спека connector-surface).
  const merged = mergedToolResponse(req.body);
  if (merged) { res.json(merged); return; }
  const server = buildMcpServer(caller);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    logger.error({ err: e }, 'mcp request failed');
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
}

/**
 * Вход серверной программы по токену агента `tka_…` (спека agent-tokens) — до OAuth: OAuth-проверка
 * такого токена не знает. Не `tka_` — дальше, прежним путём OAuth без изменений.
 */
function agentTokenMcp() {
  // Неудачи — по адресу: адрес, упёршийся в предел, в базу не ходит до конца окна.
  const failures = failureCeiling({ windowMs: 60_000, max: 30 });
  // Сторож ходит раз в несколько минут по нескольким делам; сто двадцать в минуту — с запасом.
  const perToken = rateLimit({ windowMs: 60_000, max: 120, key: (req) => `a:${req.agentToken!.tokenId}` });
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const h = req.header('authorization');
    const raw = h ? /^Bearer\s+(\S+)$/i.exec(h)?.[1] : undefined;
    if (!raw?.startsWith(AGENT_TOKEN_PREFIX)) { next(); return; }
    if (failures.blocked(req)) { res.status(429).json({ code: 'rate_limited' }); return; }
    const verified = AGENT_TOKEN_RE.test(raw) ? await verifyAgentToken(raw) : null;
    if (!verified) {
      failures.fail(req);
      res.status(401).set('WWW-Authenticate', 'Bearer error="invalid_token"').json({ code: 'unauthorized' });
      return;
    }
    req.agentToken = verified;
    perToken(req, res, () => {
      void serveMcp(req, res, {
        userId: verified.ownerUserId,
        pin: { orgId: verified.orgId, agentId: verified.agentId, tokenId: verified.tokenId },
      });
    });
  };
}

export interface AppHooks {
  /** Дополнительные маршруты (webhook бота, Mini App, страница исполнителя) — монтируются до 404. */
  extraRoutes?: (app: Express) => void;
  /** Адреса Google для входа через Google (спека google-login) — подменяют тесты. */
  google?: Partial<GoogleEndpoints>;
}

export function createApp(hooks: AppHooks = {}): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  // Заголовки защиты (аудит безопасности, п.7). Mini App встраивается Telegram во фрейм — ему frame-ancestors не запрещаем.
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.path.startsWith('/app')) {
      // Приложение живёт во фрейме Telegram, поэтому запретить встраивание целиком нельзя — но
      // можно назвать тех, кому оно позволено. Остальное (`script-src`, `default-src`) пока не
      // ставим: проверить такую политику можно только в настоящем клиенте Telegram, а ошибка в ней
      // означает белый экран у всех сразу.
      res.set('Content-Security-Policy', 'frame-ancestors https://web.telegram.org https://*.telegram.org');
    } else {
      res.set('X-Frame-Options', 'DENY');
      res.set('Content-Security-Policy', "frame-ancestors 'none'");
    }
    next();
  });

  const provider = new TaskanoOAuthProvider();
  const issuer = new URL(env.publicUrl);
  const mcpUrl = new URL(`${env.publicUrl}/mcp`);

  app.get('/health', async (_req, res) => {
    try {
      const r = await withGlobal((db) => db.query(`select extract(epoch from now() - coalesce(max(at), 'epoch')) as age from admin_audit where action = 'worker_heartbeat'`));
      res.json({ ok: true, version: env.version, db: true, worker_heartbeat_age_s: Math.round(Number(r.rows[0]?.age ?? -1)) });
    } catch {
      res.status(503).json({ ok: false, version: env.version, db: false });
    }
  });

  // Лендинг taskano.app (точка входа продукта): один статичный файл, шрифты — Google Fonts.
  const landing = fileURLToPath(new URL('./site/index.html', import.meta.url));
  // Внутренний режим: лендинг и документация не зовут посторонних подключаться.
  const internal = fileURLToPath(new URL('./site/internal.html', import.meta.url));
  app.get('/', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.sendFile(env.internalOnly ? internal : landing);
  });

  // Правовые страницы: их требует каталог коннекторов, но нужны они не поэтому — продукт хранит
  // чужую рабочую переписку и имена сотрудников, и человек вправе прочитать, что именно с ней
  // происходит. Рядом — документация (/docs): карточка коннектора в каталоге требует ссылку на неё.
  // Адреса без расширения: на них ссылаются письма и карточка коннектора.
  for (const page of ['docs', 'privacy', 'terms', 'support'] as const) {
    const file = fileURLToPath(new URL(`./site/${page}.html`, import.meta.url));
    app.get(`/${page}`, (_req, res) => {
      res.set('Cache-Control', 'public, max-age=300');
      res.sendFile(page === 'docs' && env.internalOnly ? internal : file);
    });
  }
  // Иконки сайта: вкладка, «На экран Домой» на iPhone (он ищет /apple-touch-icon.png и без ссылки) и
  // Android (manifest). Картинки — логотип владельца продукта.
  for (const file of ['favicon.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'logo-96.png', 'site.webmanifest'] as const) {
    const path = fileURLToPath(new URL(`./site/${file}`, import.meta.url));
    app.get(`/${file}`, (_req, res) => {
      res.set('Cache-Control', 'public, max-age=86400');
      if (file.endsWith('.webmanifest')) res.type('application/manifest+json');
      res.sendFile(path);
    });
  }
  // Подтверждение домена для каталога ChatGPT: OpenAI читает здесь токен из своего кабинета — ровно
  // строку, без JSON и перевода строки (developers.openai.com/plugins/deploy/submission).
  app.get('/.well-known/openai-apps-challenge', (_req, res) => {
    const token = env.openaiAppsChallenge;
    if (!token) { res.status(404).end(); return; }
    res.set('Cache-Control', 'no-store').type('text/plain').send(token);
  });
  const legalCss = fileURLToPath(new URL('./site/legal.css', import.meta.url));
  app.get('/legal.css', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(legalCss);
  });

  // Потолки OAuth-ручек SDK считают по `req.ip`, а за Cloudflare это адрес его узла, общий для многих
  // людей: посторонний, выбрав потолок, закрывал бы вход и регистрацию клиента всем за тем же узлом.
  // Считаем по адресу клиента, как остальные потолки (`clientKey`: IPv6 — по сети /56); пороги остаются у SDK.
  const byClient = { keyGenerator: (req: Parameters<typeof clientKey>[0]) => clientKey(req) };
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: issuer,
    resourceServerUrl: mcpUrl,
    resourceName: 'Taskano',
    scopesSupported: ['taskano'],
    authorizationOptions: { rateLimit: byClient },
    tokenOptions: { rateLimit: byClient },
    clientRegistrationOptions: { rateLimit: byClient },
    revocationOptions: { rateLimit: byClient },
  }));
  app.use(oauthPagesRouter());
  app.use(googleRouter(hooks.google));

  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });
  app.post('/mcp', express.json({ limit: '1mb' }), agentTokenMcp(), bearer, async (req, res) => {
    const userId = (req.auth?.extra as { userId?: string } | undefined)?.userId;
    if (!userId) { res.status(401).end(); return; }
    await serveMcp(req, res, { userId });
  });
  // Stateless-режим: сессий и SSE-потока нет. Но голый 405 видели люди: адрес коннектора, открытый
  // в браузере, был пустой страницей ошибки. Браузеру — инструкция подключения; программе без токена —
  // 401 с адресом метаданных, как на POST, чтобы клиент нашёл вход; с токеном — прежний 405.
  app.get('/mcp', (req, res, next) => {
    if (!req.headers.authorization && req.accepts(['html', 'json', 'text/event-stream']) === 'html') {
      res.redirect(302, '/docs#setup'); return;
    }
    next();
  }, bearer, (_req, res) => { res.status(405).set('Allow', 'POST').end(); });
  app.delete('/mcp', (_req, res) => { res.status(405).set('Allow', 'POST').end(); });

  // Чтение для программ человека по токену `tkr_…` (спека read-tokens): отдельно от /mcp и Mini App,
  // ни один из них этот токен не принимает.
  app.use('/api/read', readRoutes());

  hooks.extraRoutes?.(app);
  return app;
}
