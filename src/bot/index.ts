// Точка входа модуля бота — спека telegram-bot.
export { createBot, type CreateBotOptions } from './bot.js';
export { botRoutes, setupWebhook, startPolling } from './routes.js';
export { deliverNotification, setDeliveryApi, type DeliveryResult } from './deliver.js';
