/**
 * IdentityError — the bounded context's discriminated-union error type, mirroring
 * `packages/services/src/auth/domain/errors.ts`. Codes are stable + snake_case;
 * `identityHttpStatus` is the EXHAUSTIVE mapper the interface layer uses to turn
 * any identity failure into an HTTP status (the kernel default is only a fallback).
 */
import type { DomainError, HttpStatusMapper } from '@cloudstudio/cloud-kernel';

export type IdentityError =
  | (DomainError & { code: 'email_invalid' })
  | (DomainError & { code: 'password_too_weak' })
  | (DomainError & { code: 'password_mismatch' })
  | (DomainError & { code: 'email_already_registered' })
  | (DomainError & { code: 'invalid_credentials' })
  | (DomainError & { code: 'account_locked'; details?: { retryAfterMs: number } })
  | (DomainError & { code: 'account_deleted' })
  | (DomainError & { code: 'email_not_verified' })
  | (DomainError & { code: 'twofa_required'; details?: { challengeToken: string } })
  | (DomainError & { code: 'twofa_invalid' })
  | (DomainError & { code: 'refresh_invalid' })
  | (DomainError & { code: 'refresh_expired' })
  | (DomainError & { code: 'token_reuse' })
  | (DomainError & { code: 'session_not_found' })
  | (DomainError & { code: 'email_token_invalid' })
  | (DomainError & { code: 'oauth_no_email' })
  | (DomainError & { code: 'rate_limited'; details?: { retryAfterMs: number } });

type Code = IdentityError['code'];

const STATUS: Record<Code, number> = {
  email_invalid: 400,
  password_too_weak: 400,
  password_mismatch: 400,
  email_already_registered: 409,
  invalid_credentials: 401,
  account_locked: 423,
  account_deleted: 403,
  email_not_verified: 403,
  twofa_required: 401,
  twofa_invalid: 401,
  refresh_invalid: 401,
  refresh_expired: 401,
  token_reuse: 409,
  session_not_found: 404,
  email_token_invalid: 400,
  oauth_no_email: 400,
  rate_limited: 429,
};

export const identityHttpStatus: HttpStatusMapper<IdentityError> = (e) => STATUS[e.code];

/** Small constructors so use-cases stay terse and messages stay consistent + safe. */
export const IdentityErrors = {
  emailInvalid: (): IdentityError => ({ code: 'email_invalid', message: 'Enter a valid email address.' }),
  passwordTooWeak: (reasons: string[]): IdentityError => ({
    code: 'password_too_weak',
    message: 'Password does not meet the requirements.',
    details: { reasons },
  }),
  emailTaken: (): IdentityError => ({
    code: 'email_already_registered',
    // Deliberately generic-ish but actionable; signup enumeration is mitigated by
    // rate-limiting + (Phase 2) "we sent a link if this email is new" UX.
    message: 'That email is already registered.',
  }),
  invalidCredentials: (): IdentityError => ({ code: 'invalid_credentials', message: 'Email or password is incorrect.' }),
  accountLocked: (retryAfterMs: number): IdentityError => ({
    code: 'account_locked',
    message: 'Too many attempts. Try again later.',
    details: { retryAfterMs },
  }),
  emailNotVerified: (): IdentityError => ({ code: 'email_not_verified', message: 'Confirm your email to continue.' }),
  refreshInvalid: (): IdentityError => ({ code: 'refresh_invalid', message: 'Session is no longer valid. Sign in again.' }),
  refreshExpired: (): IdentityError => ({ code: 'refresh_expired', message: 'Session expired. Sign in again.' }),
  tokenReuse: (): IdentityError => ({ code: 'token_reuse', message: 'Session was revoked for security. Sign in again.' }),
  twofaInvalid: (): IdentityError => ({ code: 'twofa_invalid', message: 'Invalid two-factor code.' }),
  emailTokenInvalid: (): IdentityError => ({ code: 'email_token_invalid', message: 'This link is invalid or has expired.' }),
  accountDeleted: (): IdentityError => ({ code: 'account_deleted', message: 'This account is no longer available.' }),
  oauthNoEmail: (): IdentityError => ({
    code: 'oauth_no_email',
    message: 'Your provider did not share a verified email. Grant email access or sign in on the web portal.',
  }),
  twofaRequired: (challengeToken: string): IdentityError => ({
    code: 'twofa_required',
    message: 'Two-factor code required.',
    details: { challengeToken },
  }),
};
