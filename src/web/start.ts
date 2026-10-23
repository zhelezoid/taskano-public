import type { Server } from 'node:http';
import { env } from '../config/env.js';
import { logger } from '../log.js';
import { closePools } from '../db/pool.js';
import { createApp } from './app.js';
import { miniappRoutes } from './miniapp-api.js';
import { runnerRoutes } from './runner-page.js';
import { botRoutes } from '../bot/routes.js';

// Роль web: MCP + OAuth + Mini App + страница исполнителя + webhook бота (спека pilot-deploy).
export async function startWeb(): Promise<Server> {
  const app = createApp({
    extraRoutes: (a) => {
      miniappRoutes(a);
      runnerRoutes(a);
      botRoutes(a);
    },
  });
  const server = app.listen(env.port);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const stop = (signal: string) => {
    logger.info({ signal }, 'web: остановка');
    server.close(() => { void closePools().finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  return server;
}
