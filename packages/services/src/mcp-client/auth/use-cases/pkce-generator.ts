import { createHash, randomBytes } from 'node:crypto';

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/**
 * Generates a fresh PKCE code_verifier + S256 code_challenge pair.
 *
 * RFC 7636 §4.1: verifier is 43-128 chars from the unreserved URL set.
 * 32 random bytes → 43-char base64url is both minimum-legal and
 * sufficient entropy.
 *
 * Complementary to `verifyPkceS256` in `src/core/auth/use-cases/pkce.ts`
 * from the earlier work (which verifies on the server side when WE are the
 * AS). This one generates on the client side when we are the client.
 */
export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
  return { verifier, challenge, method: 'S256' };
}
