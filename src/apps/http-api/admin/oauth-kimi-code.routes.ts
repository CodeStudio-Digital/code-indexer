import { Hono } from 'hono';
import type { ProviderStore, UpsertModelInput } from '../../../store/provider-store.js';
import {
  KIMI_CODE_BASE_URL,
  kimiCodeProviderExtra,
  kimiCodeSeedUpsertModels,
  pollDeviceFlow,
  startDeviceFlow,
} from '../../../core/services/oauth/kimi-code.js';
import { discoverModels } from './model-discovery/index.js';

export function kimiCodeOAuthRouter(store: ProviderStore): Hono {
  const app = new Hono();

  app.post('/oauth/kimi-code/start', async (c) => {
    try {
      const flow = await startDeviceFlow();
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
      const result = await pollDeviceFlow(body.state);
      if (result.status !== 'authorized') return c.json(result);

      const extra = kimiCodeProviderExtra({
        deviceId: result.device_id,
        tokenType: result.token_type,
        expiresIn: result.expires_in,
        scope: result.scope,
      });
      const existing = store.getProvider(providerId);
      if (!existing) {
        store.upsertProvider({
          id: providerId,
          name: 'Kimi Code (OAuth)',
          kind: 'kimi-code',
          base_url: KIMI_CODE_BASE_URL,
          api_key: result.access_token,
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
          api_key: result.access_token,
          auth_mode: 'oauth',
          enabled: true,
          use_for_agent: true,
          use_for_coder: true,
          extra: { ...existing.extra, ...extra },
        });
      }

      store.setOAuth({
        provider_id: providerId,
        access_token: result.access_token,
        refresh_token: result.refresh_token,
        expires_at: result.expires_at,
        scope: result.scope,
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
        expires_at: result.expires_at,
        model_count: models.length,
      });
    } catch (e) {
      return c.json({ status: 'error', error: (e as Error).message }, 502);
    }
  });

  app.post('/oauth/kimi-code/logout', async (c) => {
    const body: { provider_id?: string } = await c.req.json<{ provider_id?: string }>().catch(() => ({}));
    const providerId = body.provider_id ?? 'kimi-code';
    store.deleteOAuth(providerId);
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
