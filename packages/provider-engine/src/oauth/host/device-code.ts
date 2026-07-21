/**
 * Generic RFC-8628 device-code flow — the host primitive behind
 * `OAuthHostCapabilities.deviceCode`. Generalizes the Copilot device flow: the standard
 * mechanics (POST device_authorization → poll the token endpoint, handling
 * `authorization_pending` / `slow_down` / `expired_token`) live here ONCE; the
 * provider-specific bits plug in as DATA — per-provider `headers` (kimi's
 * `X-Msh-*`, copilot's editor headers) and the endpoints from `spec.auth`.
 *
 * This is a leaf: it imports only the `@mcp/provider-sdk` auth types + uses
 * `fetch`. NOT barrel-exported (kept off the registry's module graph, like the
 * rest of oauth/). The lockout-sensitive REFRESH path is NOT here — that stays
 * delegated to the battle-tested services/oauth functions (kimi tombstone +
 * rotation-race, copilot PAT→editor-token).
 */
import type { DeviceCodeFlow, StoredOAuth } from '@mcp/provider-sdk';

const RFC8628_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const DEFAULT_EXPIRES_IN = 3600;

export interface DeviceCodeOptions {
  /** Device-authorization endpoint (RFC-8628 §3.1). */
  deviceAuthUrl: string;
  /** Token endpoint (polled for completion). */
  tokenUrl: string;
  clientId: string;
  scope?: string;
  /** Provider-specific request headers (e.g. kimi `X-Msh-*`). */
  headers?: Record<string, string>;
  /** Token-poll grant type (default RFC-8628 device-code urn). */
  grantType?: string;
  /** Injected fetch (tests). Defaults to the global. */
  fetch?: typeof fetch;
}

function form(data: Record<string, string>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) body.set(k, v);
  return body;
}

async function readJson<T>(r: Response): Promise<T> {
  const text = await r.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return { error: text } as T;
  }
}

interface DeviceAuthResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_url?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

/**
 * Start a device-code flow. Returns the user-facing code + verification URL and
 * a `poll()` that drives the token endpoint per RFC-8628. On `authorized`, the
 * provider hook persists `tokens` (and does any post-exchange, e.g. copilot).
 */
export async function startDeviceCodeFlow(opts: DeviceCodeOptions): Promise<DeviceCodeFlow> {
  const doFetch = opts.fetch ?? fetch;
  const reqHeaders = {
    ...opts.headers,
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };

  const r = await doFetch(opts.deviceAuthUrl, {
    method: 'POST',
    headers: reqHeaders,
    body: form({ client_id: opts.clientId, ...(opts.scope ? { scope: opts.scope } : {}) }),
  });
  const body = await readJson<DeviceAuthResponse>(r);
  if (!r.ok) throw new Error(body.error_description ?? body.error ?? `HTTP ${r.status}`);
  const verificationUri = body.verification_uri ?? body.verification_url;
  if (!body.device_code || !body.user_code || !verificationUri) {
    throw new Error('device authorization response missing device_code/user_code/verification_uri');
  }

  const deviceCode = body.device_code;
  const grantType = opts.grantType ?? RFC8628_GRANT;
  let interval = body.interval ?? 5;
  const expiresAt = Date.now() + (body.expires_in ?? 600) * 1000;

  const poll: DeviceCodeFlow['poll'] = async () => {
    if (Date.now() > expiresAt) return { status: 'expired' };
    const tr = await doFetch(opts.tokenUrl, {
      method: 'POST',
      headers: reqHeaders,
      body: form({ client_id: opts.clientId, device_code: deviceCode, grant_type: grantType }),
    });
    const tb = await readJson<TokenResponse>(tr);
    if (!tr.ok) {
      if (tb.error === 'authorization_pending') return { status: 'pending' };
      if (tb.error === 'slow_down') {
        interval += 5;
        return { status: 'pending' };
      }
      if (tb.error === 'expired_token') return { status: 'expired' };
      throw new Error(tb.error_description ?? tb.error ?? `HTTP ${tr.status}`);
    }
    if (!tb.access_token) throw new Error('device token response missing access_token');
    const expiresIn = tb.expires_in ?? DEFAULT_EXPIRES_IN;
    const tokens: StoredOAuth = {
      access_token: tb.access_token,
      refresh_token: tb.refresh_token ?? null,
      expires_at: Date.now() + expiresIn * 1000,
      scope: tb.scope ?? null,
      extra: { token_type: tb.token_type ?? 'Bearer', expires_in: expiresIn },
    };
    return { status: 'authorized', tokens };
  };

  return {
    userCode: body.user_code,
    verificationUri,
    verificationUriComplete: body.verification_uri_complete,
    get interval() {
      return interval;
    },
    expiresAt,
    poll,
  };
}
