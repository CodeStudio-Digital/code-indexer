import type {
  AuthPollResult,
  AuthStartResult,
  ProviderAuthContext,
  ProviderResolveCredentialsContext,
  ResolvedCreds,
  StoredOAuth,
} from '@mcp/provider-sdk';

const COPILOT_CLIENT_ID = '01ab8ac9400c4e429b23';
const UA = 'GitHubCopilotChat/0.26.7';
const EDITOR_VERSION = 'vscode/1.95.0';
const EDITOR_PLUGIN_VERSION = 'copilot-chat/0.26.7';

export type CopilotEdition = 'individual' | 'enterprise';

export interface CopilotOAuthOptions {
  edition: CopilotEdition;
  ghes_host?: string;
  integration_id?: string;
  client_id?: string;
}

interface Endpoints {
  deviceCodeUrl: string;
  accessTokenUrl: string;
  copilotTokenUrl: string;
  clientId: string;
  integrationId: string;
}

export async function startCopilotAuth(
  ctx: ProviderAuthContext,
  input?: unknown,
): Promise<
  AuthStartResult & {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
    opts: CopilotOAuthOptions;
  }
> {
  const opts = parseCopilotOpts(input);
  const ep = resolveEndpoints(opts);
  const response = await ctx.fetch(ep.deviceCodeUrl, {
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
  if (!response.ok) {
    throw new Error(`GitHub device code request failed: HTTP ${response.status} ${await response.text()}`);
  }
  const flow = (await response.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };
  return {
    userCode: flow.user_code,
    verificationUri: flow.verification_uri,
    interval: flow.interval,
    device_code: flow.device_code,
    user_code: flow.user_code,
    verification_uri: flow.verification_uri,
    expires_in: flow.expires_in,
    opts,
  };
}

export async function pollCopilotAuth(
  ctx: ProviderAuthContext,
  state: unknown,
): Promise<
  AuthPollResult & {
    access_token?: string;
    refresh_token?: string;
    expires_at?: number;
    scope?: string;
    endpoints?: Record<string, string>;
    extra?: Record<string, unknown>;
    opts?: CopilotOAuthOptions;
  }
> {
  const body = state && typeof state === 'object' && !Array.isArray(state)
    ? (state as Record<string, unknown>)
    : {};
  const deviceCode = readString(body.device_code);
  if (!deviceCode) return { status: 'error', message: 'device_code required' };
  const opts = parseCopilotOpts(body.opts ?? body);
  const github = await pollGitHubDeviceFlow(ctx, deviceCode, opts);
  if (github.status !== 'authorized') return github;

  const copilot = await exchangeForCopilotToken(ctx, github.access_token, opts);
  return {
    status: 'authorized',
    access_token: copilot.token,
    refresh_token: github.access_token,
    expires_at: copilot.expires_at,
    scope: github.scope,
    endpoints: copilot.endpoints,
    extra: { ...copilot.extra, copilot_opts: opts },
    opts,
  };
}

export async function logoutCopilotAuth(ctx: ProviderAuthContext): Promise<void> {
  await ctx.credentials.clear();
}

export async function resolveCopilotCredentials(
  ctx: ProviderResolveCredentialsContext,
): Promise<ResolvedCreds> {
  const { config, credentials, log } = ctx;
  let token = config.api_key ?? '';

  try {
    const fresh = await refreshIfExpired(ctx);
    if (fresh) {
      token = fresh;
      if (fresh !== config.api_key) {
        await credentials.mirrorApiKey(fresh);
      }
    }
  } catch (err) {
    log(`refresh failed: ${(err as Error).message}`);
  }

  const stored = await credentials.get();
  const opts = getStoredCopilotOpts(stored);
  const endpoints = readRecord(stored?.extra?.endpoints);
  const baseURL = (readString(endpoints?.api) ?? config.base_url ?? 'https://api.githubcopilot.com').replace(/\/$/, '');
  const headers = copilotHeaders(token, opts);
  delete (headers as { Authorization?: string }).Authorization;

  return {
    apiKey: token,
    baseURL,
    extraHeaders: headers,
    extra: { copilotOpts: opts },
  };
}

async function pollGitHubDeviceFlow(
  ctx: ProviderAuthContext,
  deviceCode: string,
  opts: CopilotOAuthOptions,
): Promise<
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'authorized'; access_token: string; scope: string }
> {
  const ep = resolveEndpoints(opts);
  const response = await ctx.fetch(ep.accessTokenUrl, {
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
  if (!response.ok) {
    throw new Error(`GitHub poll failed: HTTP ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as {
    error?: string;
    interval?: number;
    access_token?: string;
    scope?: string;
  };
  if (data.error === 'authorization_pending' || data.error === 'slow_down') return { status: 'pending' };
  if (data.error === 'expired_token' || data.error === 'access_denied') return { status: 'expired' };
  if (data.access_token) return { status: 'authorized', access_token: data.access_token, scope: data.scope ?? '' };
  throw new Error(`Unexpected GitHub poll response: ${JSON.stringify(data)}`);
}

async function refreshIfExpired(ctx: ProviderResolveCredentialsContext): Promise<string | null> {
  const tok = await ctx.credentials.get();
  if (!tok?.refresh_token) return null;

  const now = Date.now();
  const stillValid = tok.expires_at && tok.expires_at - now > 60_000;
  if (stillValid) return tok.access_token;

  const opts = getStoredCopilotOpts(tok);
  const fresh = await exchangeForCopilotToken(ctx, tok.refresh_token, opts);
  await ctx.credentials.set({
    access_token: fresh.token,
    refresh_token: tok.refresh_token,
    expires_at: fresh.expires_at,
    scope: tok.scope,
    extra: { ...tok.extra, ...fresh.extra, copilot_opts: opts },
  });
  return fresh.token;
}

async function exchangeForCopilotToken(
  ctx: ProviderResolveCredentialsContext,
  githubToken: string,
  opts: CopilotOAuthOptions,
): Promise<{
  token: string;
  expires_at: number;
  endpoints?: Record<string, string>;
  extra: Record<string, unknown>;
}> {
  const ep = resolveEndpoints(opts);
  const response = await ctx.fetch(ep.copilotTokenUrl, {
    headers: copilotHeaders(githubToken, opts, 'token'),
  });
  if (!response.ok) {
    throw new Error(`Copilot token exchange failed: HTTP ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as {
    token: string;
    expires_at: number;
    refresh_in?: number;
    endpoints?: Record<string, string>;
  };
  return {
    token: data.token,
    expires_at: data.expires_at * 1000,
    endpoints: data.endpoints,
    extra: {
      refresh_in: data.refresh_in,
      endpoints: data.endpoints,
    },
  };
}

export function copilotHeaders(
  token: string,
  opts: CopilotOAuthOptions,
  scheme: 'bearer' | 'token' = 'bearer',
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

export function getStoredCopilotOpts(tokens: StoredOAuth | null | undefined): CopilotOAuthOptions {
  const raw = tokens?.extra?.copilot_opts;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const opts = raw as Partial<CopilotOAuthOptions>;
    if (opts.edition === 'enterprise') {
      return {
        edition: 'enterprise',
        ghes_host: opts.ghes_host,
        integration_id: opts.integration_id,
        client_id: opts.client_id,
      };
    }
  }
  return { edition: 'individual' };
}

export function parseCopilotOpts(input: unknown): CopilotOAuthOptions {
  const body = input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
  const edition = body.edition === 'enterprise' ? 'enterprise' : 'individual';
  return {
    edition,
    ghes_host: readString(body.ghes_host),
    integration_id: readString(body.integration_id),
    client_id: readString(body.client_id),
  };
}

function resolveEndpoints(opts: CopilotOAuthOptions): Endpoints {
  if (opts.edition === 'enterprise') {
    if (!opts.ghes_host) {
      throw new Error('enterprise edition requires ghes_host');
    }
    const host = opts.ghes_host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    return {
      deviceCodeUrl: `https://${host}/login/device/code`,
      accessTokenUrl: `https://${host}/login/oauth/access_token`,
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

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
