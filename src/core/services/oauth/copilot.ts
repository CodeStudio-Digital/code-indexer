/**
 * GitHub Copilot OAuth device flow.
 *
 * Supports two editions:
 *   - individual: github.com + api.github.com + api.githubcopilot.com
 *     (Copilot Individual / Business — uses VS Code's public client id).
 *   - enterprise: a GitHub Enterprise Server (GHES) host. Device flow and
 *     token exchange happen on the GHES domain; the returned token exchange
 *     response includes `endpoints.api` pointing at the right Copilot API
 *     edge for that enterprise (we honor it verbatim).
 *
 * Flow (both editions):
 *   1. startDeviceFlow(opts) → POST {host}/login/device/code
 *   2. pollDeviceFlow(device_code, opts) → POST {host}/login/oauth/access_token
 *      until authorized; returns GitHub PAT.
 *   3. exchangeForCopilotToken(githubToken, opts) → GET
 *      {token_host}/copilot_internal/v2/token — returns the short-lived
 *      Copilot API token (expires ~25min) and `endpoints` map.
 *   4. refreshIfExpired(store, providerId) → reads the opts back out of
 *      oauth_tokens.extra.copilot_opts and re-exchanges the stored PAT.
 *
 * The GitHub PAT is stored in oauth_tokens.refresh_token; the short-lived
 * Copilot token in oauth_tokens.access_token + expires_at.
 */
import type { ProviderStore } from '../../../store/provider-store.js';

// VS Code's public Copilot client id, documented in the GitHub Copilot
// client library and used by all OSS Copilot integrations. This is not a
// secret — it's the public identifier for the device flow.
const COPILOT_CLIENT_ID = '01ab8ac9400c4e429b23';

const UA = 'GitHubCopilotChat/0.26.7';
const EDITOR_VERSION = 'vscode/1.95.0';
const EDITOR_PLUGIN_VERSION = 'copilot-chat/0.26.7';

export type CopilotEdition = 'individual' | 'enterprise';

export interface CopilotOAuthOptions {
  edition: CopilotEdition;
  /** GHES host for enterprise edition, e.g. "github.acme.com" (no scheme). */
  ghes_host?: string;
  /** Copilot-Integration-Id header. Defaults by edition. */
  integration_id?: string;
  /** Override client_id (some GHES instances register their own). */
  client_id?: string;
}

export interface DeviceFlowStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface Endpoints {
  deviceCodeUrl: string;
  accessTokenUrl: string;
  copilotTokenUrl: string;
  clientId: string;
  integrationId: string;
}

function normalizeHost(host: string): string {
  return host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

function resolveEndpoints(opts: CopilotOAuthOptions): Endpoints {
  if (opts.edition === 'enterprise') {
    if (!opts.ghes_host) {
      throw new Error('enterprise edition requires ghes_host (e.g. "github.acme.com")');
    }
    const host = normalizeHost(opts.ghes_host);
    return {
      deviceCodeUrl: `https://${host}/login/device/code`,
      accessTokenUrl: `https://${host}/login/oauth/access_token`,
      // GHES mounts the REST API under /api/v3.
      copilotTokenUrl: `https://${host}/api/v3/copilot_internal/v2/token`,
      clientId: opts.client_id ?? COPILOT_CLIENT_ID,
      integrationId: opts.integration_id ?? 'copilot-chat',
    };
  }
  return {
    deviceCodeUrl: 'https://github.com/login/device/code',
    accessTokenUrl: 'https://github.com/login/oauth/access_token',
    copilotTokenUrl: 'https://api.github.com/copilot_internal/v2/token',
    clientId: opts.client_id ?? COPILOT_CLIENT_ID,
    integrationId: opts.integration_id ?? 'vscode-chat',
  };
}

/**
 * Build the header set the Copilot API requires on every request
 * (token exchange, /models, /chat/completions). Used by both this module
 * and the admin model-discovery path so behavior stays in sync.
 */
export function copilotHeaders(
  token: string,
  opts: CopilotOAuthOptions,
  scheme: 'bearer' | 'token' = 'bearer'
): Record<string, string> {
  const ep = resolveEndpoints(opts);
  return {
    Authorization: scheme === 'token' ? `token ${token}` : `Bearer ${token}`,
    Accept: 'application/json',
    'User-Agent': UA,
    'Editor-Version': EDITOR_VERSION,
    'Editor-Plugin-Version': EDITOR_PLUGIN_VERSION,
    'Copilot-Integration-Id': ep.integrationId,
  };
}

/**
 * Kick off the device flow. Returns the code the user needs to type at
 * verification_uri. Does not block.
 */
export async function startDeviceFlow(
  opts: CopilotOAuthOptions = { edition: 'individual' }
): Promise<DeviceFlowStart> {
  const ep = resolveEndpoints(opts);
  const r = await fetch(ep.deviceCodeUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': UA,
    },
    body: JSON.stringify({
      client_id: ep.clientId,
      scope: 'read:user',
    }),
  });
  if (!r.ok) {
    throw new Error(`GitHub device code request failed: HTTP ${r.status} ${await r.text()}`);
  }
  return (await r.json()) as DeviceFlowStart;
}

