/**
 * Result<T> — the explicit success/failure type every cloud use-case returns.
 * Mirrors `packages/services/src/auth/use-cases/result.ts` so the cloud surface
 * reads identically to the on-device auth subsystem we are extending.
 *
 * Discipline: domain failures are VALUES (`err(...)`), never thrown. Only truly
 * exceptional infrastructure faults (a dead D1, an OOM) throw — and those are
 * caught at the interface edge and mapped to a generic 500, never leaking
 * internals to the client.
 */
import type { DomainError } from './errors.js';

export type Result<T, E extends DomainError = DomainError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E extends DomainError>(error: E): Result<never, E> => ({ ok: false, error });

/** Type guards (let callers narrow without touching `.ok` directly). */
export const isOk = <T, E extends DomainError>(
  r: Result<T, E>,
): r is { readonly ok: true; readonly value: T } => r.ok;

export const isErr = <T, E extends DomainError>(
  r: Result<T, E>,
): r is { readonly ok: false; readonly error: E } => !r.ok;

/** Map the success channel, preserving the error untouched. */
export function mapResult<T, U, E extends DomainError>(
  r: Result<T, E>,
  f: (value: T) => U,
): Result<U, E> {
  return r.ok ? ok(f(r.value)) : r;
}

/** Chain another fallible step (railway composition). */
export async function andThen<T, U, E extends DomainError>(
  r: Result<T, E>,
  f: (value: T) => Promise<Result<U, E>>,
): Promise<Result<U, E>> {
  return r.ok ? f(r.value) : r;
}

/** Unwrap or throw — ONLY for tests / truly-cannot-fail call sites. */
export function unwrap<T, E extends DomainError>(r: Result<T, E>): T {
  if (!r.ok) throw new Error(`unwrap on err: ${r.error.code} — ${r.error.message}`);
  return r.value;
}
