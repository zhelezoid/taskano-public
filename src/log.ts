import pino from 'pino';
import { env } from './config/env.js';

// Версия в каждой строке лога — поведение трассируется по логам (стандарт владельца).
export const logger = pino({ level: env.logLevel, base: { version: env.version } });
