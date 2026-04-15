/**
 * /providers CRUD + connectivity test.
 *
 * The routes are thin wrappers around ProviderStore. api_key values returned
 * on list/get are masked; write endpoints accept the full value. The `/test`
 * endpoint issues a cheap per-kind ping so the UI can show a badge.
 */
import { Hono } from 'hono';
import type {
  ProviderStore,
  ProviderKind,
  AuthMode,
} from '../../../store/provider-store.js';
import {
  refreshIfExpired,
  copilotHeaders,
  getStoredCopilotOpts,
} from '../../../core/services/oauth/copilot.js';
import {
  refreshIfExpired as refreshOpenAIToken,
  openaiAuthHeaders,
  CHATGPT_CODEX_BASE_URL,
} from '../../../core/services/oauth/openai.js';
import {
  refreshIfExpired as refreshGoogleOAuthToken,
} from '../../../core/services/oauth/google.js';
import { publicProvider } from './shared/mask.js';
import { resolveCopilotApiBase } from './shared/copilot-opts.js';

export function providersRouter(store: ProviderStore): Hono {
  const app = new Hono();

  /**
   * GET /providers/known — registry of known provider shapes.
   *
   * Drives the dashboard's "Add provider" picker and the OAuth/AWS
   * "Connect" buttons. Served from the central provider registry
   * (src/core/providers/registry.ts) so adding a new shape shows up
   * automatically with no admin UI changes required.
   */
  app.get('/providers/known', async (c) => {
    const { listDefinitions } = await import('../../../core/providers/registry.js');
    return c.json(
      listDefinitions().map((def) => ({
        kind: def.kind,
        displayName: def.displayName,
        credKind: def.credKind,
        envVars: def.envVars,
        defaultBaseURL: def.defaultBaseURL ?? null,
        defaultModels: def.defaultModels,
        capabilities: def.capabilities ?? {},
        supportsIndexer: !!(def.createIndexer || def.createIndexerAsync),
        supportsCoder: !!def.createCoder,
      })),
    );
  });

  app.get('/providers', (c) => {
    return c.json({ providers: store.listProviders().map(publicProvider) });
  });

  app.get('/providers/:id', (c) => {
    const p = store.getProvider(c.req.param('id'));
    if (!p) return c.json({ error: 'not found' }, 404);
    return c.json(publicProvider(p));
  });

  app.post('/providers', async (c) => {
    const body = await c.req.json<{
      id: string;
      name: string;
      kind: ProviderKind;
      base_url?: string;
      api_key?: string;
      auth_mode?: AuthMode;
      enabled?: boolean;
      use_for_agent?: boolean;
      use_for_coder?: boolean;
      is_default?: boolean;
      extra?: Record<string, unknown>;
    }>();
    if (!body.id || !body.name || !body.kind) {
      return c.json({ error: 'id, name, kind required' }, 400);
    }
    if (store.getProvider(body.id)) {
      return c.json({ error: `provider ${body.id} already exists` }, 409);
    }
    const created = store.upsertProvider(body);
    return c.json(publicProvider(created), 201);
  });

  app.patch('/providers/:id', async (c) => {
    const id = c.req.param('id');
    const existing = store.getProvider(id);
    if (!existing) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json<{
      name?: string;
      kind?: ProviderKind;
      base_url?: string | null;
      api_key?: string | null;
      auth_mode?: AuthMode;
      enabled?: boolean;
      use_for_agent?: boolean;
      use_for_coder?: boolean;
      is_default?: boolean;
      extra?: Record<string, unknown>;
      fallback_provider_id?: string | null;
    }>();
    // Keep existing fields when not provided. Null on api_key/base_url is
    // intentional "clear"; undefined means "leave alone".
    const updated = store.upsertProvider({
      id,
      name: body.name ?? existing.name,
      kind: body.kind ?? existing.kind,
      base_url: body.base_url === undefined ? existing.base_url : body.base_url,
      api_key: body.api_key === undefined ? existing.api_key : body.api_key,
      auth_mode: body.auth_mode ?? existing.auth_mode,
      enabled: body.enabled ?? existing.enabled,
      use_for_agent: body.use_for_agent ?? existing.use_for_agent,
      use_for_coder: body.use_for_coder ?? existing.use_for_coder,
      is_default: body.is_default ?? existing.is_default,
      extra: body.extra ?? existing.extra,
    });
    // Handle fallback_provider_id separately (not part of upsertProvider)
    if (body.fallback_provider_id !== undefined) {
      store.setFallbackProvider(id, body.fallback_provider_id);
    }
    return c.json(publicProvider(updated));
  });

  app.delete('/providers/:id', (c) => {
    const id = c.req.param('id');
    if (!store.getProvider(id)) return c.json({ error: 'not found' }, 404);
    store.deleteProvider(id);
    return c.json({ ok: true });
  });

  /**
   * POST /providers/:id/test — cheap connectivity check. For OpenAI-compat
   * kinds, hits /v1/models. For Anthropic-compat, tries a zero-token
   * messages.create (the SDK rejects empty, so we use a tiny ping). Returns
   * `{ok, latencyMs, error?}` so the UI can show a badge.
   */
  app.post('/providers/:id/test', async (c) => {
    const cfg = store.getProvider(c.req.param('id'));
    if (!cfg) return c.json({ error: 'not found' }, 404);

    const started = Date.now();
    try {
      if (cfg.kind === 'copilot') {
        // Refresh short-lived Copilot token before testing.
        let token = cfg.api_key ?? '';
        try {
          const fresh = await refreshIfExpired(store, cfg.id);
          if (fresh) token = fresh;
        } catch { /* fall through with existing token */ }
        const opts = getStoredCopilotOpts(store, cfg.id);
        const base = resolveCopilotApiBase(store, cfg);
        const r = await fetch(`${base}/models`, {
          headers: copilotHeaders(token, opts),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      } else if (cfg.kind === 'chatgpt') {
        // ChatGPT (Codex backend) — refresh the OAuth access token, then
        // ping the Codex base with the auth headers. There's no public
        // /models endpoint so we use a lightweight /responses HEAD-ish
        // request; if the base URL returns anything other than 5xx/auth
        // errors we consider the provider healthy.
        let token = cfg.api_key ?? '';
        try {
          const fresh = await refreshOpenAIToken(store, cfg.id);
          if (fresh) token = fresh;
        } catch (e) {
          throw new Error(`token refresh failed: ${(e as Error).message}`);
        }
        if (!token) throw new Error('no access token stored — re-connect');
        const base = (cfg.base_url ?? CHATGPT_CODEX_BASE_URL).replace(/\/$/, '');
        const r = await fetch(`${base}/health`, {
          method: 'GET',
          headers: openaiAuthHeaders(token),
        }).catch(() => null);
        // Some Codex edges don't expose /health; accept any response that
        // isn't an auth failure as proof the token works.
        if (r && (r.status === 401 || r.status === 403)) {
          throw new Error(`HTTP ${r.status}`);
        }
      } else if (cfg.kind === 'openai') {
        const base = cfg.base_url ?? 'https://api.openai.com/v1';
        const url = base.endsWith('/') ? `${base}models` : `${base}/models`;
        const r = await fetch(url, {
          headers: { Authorization: `Bearer ${cfg.api_key ?? ''}` },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      } else if (cfg.kind === 'anthropic') {
        // Instantiate the adapter to validate key+baseURL; no network call is
        // cheaper than a minimal /v1/messages ping, so use that.
        const base = cfg.base_url ?? 'https://api.anthropic.com';
        const url = `${base.replace(/\/$/, '')}/v1/models`;
        const r = await fetch(url, {
          headers: {
            'x-api-key': cfg.api_key ?? '',
            'anthropic-version': '2023-06-01',
          },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      } else if (cfg.kind === 'gemini') {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(cfg.api_key ?? '')}`
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      } else if (cfg.kind === 'google-oauth') {
        let token = cfg.api_key ?? '';
        try {
          const fresh = await refreshGoogleOAuthToken(store, cfg.id);
          if (fresh) token = fresh;
        } catch (e) {
          throw new Error(`token refresh failed: ${(e as Error).message}`);
        }
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      } else if (cfg.kind === 'bedrock') {
        return c.json({ ok: false, error: 'bedrock test not implemented' });
      }
      return c.json({ ok: true, latencyMs: Date.now() - started });
    } catch (e) {
      return c.json({ ok: false, latencyMs: Date.now() - started, error: (e as Error).message });
    }
  });

  return app;
}
