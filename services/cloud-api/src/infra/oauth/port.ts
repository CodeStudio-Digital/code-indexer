/** OAuth provider port — each adapter (Google/GitHub/Microsoft) turns an auth
 *  code into a normalized profile. The worker holds the client secret; the desktop
 *  never sees it. `emailVerified` is the SINGLE trust signal the linking use-case
 *  relies on — each adapter is responsible for setting it correctly (see github.ts). */
import { base64urlToBytes } from '../base64url.js';

export interface ProviderProfile {
  /** Stable, immutable subject id from the provider (NEVER the email). */
  providerUserId: string;
  email: string | null;
  /** True ONLY when the provider asserts the email is verified. */
  emailVerified: boolean;
  name: string | null;
}

export interface OAuthProvider {
  readonly id: string;
  authorizeUrl(p: { state: string; redirectUri: string; codeChallenge: string }): string;
  exchangeCode(p: { code: string; redirectUri: string; codeVerifier: string }): Promise<ProviderProfile>;
}

/** Decode the (unverified) payload of an OIDC id_token. Safe to skip signature
 *  verification because we fetched the token DIRECTLY from the provider's token
 *  endpoint over TLS (server-to-server) — it was never handled by the client. */
export function decodeIdToken(idToken: string | undefined): Record<string, unknown> | null {
  if (!idToken) return null;
  const parts = idToken.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(new TextDecoder().decode(base64urlToBytes(parts[1]))) as Record<string, unknown>;
  } catch {
    return null;
  }
}
