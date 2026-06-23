import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Verifies a PKCE S256 challenge: BASE64URL(SHA256(code_verifier)) === code_challenge.
 * Pure function — kept here so use-cases don't depend on node:crypto directly
 * everywhere; callers pass verifier + challenge strings only.
 */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (!codeVerifier || !codeChallenge) return false;
  const computed = createHash('sha256').update(codeVerifier, 'utf8').digest('base64url');
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(codeChallenge, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
