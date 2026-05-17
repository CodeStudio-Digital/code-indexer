/**
 * Google OAuth (PKCE loopback flow) — /oauth/google/start + /poll.
 *
 * Start boots the loopback server on :1456 and returns the authorize URL.
 * Poll waits for the loopback callback and, on success, persists tokens,
 * upserts the provider row, and seeds a model list (live first, falling
 * back to GOOGLE_SEED_MODELS).
 */
import { Hono } from 'hono';
import type { ProviderStore, UpsertModelInput } from '@mcp/store/provider-store.js';
import {
  startOAuthFlow as startGoogleFlow,
  pollFlow as pollGoogleFlow,
  GOOGLE_SEED_MODELS,
} from '@mcp/services/services/oauth/google.js';
import { createAuthClient, setupCloudCode, retrieveUserQuota } from '@mcp/services/services/cloudcode.js';
import { refreshIfExpired } from '@mcp/services/services/oauth/google.js';
import { discoverGoogleOAuth } from './model-discovery/google-oauth.js';

export function googleOAuthRouter(store: ProviderStore): Hono {
  const app = new Hono();

  /**
   * Start the Google PKCE flow. Boots the loopback server on :1456 and
   * returns the authorize URL the UI should open in a new tab.
   */
  app.post('/oauth/google/start', async (c) => {
    try {
      const flow = await startGoogleFlow();
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
      const result = await pollGoogleFlow(body.state);
      if (result.status !== 'authorized') {
        return c.json(result);
      }

      // Upsert the provider row: api_key mirrors the access token so existing
      // credential resolution (resolveCreds → api-key path) works as a fallback.
      if (!store.getProvider(providerId)) {
        store.upsertProvider({
          id: providerId,
          name: 'Google (OAuth)',
          kind: 'google-oauth',
          base_url: '',
          api_key: result.access_token,
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
          api_key: result.access_token,
        });
      }

      // Call CloudCode to discover the user's project ID (same as gemini-cli).
      let projectId = '';
      try {
        const authClient = createAuthClient(result.access_token, result.refresh_token);
        const setup = await setupCloudCode(authClient);
        projectId = setup.projectId;
      } catch (e) {
        console.warn(`[google-oauth] CloudCode setup failed: ${(e as Error).message}`);
      }

      store.setOAuth({
        provider_id: providerId,
        access_token: result.access_token,
        refresh_token: result.refresh_token,
        expires_at: result.expires_at,
        scope: result.scope,
        extra: { projectId },
      });

      // Discover models live. Fall back to seed list on error.
      let models: UpsertModelInput[] = [];
      try {
        models = await discoverGoogleOAuth(store, store.getProvider(providerId)!);
      } catch { /* ignore */ }
      if (models.length === 0) {
        models = GOOGLE_SEED_MODELS.map((m) => ({
          model_id: m.model_id,
          name: m.name,
          source: 'live' as const,
        }));
      }
      store.replaceModelsFromSource(providerId, 'live', models);

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
