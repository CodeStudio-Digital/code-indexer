import { randomUUID } from 'node:crypto';
import { hostname, platform, release, type, version as osVersion } from 'node:os';
import type {
  AuthPollResult,
  AuthStartResult,
  ProviderAuthContext,
  ProviderResolveCredentialsContext,
  ResolvedCreds,
} from '@mcp/provider-sdk';

export const KIMI_CODE_CLIENT_ID =
  process.env.KIMI_CODE_CLIENT_ID ?? '17e5f671-d194-4dfb-9706-5516cb48c098';
export const KIMI_CODE_OAUTH_HOST =
  process.env.KIMI_CODE_OAUTH_HOST ?? process.env.KIMI_OAUTH_HOST ?? 'https://auth.kimi.com';
export const KIMI_CODE_BASE_URL =
  process.env.KIMI_CODE_BASE_URL ?? 'https://api.kimi.com/coding/v1';
const KIMI_CODE_CLIENT_VERSION = process.env.KIMI_CODE_CLIENT_VERSION ?? '1.36.0';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
const MIN_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;
const REFRESH_THRESHOLD_RATIO = 0.5;
const RETRYABLE_REFRESH_STATUS = new Set([429, 500, 502, 503, 504]);

interface PendingFlow {
  device_code: string;
  user_code: string;
  verification_url: string;
  verification_uri_complete?: string;
  expires_at: number;
  interval: number;
  device_id: string;
}

interface RejectedRefreshState {
  refresh_token: string;
  retry_after: number;
}

const pendingFlows = new Map<string, PendingFlow>();
const rejectedRefreshTokens = new Map<string, RejectedRefreshState>();

export async function startKimiCodeAuth(
  ctx: ProviderAuthContext,
): Promise<
  AuthStartResult & {
    state: string;
    user_code: string;
    device_code: string;
    verification_url: string;
    verification_uri: string;
    verification_uri_complete?: string;
    expires_at: number;
  }
