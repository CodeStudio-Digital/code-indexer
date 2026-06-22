/** Google OAuth (OIDC). `sub` is the immutable subject; `email_verified` is the
 *  trust signal. PKCE S256. */
import { decodeIdToken, type OAuthProvider, type ProviderProfile } from './port.js';

export function googleProvider(clientId: string, clientSecret: string): OAuthProvider {
  return {
    id: 'google',
    authorizeUrl({ state, redirectUri, codeChallenge }) {
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        access_type: 'online',
        prompt: 'select_account',
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
    },
    async exchangeCode({ code, redirectUri, codeVerifier }): Promise<ProviderProfile> {
      const res = await fetch('https://oauth2.googleapis.com/token', {
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
      if (!res.ok) throw new Error(`google_token_${res.status}`);
      const tok = (await res.json()) as { id_token?: string };
      const claims = decodeIdToken(tok.id_token);
      const sub = claims?.sub;
      if (!sub) throw new Error('google_no_sub');
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
