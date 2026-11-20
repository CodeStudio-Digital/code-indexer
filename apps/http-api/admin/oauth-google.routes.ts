/**
 * Google OAuth (PKCE loopback flow) — /oauth/google/start + /poll.
 *
 * Start boots the loopback server on :1456 and returns the authorize URL.
 * Poll waits for the loopback callback and, on success, persists tokens,
 * upserts the provider row, and seeds a model list (live first, falling
 * back to GOOGLE_SEED_MODELS).
 */
import { HttpRouter } from '@mcp/shared/http/router.js';
import type { ProviderStore, UpsertModelInput } from '@mcp/store/provider-store.js';
import { createAuthClient, setupCloudCode, retrieveUserQuota } from '@mcp/services/services/cloudcode.js';
import { refreshIfExpired } from '@mcp/services/services/oauth/google.js';
import { discoverModels } from './model-discovery/index.js';
import {
  providerAuthContext,
  providerAuthHandlers,
  syntheticProviderConfig,
} from './provider-auth-runtime.js';

const GOOGLE_SEED_MODEL_IDS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-3-pro-preview',
  'gemini-3.1-pro-preview',
  'gemini-3.1-pro-preview-customtools',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
];

export function googleOAuthRouter(store: ProviderStore): HttpRouter {
  const app = new HttpRouter();

  /**
   * Start the Google PKCE flow. Boots the loopback server on :1456 and
   * returns the authorize URL the UI should open in a new tab.
   */
  app.post('/oauth/google/start', async (c) => {
    try {
      const handlers = providerAuthHandlers('google-oauth');
      const cfg = syntheticProviderConfig({ id: 'google-oauth', kind: 'google-oauth' });
      const flow = handlers?.start
        ? await handlers.start(providerAuthContext(store, cfg))
        : await legacyGoogle().then((m) => m.startOAuthFlow());
      return c.json(flow);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('EADDRINUSE')) {
        return c.json(
          { error: 'Port 1456 already in use. Close any other Google auth flow and retry.' },
          409,
        );
      }
      return c.json({ error: msg }, 502);
    }
  });

  /**
   * Poll the Google PKCE flow by state. Returns 'pending' until the
   * loopback server captures the code, then exchanges it for tokens,
   * persists them, upserts the provider row, and discovers models.
   */
  app.post('/oauth/google/poll', async (c) => {
    const body = await c.req.json<{ state: string; provider_id?: string }>();
    if (!body.state) return c.json({ error: 'state required' }, 400);
    const providerId = body.provider_id ?? 'google-oauth';

    try {
      const handlers = providerAuthHandlers('google-oauth');
      const cfg = store.getProvider(providerId) ?? syntheticProviderConfig({
        id: providerId,
        kind: 'google-oauth',
      });
      const result = handlers?.poll
        ? await handlers.poll(providerAuthContext(store, cfg), { state: body.state })
        : await legacyGoogle().then((m) => m.pollFlow(body.state));
      if (result.status !== 'authorized') {
        return c.json(normalizePollResult(result));
      }
      const accessToken = readString(result, 'access_token');
      const expiresAt = readNumber(result, 'expires_at');
      if (!accessToken || !expiresAt) {
        return c.json({ status: 'error', error: 'Google auth did not return usable credentials' }, 502);
      }

      // Upsert the provider row: api_key mirrors the access token so existing
      // credential resolution (resolveCreds → api-key path) works as a fallback.
      if (!store.getProvider(providerId)) {
        store.upsertProvider({
          id: providerId,
          name: 'Google (OAuth)',
          kind: 'google-oauth',
          base_url: '',
          api_key: accessToken,
          auth_mode: 'oauth',
          enabled: true,
          use_for_coder: true,
          use_for_agent: true,
          extra: {},
        });
      } else {
        const existing = store.getProvider(providerId)!;
        store.upsertProvider({
          ...existing,
          api_key: accessToken,
        });
      }

      // Call CloudCode to discover the user's project ID (same as gemini-cli).
      let projectId = readString(result, 'project_id') ?? '';
      if (!projectId) {
        try {
          const authClient = createAuthClient(accessToken, readNullableString(result, 'refresh_token'));
          const setup = await setupCloudCode(authClient);
          projectId = setup.projectId;
        } catch (e) {
          console.warn(`[google-oauth] CloudCode setup failed: ${(e as Error).message}`);
        }
      }

      store.setOAuth({
        provider_id: providerId,
        access_token: accessToken,
        refresh_token: readNullableString(result, 'refresh_token'),
        expires_at: expiresAt,
        scope: readString(result, 'scope') ?? null,
        extra: { projectId },
      });

      // Discover models live. Fall back to seed list on error.
      let models: UpsertModelInput[] = [];
      try {
        models = (await discoverModels(store, store.getProvider(providerId)!)).models;
      } catch { /* ignore */ }
      if (models.length === 0) {
        models = GOOGLE_SEED_MODEL_IDS.map((model) => ({
          model_id: model,
          name: model,
          source: 'live' as const,
        }));
      }
      store.replaceModelsFromSource(providerId, 'live', models);

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

  /**
   * GET /oauth/google/quota?provider_id=google-oauth
   * Returns per-model quota buckets, tier info, and credits.
   */
  app.get('/oauth/google/quota', async (c) => {
    const providerId = c.req.query('provider_id') ?? 'google-oauth';
    const cfg = store.getProvider(providerId);
    if (!cfg) return c.json({ error: 'provider not found' }, 404);

    const tok = store.getOAuth(providerId);
    if (!tok) return c.json({ error: 'not connected' }, 404);

    const extra = (tok.extra ?? {}) as { projectId?: string };
    if (!extra.projectId) return c.json({ error: 'no projectId — reconnect the provider' }, 400);

    try {
      // Refresh token if needed
      let accessToken = tok.access_token;
      try {
        const fresh = await refreshIfExpired(store, providerId);
        if (fresh) accessToken = fresh;
      } catch { /* use existing */ }

      const authClient = createAuthClient(accessToken, tok.refresh_token);
      const quota = await retrieveUserQuota(authClient, extra.projectId);
      return c.json(quota);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  return app;
}

async function legacyGoogle() {
  return import('@mcp/services/services/oauth/google.js');
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
