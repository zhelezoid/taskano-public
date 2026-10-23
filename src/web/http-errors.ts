import type { Response } from 'express';
import { AppError } from '../core/errors.js';

// Ошибка ядра → код ответа. Общий для ручек приложения: один язык ошибок у всех разделов.

function errorStatus(code: AppError['code']): number {
  switch (code) {
    case 'not_found': return 404;
    case 'forbidden': return 403;
    case 'validation_failed': return 400;
    case 'stale_version':
    case 'result_required':
    case 'conflict':
      return 409;
    default:
      return 400;
  }
}

export function handleError(res: Response, e: unknown): void {
  if (e instanceof AppError) {
    res.status(errorStatus(e.code)).json({ code: e.code, message: e.message, details: e.details });
    return;
  }
  throw e;
}
