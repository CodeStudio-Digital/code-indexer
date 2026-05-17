/**
 * OpenAI ChatGPT (Codex PKCE flow) — /oauth/openai/start + /poll.
 *
 * Start boots the loopback server on :1455 and returns the authorize URL.
 * Poll waits for the loopback callback and, on success, persists tokens,
 * upserts the provider row, and seeds a model list (live first, falling
 * back to CHATGPT_SEED_MODELS).
 */
import { Hono } from 'hono';
import type { ProviderStore, UpsertModelInput } from '@mcp/store/provider-store.js';
import {
  startOAuthFlow as startOpenAIFlow,
  pollFlow as pollOpenAIFlow,
  CHATGPT_CODEX_BASE_URL,
  CHATGPT_SEED_MODELS,
} from '@mcp/services/services/oauth/openai.js';
import { discoverModels } from './model-discovery/index.js';

export function openaiOAuthRouter(store: ProviderStore): Hono {
  const app = new Hono();

  /**
   * Start the OpenAI PKCE flow. Boots the loopback server on :1455 and
   * returns the authorize URL the UI should open in a new tab.
   */
  app.post('/oauth/openai/start', async (c) => {
    try {
      const flow = await startOpenAIFlow();
      return c.json(flow);
    } catch (e) {
      const msg = (e as Error).message;
      // Surface EADDRINUSE clearly — it's the most common failure mode.
      if (msg.includes('EADDRINUSE')) {
        return c.json(
          { error: 'Port 1455 already in use. Close any other Codex/ChatGPT auth flow and retry.' },
          409
        );
      }
      return c.json({ error: msg }, 502);
    }
  });

  /**
   * Poll the OpenAI PKCE flow by state. Returns 'pending' until the
   * loopback server captures the code, then exchanges it for tokens,
   * persists them, upserts the provider row, and seeds a model list.
   */
  app.post('/oauth/openai/poll', async (c) => {
    const body = await c.req.json<{ state: string; provider_id?: string }>();
    if (!body.state) return c.json({ error: 'state required' }, 400);
    const providerId = body.provider_id ?? 'openai-chatgpt';

    try {
      const result = await pollOpenAIFlow(body.state);
      if (result.status !== 'authorized') {
        return c.json(result);
      }

      const baseURL = CHATGPT_CODEX_BASE_URL;

      if (!store.getProvider(providerId)) {
        store.upsertProvider({
          id: providerId,
          name: 'ChatGPT (Codex)',
          kind: 'chatgpt',
          base_url: baseURL,
          api_key: result.access_token,
          auth_mode: 'oauth',
          enabled: true,
          use_for_coder: true,
          use_for_agent: false,
          extra: {},
        });
      } else {
        // Refresh the api_key mirror. use_for_agent is preserved so admin
        // can enable indexing via ChatGPT/Codex.
        const existing = store.getProvider(providerId)!;
        store.upsertProvider({
          ...existing,
          api_key: result.access_token,
          base_url: baseURL,
        });
      }

      store.setOAuth({
        provider_id: providerId,
        access_token: result.access_token,
        refresh_token: result.refresh_token,
        expires_at: result.expires_at,
        scope: 'openid profile email offline_access',
        extra: { id_token: result.id_token },
      });

      // Try live discovery first. discoverChatgpt already falls back to
      // CHATGPT_SEED_MODELS internally on network/HTTP failures, so a
      // returned empty list here means the upstream said "no models".
      let models: UpsertModelInput[] = [];
      let etag: string | null = null;
      try {
        const result = await discoverModels(store, store.getProvider(providerId)!);
        if (!result.notModified) {
          models = result.models;
          etag = result.etag;
        }
      } catch {
        models = [];
      }
      if (models.length === 0) {
        models = CHATGPT_SEED_MODELS.map((m) => ({
          model_id: m.model_id,
          name: m.name,
          source: 'live' as const,
        }));
      }
      store.replaceModelsFromSource(providerId, 'live', models);
      store.setProviderCatalogEtag(providerId, etag);

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

  return app;
}
