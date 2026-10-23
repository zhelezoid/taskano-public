import type { Transformer } from 'grammy';

// Ограничитель отправки в Telegram — ~25 сообщений/с на бота (с запасом от лимита 30), 1/с в чат;
// повтор по retry_after при 429 (спека telegram-bot, edge cases). Тесты отключают паузы:
// `TASKANO_DISABLE_RATE_LIMIT=1` — интерцептор сети в тестах отвечает мгновенно, ждать нечего.

const GLOBAL_MIN_INTERVAL_MS = 1000 / 25;
const PER_CHAT_MIN_INTERVAL_MS = 1000;

let lastGlobalAt = 0;
const lastByChat = new Map<string | number, number>();

function disabled(): boolean {
  return process.env.TASKANO_DISABLE_RATE_LIMIT === '1';
}

function wait(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export const rateLimiter: Transformer = async (prev, method, payload, signal) => {
  if (!disabled()) {
    const chatId = (payload as { chat_id?: string | number }).chat_id;
    const now = Date.now();
    const sinceGlobal = now - lastGlobalAt;
    if (sinceGlobal < GLOBAL_MIN_INTERVAL_MS) await wait(GLOBAL_MIN_INTERVAL_MS - sinceGlobal);
    if (chatId !== undefined) {
      const last = lastByChat.get(chatId) ?? 0;
      const sinceChat = now - last;
      if (sinceChat < PER_CHAT_MIN_INTERVAL_MS) await wait(PER_CHAT_MIN_INTERVAL_MS - sinceChat);
    }
    lastGlobalAt = Date.now();
    if (chatId !== undefined) lastByChat.set(chatId, lastGlobalAt);
  }

  let result = await prev(method, payload, signal);
  if (!disabled() && !result.ok && result.error_code === 429 && result.parameters?.retry_after) {
    await wait(result.parameters.retry_after * 1000);
    result = await prev(method, payload, signal);
  }
  return result;
};
