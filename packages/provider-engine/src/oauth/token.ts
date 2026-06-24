import type { AuthDescriptor } from '@mcp/provider-sdk';

export interface OAuthTokenSet {
  access_token: string;
  refresh_token?: string | null;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

type FetchLike = typeof fetch;

function postForm(url: string, params: Record<string, string>, fetchImpl: FetchLike) {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

async function tokenRequest(
  auth: AuthDescriptor,
  params: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<OAuthTokenSet> {
  if (!auth.tokenUrl) throw new Error('provider-engine/oauth: spec.auth has no tokenUrl');
  const r = await postForm(auth.tokenUrl, params, fetchImpl);
  if (!r.ok) throw new Error(`OAuth token HTTP ${r.status} ${await r.text()}`);
  return (await r.json()) as OAuthTokenSet;
}

/**
 * RFC 6749 §4.1.3 authorization_code → token exchange. `client_secret` is sent
 * only when the spec carries one (google's confidential desktop secret).
 */
export function exchangeAuthorizationCode(
  auth: AuthDescriptor,
  opts: { code: string; redirectUri: string; codeVerifier: string; fetchImpl?: FetchLike },
): Promise<OAuthTokenSet> {
  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: auth.clientId ?? '',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  };
  if (auth.clientSecret) params.client_secret = auth.clientSecret;
  return tokenRequest(auth, params, opts.fetchImpl ?? fetch);
}

/**
 * RFC 6749 §6 refresh_token grant. The CALLER is responsible for the rotation
 * rule (`response.refresh_token ?? stored`) + extra-merge + api_key mirror when
 * persisting — see {@link applyRefresh}.
 */
export function refreshTokenGrant(
  auth: AuthDescriptor,
  opts: { refreshToken: string; scope?: string; fetchImpl?: FetchLike },
): Promise<OAuthTokenSet> {
  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    client_id: auth.clientId ?? '',
    refresh_token: opts.refreshToken,
  };
  if (opts.scope) params.scope = opts.scope;
  if (auth.clientSecret) params.client_secret = auth.clientSecret;
  return tokenRequest(auth, params, opts.fetchImpl ?? fetch);
}

export interface StoredOAuthLike {
  access_token: string;
  refresh_token?: string | null;
  expires_at?: number | null;
  scope?: string | null;
  extra?: Record<string, unknown>;
}

/**
 * Fold a refresh-grant response into the NEXT stored token, preserving the
 * lockout-critical invariants every provider relies on:
 *  - keep the old refresh_token when the server omits one (rotation-tolerant);
 *  - MERGE `extra` (never reset it — carries id_token / projectId / device_id);
 *  - recompute expires_at.
 * Returns the row to persist via `store.setOAuth` (+ the api_key mirror is the
 * caller's responsibility).
 */
export function applyRefresh(
  providerId: string,
  prev: StoredOAuthLike,
  resp: OAuthTokenSet,
): {
  provider_id: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
  scope: string | null;
  extra: Record<string, unknown>;
} {
  const expires_in = resp.expires_in ?? 3600;
  return {
    provider_id: providerId,
    access_token: resp.access_token,
    refresh_token: resp.refresh_token ?? prev.refresh_token ?? null,
    expires_at: Date.now() + expires_in * 1000,
    scope: prev.scope ?? null,
    extra: { ...(prev.extra ?? {}), ...(resp.id_token ? { id_token: resp.id_token } : {}) },
  };
}
