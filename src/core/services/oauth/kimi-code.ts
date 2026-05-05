import { randomUUID } from 'node:crypto';
import { hostname, platform, release, type, version as osVersion } from 'node:os';
import type { ProviderStore, UpsertModelInput } from '../../../store/provider-store.js';
import { getRegistryContextWindow } from '../../coder/providers/capabilities.js';

export const KIMI_CODE_CLIENT_ID =
  process.env.KIMI_CODE_CLIENT_ID ?? '17e5f671-d194-4dfb-9706-5516cb48c098';
export const KIMI_CODE_OAUTH_HOST =
  process.env.KIMI_CODE_OAUTH_HOST ?? process.env.KIMI_OAUTH_HOST ?? 'https://auth.kimi.com';
export const KIMI_CODE_BASE_URL =
  process.env.KIMI_CODE_BASE_URL ?? 'https://api.kimi.com/coding/v1';
export const KIMI_CODE_OAUTH_KEY = 'oauth/kimi-code';
export const KIMI_CODE_CLIENT_VERSION = process.env.KIMI_CODE_CLIENT_VERSION ?? '1.36.0';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
const MIN_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;
const RETRYABLE_REFRESH_STATUS = new Set([429, 500, 502, 503, 504]);

export const KIMI_CODE_SEED_MODELS = [
  {
    model_id: 'kimi-k2.6',
    name: 'Kimi K2.6',
    display_name: 'Kimi K2.6',
    context_window: 262_144,
    default_max_tokens: 32_000,
    can_reason: true,
    supports_attachments: true,
    description: 'Kimi Code default model for coding/v1 with thinking, image input, and video input.',
  },
  {
    model_id: 'kimi-k2.5',
    name: 'Kimi K2.5',
    display_name: 'Kimi K2.5',
    context_window: 262_144,
    default_max_tokens: 32_000,
    can_reason: true,
    supports_attachments: true,
    description: 'Kimi Code K2.5 model with thinking, image input, and video input.',
  },
  {
    model_id: 'kimi-k2-thinking',
    name: 'Kimi K2 Thinking',
    display_name: 'Kimi K2 Thinking',
    context_window: 262_144,
    default_max_tokens: 32_000,
    can_reason: true,
    supports_attachments: true,
    description: 'Kimi Code thinking model. always_thinking.',
  },
  {
    model_id: 'kimi-k2-thinking-turbo',
    name: 'Kimi K2 Thinking Turbo',
    display_name: 'Kimi K2 Thinking Turbo',
    context_window: 262_144,
    default_max_tokens: 32_000,
    can_reason: true,
    supports_attachments: true,
    description: 'Kimi Code fast thinking model. always_thinking.',
  },
  {
    model_id: 'kimi-k2-turbo-preview',
    name: 'Kimi K2 Turbo Preview',
    display_name: 'Kimi K2 Turbo Preview',
    context_window: 262_144,
    default_max_tokens: 32_000,
    can_reason: true,
    supports_attachments: true,
    description: 'Kimi Code K2 turbo preview model with thinking, image input, and video input.',
  },
] as const;

export interface KimiCodeModelInfo {
  id: string;
  display_name?: string;
  context_length?: number;
  supports_reasoning?: boolean;
  supports_image_in?: boolean;
  supports_video_in?: boolean;
}

interface PendingFlow {
  device_code: string;
  user_code: string;
  verification_url: string;
  verification_uri_complete?: string;
  expires_at: number;
  interval: number;
  device_id: string;
}

export interface KimiCodeDeviceFlow {
  state: string;
  user_code: string;
  device_code: string;
  verification_url: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_at: number;
  interval: number;
}

export type KimiCodePollResult =
  | { status: 'pending'; interval?: number }
  | { status: 'expired'; error?: string }
  | { status: 'error'; error: string }
  | {
      status: 'authorized';
      access_token: string;
      refresh_token: string | null;
      expires_at: number;
      expires_in: number;
      scope: string | null;
      token_type: string | null;
      device_id: string;
    };

let fetchOverride: typeof fetch | null = null;
const pendingFlows = new Map<string, PendingFlow>();

export function __setKimiCodeFetchForTests(fn: typeof fetch | null): void {
  fetchOverride = fn;
}

function kimiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return (fetchOverride ?? fetch)(input, init);
}

