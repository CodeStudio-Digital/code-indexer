/**
 * DomainError — the discriminated-union base every bounded context extends.
 * Each context defines its own union (IdentityError, BillingError, …) whose
 * members carry a stable snake_case `code` + a safe `message`, mirroring
 * `packages/services/src/auth/domain/errors.ts`.
 *
 * The kernel owns only the SHAPE + a status-mapper contract, so the interface
 * layer can present ANY context's error through a single error presenter.
 * Each context SHOULD supply its own EXHAUSTIVE `HttpStatusMapper` (like
 * `authErrorHttpStatus`); `DEFAULT_ERROR_STATUS` is the safety net so an
 * unmapped code never accidentally leaks a 500 with internals.
 */
export interface DomainError {
  /** Stable, machine-readable, snake_case. e.g. 'email_already_registered'. */
  readonly code: string;
  /** Safe, user-facing message — no internals, no PII, no stack traces. */
  readonly message: string;
  /** Optional structured detail (zod fieldErrors, retryAfterMs, …). */
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Construct a DomainError literal while preserving the narrow `code` type. */
export function domainError<C extends string>(
  code: C,
  message: string,
  details?: Record<string, unknown>,
): DomainError & { readonly code: C } {
  return details ? { code, message, details } : { code, message };
}

/** A context's exhaustive code→HTTP status mapping. */
export type HttpStatusMapper<E extends DomainError> = (error: E) => number;

/** Fallback status when a context has no explicit mapping for a code. */
export const DEFAULT_ERROR_STATUS = 400;

/** Wire shape sent to clients — never includes anything beyond these fields. */
export interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Project a DomainError to the safe wire body (drops nothing sensitive — the
 *  domain already guarantees `message`/`details` are client-safe). */
export function toErrorBody(error: DomainError): ErrorBody {
  return error.details
    ? { code: error.code, message: error.message, details: error.details }
    : { code: error.code, message: error.message };
}
