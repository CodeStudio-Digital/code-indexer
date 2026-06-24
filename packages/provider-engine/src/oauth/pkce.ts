import { createHash, randomBytes } from 'node:crypto';

/** base64url (no padding) — matches the helper duplicated in services/oauth/*. */
export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface PkcePair {
  code_verifier: string;
  code_challenge: string;
  method: 'S256';
}

/**
 * RFC 7636 S256 PKCE pair — the single source for what was 3 identical
 * `generatePkce()` copies (oauth/openai.ts, google.ts, claude-code.ts).
 */
export function createPkcePair(): PkcePair {
  const code_verifier = base64url(randomBytes(32));
  const code_challenge = base64url(createHash('sha256').update(code_verifier).digest());
  return { code_verifier, code_challenge, method: 'S256' };
}

/** Opaque CSRF state value (verified on the loopback callback). */
export function randomState(): string {
  return base64url(randomBytes(16));
}
