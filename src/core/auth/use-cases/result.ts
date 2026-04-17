import type { AuthError } from '../domain/errors.js';

/**
 * Result<T> — poor-man's Either. Use-cases return this to avoid exceptions
 * for expected domain outcomes. Exceptions remain for programmer errors.
 */
export type Result<T> = { ok: true; value: T } | { ok: false; error: AuthError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T = never>(error: AuthError): Result<T> => ({ ok: false, error });
