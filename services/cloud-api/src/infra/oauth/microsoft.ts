/** Microsoft OAuth (OIDC, `common` tenant by default). Subject = `oid` (stable
 *  per-tenant object id) falling back to `sub`. Email verification: Microsoft only
 *  asserts it via the optional `xms_edov` ("email domain owner verified") claim —
 *  when that's absent or false we treat the email as UNVERIFIED, so the account is
 *  created fresh rather than auto-linked (conservative, anti-takeover). PKCE S256. */
import { decodeIdToken, type OAuthProvider, type ProviderProfile } from './port.js';

export function microsoftProvider(clientId: string, clientSecret: string, tenant: string): OAuthProvider {
  const base = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
  return {
    id: 'microsoft',
    authorizeUrl({ state, redirectUri, codeChallenge }) {
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        response_mode: 'query',
      });
      return `${base}/authorize?${q.toString()}`;
    },
    async exchangeCode({ code, redirectUri, codeVerifier }): Promise<ProviderProfile> {
      const res = await fetch(`${base}/token`, {
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
      });
      if (!res.ok) throw new Error(`microsoft_token_${res.status}`);
      const tok = (await res.json()) as { id_token?: string };
      const claims = decodeIdToken(tok.id_token);
      const sub = claims?.oid ?? claims?.sub;
      if (!sub) throw new Error('microsoft_no_sub');
      const email =
        (typeof claims?.email === 'string' && claims.email) ||
        (typeof claims?.preferred_username === 'string' && claims.preferred_username.includes('@') ? claims.preferred_username : null) ||
        null;
      return {
        providerUserId: String(sub),
        email,
        emailVerified: claims?.xms_edov === true, // only the explicit verified-domain signal counts
        name: typeof claims?.name === 'string' ? claims.name : null,
      };
    },
  };
}
