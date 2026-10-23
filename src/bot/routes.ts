import { withGlobal } from '../db/pool.js';
import { setAppMenuButton } from './keyboards.js';
import { safeEqual } from '../core/crypto.js';
import express, { type Express } from 'express';
import { webhookCallback } from 'grammy';
import { env } from '../config/env.js';
import { logger } from '../log.js';
import { createBot } from './bot.js';

// Webhook бота и запуск — спека telegram-bot, «Технические детали».
// POST /tg/:botId (botId = 'main'), заголовок X-Telegram-Bot-Api-Secret-Token; в dev — long polling.

// edited_message и my_chat_member — рабочие группы (спека group-intake).
const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query', 'my_chat_member'] as const;

let bot: ReturnType<typeof createBot> | undefined;

function getBot(): ReturnType<typeof createBot> {
  bot ??= createBot({ token: env.telegramBotToken });
  return bot;
}

export function botRoutes(app: Express): void {
  app.post('/tg/:botId', express.json({ limit: '2mb' }), async (req, res) => {
    if (req.params.botId !== 'main') { res.status(404).end(); return; }
    if (!env.telegramWebhookSecret || !safeEqual(req.header('X-Telegram-Bot-Api-Secret-Token') ?? '', env.telegramWebhookSecret)) { res.status(401).end(); return; }
    try {
      await webhookCallback(getBot(), 'express')(req, res);
    } catch (e) {
      logger.error({ err: e }, 'tg webhook: обработка обновления упала');
      if (!res.headersSent) res.status(200).end();   // Telegram ретраит 5xx — сбой одного апдейта не должен множиться
    }
  });
}

export async function setupWebhook(): Promise<void> {
  const b = getBot();
  await b.api.setWebhook(`${env.publicUrl}/tg/main`, {
    secret_token: env.telegramWebhookSecret,
    allowed_updates: [...ALLOWED_UPDATES],
  });
  logger.info('telegram: webhook установлен');
  // Кнопка «Войти в приложение» слева от поля ввода: по умолчанию для всех, и на языке каждого, кто уже вошёл.
  await b.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Taskano', web_app: { url: `${env.publicUrl}/app/` } } });
  const linked = await withGlobal((db) => db.query(
    `select tl.chat_id, u.language from telegram_links tl join users u on u.id = tl.user_id where tl.blocked_at is null`,
  ));
  for (const row of linked.rows) await setAppMenuButton(b.api, Number(row.chat_id), row.language);
  logger.info({ chats: linked.rowCount }, 'telegram: кнопка приложения установлена');
}

export async function startPolling(): Promise<void> {
  const b = getBot();
  await b.api.deleteWebhook().catch(() => {});
  await b.start({ allowed_updates: [...ALLOWED_UPDATES] });
}
