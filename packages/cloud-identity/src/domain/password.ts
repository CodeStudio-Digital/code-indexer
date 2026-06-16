/**
 * Password value object — enforces the policy BEFORE any hashing happens.
 * It holds the plaintext only transiently (to hand to the PasswordHasher port);
 * it is never persisted, logged, or returned. The hashed form is a separate
 * branded type so the two can never be confused at a call site.
 */
import { type Result, ok, err, type Brand } from '@cloudstudio/cloud-kernel';
import { IdentityErrors, type IdentityError } from './errors.js';

/** A password hash string in the self-describing format
 *  `pbkdf2-sha256$<iterations>$<saltB64url>$<dkB64url>` (see infra/pbkdf2-hasher.ts).
 *  PBKDF2, not Argon2id: workerd forbids runtime WASM, so Argon2 can't run here. */
export type PasswordHash = Brand<string, 'PasswordHash'>;
export const asPasswordHash = (s: string): PasswordHash => s as PasswordHash;

const MIN_LEN = 12; // OWASP floor for a primary secret with MFA available
const MAX_LEN = 256; // cap to bound Argon2id CPU/DoS on absurd inputs

export class Password {
  private constructor(readonly plain: string) {}

  static create(raw: string): Result<Password, IdentityError> {
    const reasons = Password.policyViolations(raw ?? '');
    return reasons.length === 0 ? ok(new Password(raw)) : err(IdentityErrors.passwordTooWeak(reasons));
  }

  /** Pure policy check — also reused by the client for instant feedback. */
  static policyViolations(p: string): string[] {
    const reasons: string[] = [];
    if (p.length < MIN_LEN) reasons.push(`at_least_${MIN_LEN}_chars`);
    if (p.length > MAX_LEN) reasons.push(`at_most_${MAX_LEN}_chars`);
    if (/^(.)\1*$/.test(p) && p.length > 0) reasons.push('not_all_same_char');
    if (/^\s+$/.test(p)) reasons.push('not_only_whitespace');
    return reasons;
  }
}
