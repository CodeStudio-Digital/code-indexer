import { Hono } from 'hono';
import type { ProviderStore, UpsertModelInput } from '@mcp/store/provider-store.js';
import { discoverModels } from './model-discovery/index.js';
import {
  providerAuthContext,
  providerAuthHandlers,
  syntheticProviderConfig,
} from './provider-auth-runtime.js';

const KIMI_CODE_BASE_URL = process.env.KIMI_CODE_BASE_URL ?? 'https://api.kimi.com/coding/v1';
const KIMI_CODE_CLIENT_ID =
  process.env.KIMI_CODE_CLIENT_ID ?? '17e5f671-d194-4dfb-9706-5516cb48c098';
const KIMI_CODE_SEED_MODEL_IDS = [
  'kimi-k2.6',
  'kimi-k2.5',
  'kimi-k2-thinking',
  'kimi-k2-thinking-turbo',
  'kimi-k2-turbo-preview',
];

export function kimiCodeOAuthRouter(store: ProviderStore): Hono {
  const app = new Hono();

  app.post('/oauth/kimi-code/start', async (c) => {
    try {
      const handlers = providerAuthHandlers('kimi-code');
      const cfg = syntheticProviderConfig({ id: 'kimi-code', kind: 'kimi-code', base_url: KIMI_CODE_BASE_URL });
      const flow = handlers?.start
        ? await handlers.start(providerAuthContext(store, cfg))
        : await legacyKimiCode().then((m) => m.startDeviceFlow());
      return c.json(flow);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  app.post('/oauth/kimi-code/poll', async (c) => {
    const body: { state: string; provider_id?: string } = await c.req.json<{ state: string; provider_id?: string }>().catch(() => ({
      state: '',
    }));
    if (!body.state) return c.json({ error: 'state required' }, 400);
    const providerId = body.provider_id ?? 'kimi-code';

    try {
      const handlers = providerAuthHandlers('kimi-code');
      const cfg = store.getProvider(providerId) ?? syntheticProviderConfig({
        id: providerId,
        kind: 'kimi-code',
        base_url: KIMI_CODE_BASE_URL,
      });
      const result = handlers?.poll
        ? await handlers.poll(providerAuthContext(store, cfg), { state: body.state })
        : await legacyKimiCode().then((m) => m.pollDeviceFlow(body.state));
      if (result.status !== 'authorized') return c.json(normalizePollResult(result));

      const accessToken = readString(result, 'access_token');
      const expiresAt = readNumber(result, 'expires_at');
      const deviceId = readString(result, 'device_id');
      if (!accessToken || !expiresAt || !deviceId) {
        return c.json({ status: 'error', error: 'Kimi Code auth did not return usable credentials' }, 502);
      }

      const extra = kimiCodeProviderExtra({
        deviceId,
        tokenType: readNullableString(result, 'token_type'),
        expiresIn: readNumber(result, 'expires_in') ?? null,
        scope: readNullableString(result, 'scope'),
      });
      const existing = store.getProvider(providerId);
      if (!existing) {
        store.upsertProvider({
          id: providerId,
          name: 'Kimi Code (OAuth)',
          kind: 'kimi-code',
          base_url: KIMI_CODE_BASE_URL,
          api_key: accessToken,
          auth_mode: 'oauth',
          enabled: true,
          use_for_agent: true,
          use_for_coder: true,
          use_for_general: false,
          extra,
        });
      } else {
        store.upsertProvider({
          ...existing,
          kind: 'kimi-code',
          base_url: KIMI_CODE_BASE_URL,
          api_key: accessToken,
          auth_mode: 'oauth',
          enabled: true,
          use_for_agent: true,
          use_for_coder: true,
          extra: { ...existing.extra, ...extra },
        });
      }

      store.setOAuth({
        provider_id: providerId,
        access_token: accessToken,
        refresh_token: readNullableString(result, 'refresh_token'),
        expires_at: expiresAt,
        scope: readNullableString(result, 'scope'),
        extra,
      });

      let models: UpsertModelInput[] = [];
      try {
        const discovered = await discoverModels(store, store.getProvider(providerId)!);
        if (!discovered.notModified) models = discovered.models;
      } catch {
        models = [];
      }
      if (models.length === 0) models = kimiCodeSeedUpsertModels();
      store.replaceModelsFromSource(providerId, 'live', models);
      store.setProviderCatalogEtag(providerId, null);

      return c.json({
        status: 'authorized',
        provider_id: providerId,
        expires_at: expiresAt,
        model_count: models.length,
      });
    } catch (e) {
      return c.json({ status: 'error', error: (e as Error).message }, 502);
    }
  });

  app.post('/oauth/kimi-code/logout', async (c) => {
    const body: { provider_id?: string } = await c.req.json<{ provider_id?: string }>().catch(() => ({}));
    const providerId = body.provider_id ?? 'kimi-code';
    const handlers = providerAuthHandlers('kimi-code');
    const cfg = store.getProvider(providerId) ?? syntheticProviderConfig({
      id: providerId,
      kind: 'kimi-code',
      base_url: KIMI_CODE_BASE_URL,
    });
    if (handlers?.logout) {
      await handlers.logout(providerAuthContext(store, cfg));
    } else {
      store.deleteOAuth(providerId);
    }
    const existing = store.getProvider(providerId);
    if (existing) {
      store.upsertProvider({
        ...existing,
        api_key: null,
        enabled: false,
      });
    }
    return c.json({ ok: true, provider_id: providerId });
  });

  return app;
}

async function legacyKimiCode() {
  return import('@mcp/services/services/oauth/kimi-code.js');
}

function kimiCodeProviderExtra(opts: {
  deviceId: string;
  tokenType?: string | null;
  expiresIn?: number | null;
  scope?: string | null;
}): Record<string, unknown> {
  return {
    client_id: KIMI_CODE_CLIENT_ID,
    oauth_host: process.env.KIMI_CODE_OAUTH_HOST ?? process.env.KIMI_OAUTH_HOST ?? 'https://auth.kimi.com',
    device_id: opts.deviceId,
    token_type: opts.tokenType ?? 'Bearer',
    expires_in: opts.expiresIn ?? null,
    scope: opts.scope ?? null,
    oauth_key: 'oauth/kimi-code',
  };
}

function kimiCodeSeedUpsertModels(): UpsertModelInput[] {
  return KIMI_CODE_SEED_MODEL_IDS.map((model) => ({
    model_id: model,
    name: model,
    context_window: 262_144,
    default_max_tokens: 32_000,
    can_reason: true,
    supports_attachments: true,
    supported_reasoning_levels: ['low', 'medium', 'high'],
    default_reasoning_level: 'high',
    input_modalities: ['text', 'image', 'video'],
    visibility: 'list',
    supported_in_api: true,
    source: 'live' as const,
  }));
}

function normalizePollResult(result: { status: string; message?: string; error?: string }) {
  return result.message && !result.error ? { ...result, error: result.message } : result;
}

function readString(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNullableString(source: unknown, key: string): string | null {
  if (!source || typeof source !== 'object') return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(source: unknown, key: string): number | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
