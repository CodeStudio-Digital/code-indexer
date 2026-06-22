/** Resolve a provider id → adapter, reading its client id/secret from env.
 *  Fail-soft: a provider whose secrets are unset returns null (the route 404s),
 *  mirroring how Stripe/Turnstile/share-signing degrade when their secret is absent. */
import type { Env } from '../../env.js';
import type { OAuthProvider } from './port.js';
import { googleProvider } from './google.js';
import { githubProvider } from './github.js';
import { microsoftProvider } from './microsoft.js';

export function providerFor(env: Env, id: string): OAuthProvider | null {
  switch (id) {
    case 'google':
      return env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET
        ? googleProvider(env.GOOGLE_OAUTH_CLIENT_ID, env.GOOGLE_OAUTH_CLIENT_SECRET)
        : null;
    case 'github':
      return env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET
        ? githubProvider(env.GITHUB_OAUTH_CLIENT_ID, env.GITHUB_OAUTH_CLIENT_SECRET)
        : null;
    case 'microsoft':
      return env.MS_OAUTH_CLIENT_ID && env.MS_OAUTH_CLIENT_SECRET
        ? microsoftProvider(env.MS_OAUTH_CLIENT_ID, env.MS_OAUTH_CLIENT_SECRET, env.MS_OAUTH_TENANT ?? 'common')
        : null;
    default:
      return null;
  }
}
