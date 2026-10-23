export type ErrorCode =
  | 'validation_failed' | 'forbidden' | 'not_found' | 'idempotency_conflict' | 'agent_paused'
  | 'limit_exceeded' | 'invalid_transition' | 'stale_version' | 'result_required' | 'conflict';

export class AppError extends Error {
  constructor(public code: ErrorCode, message: string, public details?: unknown) {
    super(message);
    this.name = 'AppError';
  }
}

export const fail = (code: ErrorCode, message: string, details?: unknown): never => {
  throw new AppError(code, message, details);
};
