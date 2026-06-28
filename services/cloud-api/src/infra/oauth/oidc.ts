/**
 * Generic OIDC provider for org SSO (Enterprise). Unlike the first-party adapters
 * (Google/GitHub/Microsoft) whose endpoints are hardcoded, an org's IdP is unknown
 * at build time, so we DISCOVER its endpoints from `${issuer}/.well-known/
 * openid-configuration` and build the same `OAuthProvider` shape. Email trust is
 * the id_token's `email_verified` (the caller additionally gates on the org's
 * allowed domains — see routes/sso.ts). PKCE S256, like every other adapter.
 */
import { decodeIdToken, type OAuthProvider, type ProviderProfile } from './port.js';

export interface OidcEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

/** Fetch the IdP's OIDC discovery doc → its authorize/token endpoints. Null on any
 *  failure (unreachable / malformed) so the route can fail soft. */
export async function discoverOidc(issuer: string): Promise<OidcEndpoints | null> {
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const doc = (await res.json()) as { authorization_endpoint?: unknown; token_endpoint?: unknown };
    if (typeof doc.authorization_endpoint !== 'string' || typeof doc.token_endpoint !== 'string') return null;
    return { authorizationEndpoint: doc.authorization_endpoint, tokenEndpoint: doc.token_endpoint };
  } catch {
    return null;
  }
}

export function oidcProvider(id: string, clientId: string, clientSecret: string, ep: OidcEndpoints): OAuthProvider {
  return {
    id,
    authorizeUrl({ state, redirectUri, codeChallenge }) {
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      return `${ep.authorizationEndpoint}?${q.toString()}`;
    },
    async exchangeCode({ code, redirectUri, codeVerifier }): Promise<ProviderProfile> {
      const res = await fetch(ep.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`oidc_token_${res.status}`);
      const tok = (await res.json()) as { id_token?: string };
      const claims = decodeIdToken(tok.id_token);
      const sub = claims?.sub;
      if (!sub) throw new Error('oidc_no_sub');
      const ev = claims?.email_verified;
      return {
        providerUserId: String(sub),
        email: typeof claims?.email === 'string' ? claims.email : null,
        emailVerified: ev === true || ev === 'true',
        name: typeof claims?.name === 'string' ? claims.name : null,
      };
    },
  };
}

/** The anti-takeover domain gate: an SSO email is only trusted when its domain is on
 *  the org's allow-list (lowercased compare). Pure → unit-tested. */
export function isEmailDomainAllowed(email: string | null, allowedDomains: readonly string[]): boolean {
  if (!email) return false;
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return allowedDomains.some((d) => d.trim().toLowerCase() === domain);
}
