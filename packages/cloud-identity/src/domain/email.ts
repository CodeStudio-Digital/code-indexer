/**
 * Email value object. Construction validates format and produces a `canonical`
 * form used for the UNIQUE constraint (so 'User@Example.com ' and
 * 'user@example.com' collide). We intentionally keep canonicalization simple
 * (lowercase + trim) — provider-specific tricks (gmail dot/plus stripping) are
 * deliberately NOT applied, because collapsing distinct addresses a provider
 * treats as separate would let one person squat another's future address.
 */
import { type Result, ok, err } from '@cloudstudio/cloud-kernel';
import { IdentityErrors, type IdentityError } from './errors.js';

// Pragmatic RFC-5322-subset: one @, no spaces, a dot in the domain, bounded length.
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@.]{2,}$/;
const MAX_LEN = 254; // RFC 5321 max

export class Email {
  private constructor(
    readonly value: string,
    readonly canonical: string,
  ) {}

  static create(raw: string): Result<Email, IdentityError> {
    const trimmed = (raw ?? '').trim();
    if (trimmed.length === 0 || trimmed.length > MAX_LEN || !EMAIL_RE.test(trimmed)) {
      return err(IdentityErrors.emailInvalid());
    }
    const canonical = trimmed.toLowerCase();
    return ok(new Email(trimmed, canonical));
  }

  /** Re-hydrate a stored value without re-validating (trusted DB read). */
  static fromStored(value: string, canonical: string): Email {
    return new Email(value, canonical);
  }
}