export function createKimiCodeDeviceId(): string {
  return randomUUID().replace(/-/g, '');
}

export function kimiCodeOAuthHeaders(deviceId: string): Record<string, string> {
  return kimiCodeRuntimeHeaders(deviceId);
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

export function getKimiCodeRuntimeHeaders(
  store: ProviderStore,
  providerId: string,
): Record<string, string> {
  const maybeStore = store as Partial<ProviderStore>;
  const cfg = maybeStore.getProvider?.(providerId) ?? null;
  const tok = store.getOAuth(providerId);
  const existingDeviceId =
    typeof tok?.extra?.device_id === 'string'
      ? tok.extra.device_id
      : typeof cfg?.extra?.device_id === 'string'
        ? cfg.extra.device_id
        : null;
  const deviceId = existingDeviceId ?? createKimiCodeDeviceId();

  if (!existingDeviceId) {
    if (cfg) {
      store.upsertProvider({
        ...cfg,
        extra: { ...cfg.extra, device_id: deviceId },
      });
    }
    if (tok && maybeStore.setOAuth) {
      maybeStore.setOAuth({
        provider_id: providerId,
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        expires_at: tok.expires_at,
        scope: tok.scope,
        extra: { ...tok.extra, device_id: deviceId },
      });
    }
  }

  return kimiCodeRuntimeHeaders(deviceId);
}

function formBody(data: Record<string, string>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) body.set(k, v);
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

function tokenExpiresAt(expiresIn: number | undefined): number {
  return Date.now() + (expiresIn ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000;
}

export async function startDeviceFlow(): Promise<KimiCodeDeviceFlow> {
  const deviceId = createKimiCodeDeviceId();
  const response = await kimiFetch(`${KIMI_CODE_OAUTH_HOST}/api/oauth/device_authorization`, {
    method: 'POST',
    headers: {
      ...kimiCodeOAuthHeaders(deviceId),
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
  if (!response.ok) {
    throw new Error(body.error_description ?? body.error ?? `HTTP ${response.status}`);
  }
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
    user_code: flow.user_code,
    device_code: flow.device_code,
    verification_url: flow.verification_url,
    verification_uri: flow.verification_url,
    verification_uri_complete: flow.verification_uri_complete,
    expires_at: flow.expires_at,
    interval: flow.interval,
  };
}

export async function pollDeviceFlow(state: string): Promise<KimiCodePollResult> {
  const flow = pendingFlows.get(state);
  if (!flow) return { status: 'expired', error: 'unknown or expired flow' };
  if (Date.now() > flow.expires_at) {
    pendingFlows.delete(state);
    return { status: 'expired', error: 'device code expired' };
  }

  const response = await kimiFetch(`${KIMI_CODE_OAUTH_HOST}/api/oauth/token`, {
    method: 'POST',
    headers: {
      ...kimiCodeOAuthHeaders(flow.device_id),
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
      pendingFlows.delete(state);
      return { status: 'expired', error: body.error_description ?? body.error };
    }
    return { status: 'error', error: body.error_description ?? body.error ?? `HTTP ${response.status}` };
  }
  if (!body.access_token) return { status: 'error', error: 'Kimi Code token response missing access_token' };

  pendingFlows.delete(state);
  const expiresIn = body.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS;
  return {
    status: 'authorized',
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? null,
    expires_at: tokenExpiresAt(expiresIn),
    expires_in: expiresIn,
    scope: body.scope ?? null,
    token_type: body.token_type ?? 'Bearer',
    device_id: flow.device_id,
  };
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
    oauth_key: KIMI_CODE_OAUTH_KEY,
  };
}

export async function refreshIfExpired(
  store: ProviderStore,
  providerId: string,
  opts?: { force?: boolean },
): Promise<string | null> {
  const tok = store.getOAuth(providerId);
  if (!tok) return null;
  const existingToken = tok.access_token;
  const now = Date.now();
  if (!opts?.force && tok.expires_at && tok.expires_at - now > MIN_REFRESH_THRESHOLD_MS) {
    return existingToken;
  }
  if (!tok.refresh_token) return existingToken;

  const cfg = store.getProvider(providerId);
  const deviceId =
    typeof tok.extra?.device_id === 'string'
      ? tok.extra.device_id
      : typeof cfg?.extra?.device_id === 'string'
        ? cfg.extra.device_id
        : createKimiCodeDeviceId();

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await kimiFetch(`${KIMI_CODE_OAUTH_HOST}/api/oauth/token`, {
      method: 'POST',
      headers: {
        ...kimiCodeOAuthHeaders(deviceId),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: formBody({
        client_id: KIMI_CODE_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: tok.refresh_token,
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
        ...tok.extra,
        ...kimiCodeProviderExtra({
          deviceId,
          tokenType: body.token_type ?? (tok.extra?.token_type as string | undefined) ?? 'Bearer',
          expiresIn,
          scope: body.scope ?? tok.scope,
        }),
      };
      store.setOAuth({
        provider_id: providerId,
        access_token: body.access_token,
        refresh_token: body.refresh_token ?? tok.refresh_token,
        expires_at: tokenExpiresAt(expiresIn),
        scope: body.scope ?? tok.scope,
        extra,
      });
      if (cfg) {
        store.upsertProvider({
          ...cfg,
          api_key: body.access_token,
          extra: {
            ...cfg.extra,
            ...extra,
          },
        });
      }
      return body.access_token;
    }

    lastError = new Error(body.error_description ?? body.error ?? `HTTP ${response.status}`);
    if (!RETRYABLE_REFRESH_STATUS.has(response.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw lastError ?? new Error('Kimi Code token refresh failed');
}

export async function fetchKimiCodeModels(opts: {
  baseURL?: string | null;
  apiKey?: string | null;
  headers?: Record<string, string>;
}): Promise<KimiCodeModelInfo[]> {
  const base = (opts.baseURL ?? KIMI_CODE_BASE_URL).replace(/\/$/, '');
  const response = await kimiFetch(`${base}/models`, {
    headers: {
      ...opts.headers,
      Authorization: `Bearer ${opts.apiKey ?? ''}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await readJson<{ data?: KimiCodeModelInfo[]; models?: KimiCodeModelInfo[] }>(response);
  return Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
}

function isKimiK2(id: string): boolean {
  return /^kimi-k2/i.test(id);
}

function isAlwaysThinking(id: string): boolean {
  return /thinking/i.test(id);
}

export function mapKimiCodeModels(models: KimiCodeModelInfo[]): UpsertModelInput[] {
  return models.map((model) => {
    const id = model.id;
    const hasK2Defaults = isKimiK2(id);
    const canReason = Boolean(model.supports_reasoning) || hasK2Defaults || isAlwaysThinking(id);
    const supportsImage = Boolean(model.supports_image_in) || hasK2Defaults;
    const supportsVideo = Boolean(model.supports_video_in) || hasK2Defaults;
    const modalities = ['text'];
    if (supportsImage) modalities.push('image');
    if (supportsVideo) modalities.push('video');
    const descriptionParts = [
      'Kimi Code coding/v1 model',
      canReason ? 'thinking' : null,
      supportsImage ? 'image input' : null,
      supportsVideo ? 'video input' : null,
      isAlwaysThinking(id) ? 'always_thinking' : null,
    ].filter(Boolean);
    return {
      model_id: id,
      name: model.display_name ?? id,
      display_name: model.display_name ?? id,
      description: descriptionParts.join('; '),
      context_window: model.context_length ?? getRegistryContextWindow(id),
      default_max_tokens: hasK2Defaults ? 32_000 : null,
      can_reason: canReason,
      supports_attachments: supportsImage || supportsVideo,
      default_reasoning_level: canReason ? 'high' : null,
      supported_reasoning_levels: canReason ? ['low', 'medium', 'high'] : null,
      visibility: 'list',
      supported_in_api: true,
      input_modalities: modalities,
      source: 'live',
    };
  });
}

export function kimiCodeSeedUpsertModels(): UpsertModelInput[] {
  return KIMI_CODE_SEED_MODELS.map((model) => ({
    ...model,
    supported_reasoning_levels: model.can_reason ? ['low', 'medium', 'high'] : null,
    default_reasoning_level: model.can_reason ? 'high' : null,
    input_modalities: model.supports_attachments ? ['text', 'image', 'video'] : ['text'],
    visibility: 'list',
    supported_in_api: true,
    source: 'live',
  }));
}
