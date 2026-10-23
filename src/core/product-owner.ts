import { env } from '../config/env.js';
import { logger } from '../log.js';

/**
 * Строка владельцу продукта в Telegram (OWNER_TELEGRAM_CHAT_ID) — о событиях продукта, а не
 * организации: например, компания, заведённая без инвайт-кода (спека open-signup). Не задан чат или
 * токен бота — молчит. Сбой отправки не валит вызов, ради которого пишем: это сведение, не действие.
 */
export async function notifyProductOwner(text: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const chat = env.ownerTelegramChatId;
  const token = env.telegramBotToken;
  if (!chat || !token) return;
  try {
    const r = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
    if (!r.ok) logger.warn({ status: r.status }, 'product owner notify: telegram refused');
  } catch (e) {
    logger.warn({ err: e }, 'product owner notify: failed');
  }
}
