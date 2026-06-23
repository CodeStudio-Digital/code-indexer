import type { McpAuthClientError } from '../domain/errors.js';

export type Result<T> = { ok: true; value: T } | { ok: false; error: McpAuthClientError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T = never>(error: McpAuthClientError): Result<T> => ({ ok: false, error });
