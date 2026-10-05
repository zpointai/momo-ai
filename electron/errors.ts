import type { ErrorCode, Result } from '../src/shared/contracts';
export class AppError extends Error { constructor(public readonly code: ErrorCode, message: string) { super(message); } }
export function failure(error: unknown): Result<never> {
  return error instanceof AppError
    ? { ok: false, error: { code: error.code, message: error.message } }
    : { ok: false, error: { code: 'internal', message: 'MoMo could not complete this local operation. Your data has been preserved.' } };
}