> {
  const deviceId = createKimiCodeDeviceId();
  const response = await ctx.fetch(`${KIMI_CODE_OAUTH_HOST}/api/oauth/device_authorization`, {
    method: 'POST',
    headers: {
      ...kimiCodeRuntimeHeaders(deviceId),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: formBody({ client_id: KIMI_CODE_CLIENT_ID }),
  });
  const body = await readJson<{
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_url?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
  }>(response);
  if (!response.ok) throw new Error(body.error_description ?? body.error ?? `HTTP ${response.status}`);
  if (!body.device_code || !body.user_code || !(body.verification_uri ?? body.verification_url)) {
    throw new Error('Kimi Code device authorization response missing device_code/user_code');
  }

  const state = randomUUID();
  const verificationUrl = body.verification_uri ?? body.verification_url!;
  const flow: PendingFlow = {
    device_code: body.device_code,
    user_code: body.user_code,
    verification_url: verificationUrl,
    verification_uri_complete: body.verification_uri_complete,
    expires_at: Date.now() + (body.expires_in ?? 600) * 1000,
    interval: body.interval ?? 5,
    device_id: deviceId,
  };
  pendingFlows.set(state, flow);
  return {
    state,
    userCode: flow.user_code,
    verificationUri: flow.verification_url,
    verificationUriComplete: flow.verification_uri_complete,
    interval: flow.interval,
    user_code: flow.user_code,
    device_code: flow.device_code,
    verification_url: flow.verification_url,
    verification_uri: flow.verification_url,
    verification_uri_complete: flow.verification_uri_complete,
    expires_at: flow.expires_at,
  };
}

export async function pollKimiCodeAuth(
  ctx: ProviderAuthContext,
  state: unknown,
): Promise<
  AuthPollResult & {
    access_token?: string;
    refresh_token?: string | null;
    expires_at?: number;
    expires_in?: number;
    scope?: string | null;
    token_type?: string | null;
    device_id?: string;
    interval?: number;
  }
> {
  const key = typeof state === 'string' ? state : readObjectString(state, 'state');
  if (!key) return { status: 'error', message: 'state required' };
  const flow = pendingFlows.get(key);
  if (!flow) return { status: 'expired', message: 'unknown or expired flow' };
  if (Date.now() > flow.expires_at) {
    pendingFlows.delete(key);
    return { status: 'expired', message: 'device code expired' };
  }

  const response = await ctx.fetch(`${KIMI_CODE_OAUTH_HOST}/api/oauth/token`, {
    method: 'POST',
    headers: {
      ...kimiCodeRuntimeHeaders(flow.device_id),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: formBody({
      client_id: KIMI_CODE_CLIENT_ID,
      device_code: flow.device_code,
      grant_type: DEVICE_GRANT,
    }),
  });
  const body = await readJson<{
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  }>(response);

  if (!response.ok) {
    if (body.error === 'authorization_pending') return { status: 'pending', interval: flow.interval };
    if (body.error === 'slow_down') {
      flow.interval += 5;
      return { status: 'pending', interval: flow.interval };
    }
    if (body.error === 'expired_token') {
      pendingFlows.delete(key);
      return { status: 'expired', message: body.error_description ?? body.error };
    }
    return { status: 'error', message: body.error_description ?? body.error ?? `HTTP ${response.status}` };
  }
  if (!body.access_token) return { status: 'error', message: 'Kimi Code token response missing access_token' };

  pendingFlows.delete(key);
  const expiresIn = body.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS;
  return {
    status: 'authorized',
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? null,
    expires_at: Date.now() + expiresIn * 1000,
    expires_in: expiresIn,
    scope: body.scope ?? null,
    token_type: body.token_type ?? 'Bearer',
    device_id: flow.device_id,
  };
}

export async function resolveKimiCodeCredentials(
  ctx: ProviderResolveCredentialsContext,
): Promise<ResolvedCreds> {
  let token = ctx.config.api_key ?? (await ctx.credentials.get())?.access_token ?? '';
  try {
    const fresh = await refreshKimiCodeToken(ctx);
    if (fresh) {
      token = fresh;
      if (fresh !== ctx.config.api_key) await ctx.credentials.mirrorApiKey(fresh);
    }
  } catch (err) {
    ctx.log(`refresh failed: ${(err as Error).message}`);
  }

  if (!token) throw new Error('no Kimi Code access token stored - re-connect');
  const stored = await ctx.credentials.get();
  const deviceId = readString(stored?.extra?.device_id) ?? readString(ctx.config.extra?.device_id);
  const extraHeaders = kimiCodeRuntimeHeaders(deviceId ?? createKimiCodeDeviceId());
  return {
    apiKey: token,
    baseURL: (ctx.config.base_url ?? KIMI_CODE_BASE_URL).replace(/\/$/, ''),
    extraHeaders,
    extra: {
      refreshToken: stored?.refresh_token,
      deviceId: extraHeaders['X-Msh-Device-Id'],
      tokenType: stored?.extra?.token_type,
      thinkingMode: normalizeKimiCodeThinkingMode(ctx.config.extra?.kimi_code_thinking_mode),
    },
  };
}

export async function logoutKimiCodeAuth(ctx: ProviderAuthContext): Promise<void> {
  await ctx.credentials.clear();
}

export function kimiCodeProviderExtra(opts: {
  deviceId: string;
  tokenType?: string | null;
  expiresIn?: number | null;
  scope?: string | null;
}): Record<string, unknown> {
  return {
    client_id: KIMI_CODE_CLIENT_ID,
    oauth_host: KIMI_CODE_OAUTH_HOST,
    device_id: opts.deviceId,
    token_type: opts.tokenType ?? 'Bearer',
    expires_in: opts.expiresIn ?? null,
    scope: opts.scope ?? null,
    oauth_key: 'oauth/kimi-code',
  };
}

export function kimiCodeRuntimeHeaders(deviceId: string): Record<string, string> {
  return {
    'User-Agent': `KimiCLI/${KIMI_CODE_CLIENT_VERSION}`,
    'X-Msh-Platform': 'kimi_cli',
    'X-Msh-Version': KIMI_CODE_CLIENT_VERSION,
    'X-Msh-Device-Name': hostname() || 'localhost',
    'X-Msh-Device-Model': `${type()} ${platform()}`,
    'X-Msh-Os-Version': osVersion?.() || release(),
    'X-Msh-Device-Id': deviceId,
  };
}

export function createKimiCodeDeviceId(): string {
  return randomUUID().replace(/-/g, '');
}

async function refreshKimiCodeToken(ctx: ProviderResolveCredentialsContext): Promise<string | null> {
  const current = await ctx.credentials.get();
  if (!current) return null;
  const existingToken = current.access_token;
  const refreshToken = current.refresh_token;
  const threshold = refreshThresholdMs(current.extra);
  if (current.expires_at && current.expires_at - Date.now() > threshold) return existingToken;
  if (!refreshToken) return existingToken;

  const rejection = activeRejectionState(ctx.config.id, refreshToken);
  if (rejection) return existingToken;

  const deviceId =
    readString(current.extra?.device_id) ??
    readString(ctx.config.extra?.device_id) ??
    createKimiCodeDeviceId();

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await ctx.fetch(`${KIMI_CODE_OAUTH_HOST}/api/oauth/token`, {
      method: 'POST',
      headers: {
        ...kimiCodeRuntimeHeaders(deviceId),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: formBody({
        client_id: KIMI_CODE_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    const body = await readJson<{
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      token_type?: string;
      error?: string;
      error_description?: string;
    }>(response);

    if (response.ok && body.access_token) {
      const expiresIn = body.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS;
      const extra = {
        ...current.extra,
        ...kimiCodeProviderExtra({
          deviceId,
          tokenType: body.token_type ?? readString(current.extra?.token_type) ?? 'Bearer',
          expiresIn,
          scope: body.scope ?? current.scope,
        }),
      };
      await ctx.credentials.set({
        access_token: body.access_token,
        refresh_token: body.refresh_token ?? refreshToken,
        expires_at: Date.now() + expiresIn * 1000,
        scope: body.scope ?? current.scope,
        extra,
      });
      clearRejectedRefreshToken(ctx.config.id);
      return body.access_token;
    }

    if (response.status === 401 || response.status === 403) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const latest = await ctx.credentials.get();
      if (latest?.refresh_token && latest.refresh_token !== refreshToken) {
        clearRejectedRefreshToken(ctx.config.id);
        return latest.access_token;
      }
      markRefreshTokenRejected(ctx.config.id, refreshToken);
      throw new Error(body.error_description ?? body.error ?? `HTTP ${response.status}`);
    }

    lastError = new Error(body.error_description ?? body.error ?? `HTTP ${response.status}`);
    if (!RETRYABLE_REFRESH_STATUS.has(response.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw lastError ?? new Error('Kimi Code token refresh failed');
}

function refreshThresholdMs(extra: Record<string, unknown> | undefined): number {
  const raw = extra?.expires_in;
  const expiresInSeconds =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
  if (expiresInSeconds <= 0) return MIN_REFRESH_THRESHOLD_MS;
  return Math.max(MIN_REFRESH_THRESHOLD_MS, expiresInSeconds * 1000 * REFRESH_THRESHOLD_RATIO);
}

function activeRejectionState(providerId: string, refreshToken: string): RejectedRefreshState | null {
  const state = rejectedRefreshTokens.get(providerId);
  if (!state) return null;
  if (state.refresh_token !== refreshToken || Date.now() >= state.retry_after) {
    rejectedRefreshTokens.delete(providerId);
    return null;
  }
  return state;
}

function markRefreshTokenRejected(providerId: string, refreshToken: string): void {
  rejectedRefreshTokens.set(providerId, {
    refresh_token: refreshToken,
    retry_after: Date.now() + 5 * 60 * 1000,
  });
}

function clearRejectedRefreshToken(providerId: string): void {
  rejectedRefreshTokens.delete(providerId);
}

function formBody(data: Record<string, string>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) body.set(key, value);
  return body;
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return { error: text } as T;
  }
}

function readObjectString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return readString((value as Record<string, unknown>)[key]);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeKimiCodeThinkingMode(value: unknown): 'auto' | 'enabled' | 'disabled' {
  return value === 'enabled' || value === 'disabled' || value === 'auto' ? value : 'auto';
}
