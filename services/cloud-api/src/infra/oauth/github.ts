/**
 * GitHub OAuth (NOT OIDC). Subject = numeric user id. THE GOTCHA: GitHub's
 * `email` field may be public-but-unverified or null, so we NEVER trust it for
 * linking. We fetch `/user/emails` and set `emailVerified` ONLY from the entry
 * that is BOTH `primary` AND `verified`. No verified primary ⇒ emailVerified=false
 * ⇒ the linking use-case creates a fresh account instead of seizing an existing
 * one. This adapter is the SOLE place GitHub's verified status is decided.
 * (GitHub OAuth apps don't support PKCE; the signed `state` is the CSRF guard.)
 */
import type { OAuthProvider, ProviderProfile } from './port.js';

const UA = 'CodeStudio-Cloud';

export function githubProvider(clientId: string, clientSecret: string): OAuthProvider {
  return {
    id: 'github',
    authorizeUrl({ state, redirectUri }) {
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: 'read:user user:email',
        state,
        allow_signup: 'true',
      });
      return `https://github.com/login/oauth/authorize?${q.toString()}`;
    },
    async exchangeCode({ code, redirectUri }): Promise<ProviderProfile> {
      const tokRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
      });
      if (!tokRes.ok) throw new Error(`github_token_${tokRes.status}`);
      const tok = (await tokRes.json()) as { access_token?: string };
      if (!tok.access_token) throw new Error('github_no_token');
      const headers = { authorization: `Bearer ${tok.access_token}`, accept: 'application/vnd.github+json', 'user-agent': UA };

      const userRes = await fetch('https://api.github.com/user', { headers });
      if (!userRes.ok) throw new Error(`github_user_${userRes.status}`);
      const user = (await userRes.json()) as { id: number; name?: string | null; login?: string };

      // The ONLY trusted email source: the verified primary from /user/emails.
      let email: string | null = null;
      let emailVerified = false;
      const emailsRes = await fetch('https://api.github.com/user/emails', { headers });
      if (emailsRes.ok) {
        const emails = (await emailsRes.json()) as { email: string; primary: boolean; verified: boolean }[];
        const primary = Array.isArray(emails) ? emails.find((e) => e.primary && e.verified) : undefined;
        if (primary) {
          email = primary.email;
          emailVerified = true;
        }
      }
      return { providerUserId: String(user.id), email, emailVerified, name: user.name ?? user.login ?? null };
    },
  };
}