/**
 * One-shot poll for the device flow. Returns:
 *   { status: 'pending' }                 — user hasn't completed yet
 *   { status: 'slow_down', interval }     — caller should increase interval
 *   { status: 'expired' }                 — device_code invalid; start over
 *   { status: 'authorized', access_token }— GitHub PAT ready for exchange
 */
export async function pollDeviceFlow(
  deviceCode: string,
  opts: CopilotOAuthOptions = { edition: 'individual' }
): Promise<
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'expired' }
  | { status: 'authorized'; access_token: string; scope: string }
> {
  const ep = resolveEndpoints(opts);
  const r = await fetch(ep.accessTokenUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': UA,
    },
    body: JSON.stringify({
      client_id: ep.clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  if (!r.ok) {
    throw new Error(`GitHub poll failed: HTTP ${r.status} ${await r.text()}`);
  }
  const data = (await r.json()) as {
    error?: string;
    interval?: number;
    access_token?: string;
    scope?: string;
  };
  if (data.error === 'authorization_pending') return { status: 'pending' };
  if (data.error === 'slow_down') return { status: 'slow_down', interval: data.interval ?? 10 };
  if (data.error === 'expired_token' || data.error === 'access_denied') return { status: 'expired' };
  if (data.access_token) {
    return { status: 'authorized', access_token: data.access_token, scope: data.scope ?? '' };
  }
  throw new Error(`Unexpected GitHub poll response: ${JSON.stringify(data)}`);
}

/**
 * Exchange a long-lived GitHub PAT for a short-lived Copilot API token.
 * Returns the token, its expiry (ms epoch), and the `endpoints` map the
 * server publishes — the coder adapter / model-discovery should prefer
 * `endpoints.api` when hitting /models and /chat/completions.
 */
export async function exchangeForCopilotToken(
  githubToken: string,
  opts: CopilotOAuthOptions = { edition: 'individual' }
): Promise<{
  token: string;
  expires_at: number;
  endpoints?: Record<string, string>;
  extra: Record<string, unknown>;
}> {
  const ep = resolveEndpoints(opts);
  const r = await fetch(ep.copilotTokenUrl, {
    headers: copilotHeaders(githubToken, opts, 'token'),
  });
  if (!r.ok) {
    throw new Error(
      `Copilot token exchange failed: HTTP ${r.status} ${await r.text()}. ` +
        `Common causes: GitHub account doesn't have Copilot, or the PAT is invalid.`
    );
  }
  const data = (await r.json()) as {
    token: string;
    expires_at: number;
    refresh_in?: number;
    endpoints?: Record<string, string>;
  };
  return {
    token: data.token,
    // expires_at from GitHub is in seconds since epoch; normalize to ms.
    expires_at: data.expires_at * 1000,
    endpoints: data.endpoints,
    extra: {
      refresh_in: data.refresh_in,
      endpoints: data.endpoints,
    },
  };
}

/**
 * Read the edition options stashed in oauth_tokens.extra at connect time.
 * Falls back to individual so pre-upgrade tokens keep working.
 */
export function getStoredCopilotOpts(
  store: ProviderStore,
  providerId: string
): CopilotOAuthOptions {
  const tok = store.getOAuth(providerId);
  const extra = (tok?.extra ?? {}) as { copilot_opts?: CopilotOAuthOptions };
  if (extra.copilot_opts && extra.copilot_opts.edition) {
    return extra.copilot_opts;
  }
  return { edition: 'individual' };
}

/**
 * Ensure the Copilot API token stored for a provider is fresh. If it's
 * within 60s of expiry (or absent), re-exchange the stored GitHub PAT.
 * Returns the current valid token, or null if the provider has no stored
 * credentials (the UI should redirect to startDeviceFlow).
 */
export async function refreshIfExpired(
  store: ProviderStore,
  providerId: string
): Promise<string | null> {
  const tok = store.getOAuth(providerId);
  if (!tok || !tok.refresh_token) return null;

  const now = Date.now();
  const stillValid = tok.expires_at && tok.expires_at - now > 60_000;
  if (stillValid) return tok.access_token;

  const opts = getStoredCopilotOpts(store, providerId);
  const fresh = await exchangeForCopilotToken(tok.refresh_token, opts);
  store.setOAuth({
    provider_id: providerId,
    access_token: fresh.token,
    refresh_token: tok.refresh_token, // Preserve the GitHub PAT.
    expires_at: fresh.expires_at,
    scope: tok.scope,
    extra: { ...tok.extra, ...fresh.extra, copilot_opts: opts },
  });
  return fresh.token;
}
