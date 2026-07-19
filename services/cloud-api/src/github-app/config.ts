import type { Env } from '../env.js';
import type { GitHubAppConfig } from './types.js';

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/$/, '');
}

export function githubAppConfig(env: Env): GitHubAppConfig | null {
  const appId = Number(env.GITHUB_APP_ID);
  const slug = env.GITHUB_APP_SLUG?.trim();
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  const rawJwk = env.GITHUB_APP_PRIVATE_KEY_JWK?.trim();
  const stateSecret = (env.GITHUB_APP_STATE_SECRET ?? env.OAUTH_STATE_SECRET)?.trim();
  if (!Number.isSafeInteger(appId) || appId <= 0 || !slug || !clientId || !clientSecret || !rawJwk || !stateSecret || stateSecret.length < 32) {
    return null;
  }

  let privateKeyJwk: JsonWebKey;
  try {
    privateKeyJwk = JSON.parse(rawJwk) as JsonWebKey;
  } catch {
    return null;
  }
  if (privateKeyJwk.kty !== 'RSA' || !privateKeyJwk.n || !privateKeyJwk.e || !privateKeyJwk.d) return null;

  const host = (env.GITHUB_APP_HOST || 'github.com').trim().toLowerCase();
  return {
    appId,
    slug,
    clientId,
    clientSecret,
    privateKeyJwk,
    stateSecret,
    host,
    webUrl: normalizeBaseUrl(env.GITHUB_APP_WEB_URL || `https://${host}`),
    apiUrl: normalizeBaseUrl(env.GITHUB_APP_API_URL || (host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`)),
  };
}
