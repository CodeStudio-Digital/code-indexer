/**
 * OpenAI ChatGPT (Codex PKCE flow) — /oauth/openai/start + /poll.
 *
 * Start boots the loopback server on :1455 and returns the authorize URL.
 * Poll waits for the loopback callback and, on success, persists tokens,
 * upserts the provider row, and seeds a model list (live first, falling
 * back to CHATGPT_SEED_MODELS).
 */
import { HttpRouter } from '@mcp/shared/http/router.js';
import type { ProviderStore, UpsertModelInput } from '@mcp/store/provider-store.js';
import { discoverModels } from './model-discovery/index.js';
import {
  providerAuthContext,
  providerAuthHandlers,
  syntheticProviderConfig,
} from './provider-auth-runtime.js';

const CHATGPT_CODEX_BASE_URL =
  process.env.CHATGPT_CODEX_BASE_URL ?? 'https://chatgpt.com/backend-api/codex';
const CHATGPT_SEED_MODEL_IDS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.3-codex',
  'gpt-5-codex',
  'gpt-4o',
];

export function openaiOAuthRouter(store: ProviderStore): HttpRouter {
  const app = new HttpRouter();

  /**
   * Start the OpenAI PKCE flow. Boots the loopback server on :1455 and
   * returns the authorize URL the UI should open in a new tab.
   */
  app.post('/oauth/openai/start', async (c) => {
    try {
      const handlers = providerAuthHandlers('chatgpt');
      const cfg = syntheticProviderConfig({
        id: 'openai-chatgpt',
        kind: 'chatgpt',
        base_url: CHATGPT_CODEX_BASE_URL,
      });
      const flow = handlers?.start
        ? await handlers.start(providerAuthContext(store, cfg))
        : await legacyOpenAI().then((m) => m.startOAuthFlow());
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
      const handlers = providerAuthHandlers('chatgpt');
      const cfg = store.getProvider(providerId) ?? syntheticProviderConfig({
        id: providerId,
        kind: 'chatgpt',
        base_url: CHATGPT_CODEX_BASE_URL,
      });
      const result = handlers?.poll
        ? await handlers.poll(providerAuthContext(store, cfg), { state: body.state })
        : await legacyOpenAI().then((m) => m.pollFlow(body.state));
      if (result.status !== 'authorized') {
        return c.json(normalizePollResult(result));
      }

      const baseURL = CHATGPT_CODEX_BASE_URL;
      const accessToken = readString(result, 'access_token');
      const expiresAt = readNumber(result, 'expires_at');
      if (!accessToken || !expiresAt) {
        return c.json({ status: 'error', error: 'ChatGPT auth did not return usable credentials' }, 502);
      }

      if (!store.getProvider(providerId)) {
        store.upsertProvider({
          id: providerId,
          name: 'ChatGPT (Codex)',
          kind: 'chatgpt',
          base_url: baseURL,
          api_key: accessToken,
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
          api_key: accessToken,
          base_url: baseURL,
        });
      }

      store.setOAuth({
        provider_id: providerId,
        access_token: accessToken,
        refresh_token: readNullableString(result, 'refresh_token'),
        expires_at: expiresAt,
        scope: 'openid profile email offline_access',
        extra: { id_token: readNullableString(result, 'id_token') },
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
        models = CHATGPT_SEED_MODEL_IDS.map((model) => ({
          model_id: model,
          name: model,
          source: 'live' as const,
        }));
      }
      store.replaceModelsFromSource(providerId, 'live', models);
      store.setProviderCatalogEtag(providerId, etag);

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

  return app;
}

async function legacyOpenAI() {
  return import('@mcp/services/services/oauth/openai.js');
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
