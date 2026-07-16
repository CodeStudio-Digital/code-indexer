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
} from '@mcp/store/provider-store.js';
import { getDefinition } from '@mcp/services/providers/registry.js';
import { resolveCreds } from '@mcp/services/providers/shared/resolver.js';
import { publicProvider } from './shared/mask.js';
import { refreshAllProviderModels } from '@mcp/indexer/indexer/providers/scheduled-refresh.js';

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
    const { listDefinitions } = await import('@mcp/services/providers/registry.js');
    return c.json(
      listDefinitions().map((def) => ({
        kind: def.kind,
        displayName: def.displayName,
        credKind: def.credKind,
        envVars: def.envVars,
        defaultBaseURL: def.defaultBaseURL ?? null,
        defaultModels: def.defaultModels,
        capabilities: def.capabilities ?? {},
        visual: def.visual ?? null,
        // Declarative settings form + connect descriptor (built-ins AND plugins),
        // so the dashboard renders each provider's config screen with no per-kind code.
        config: def.config ?? null,
        auth: def.auth ?? null,
        supportsCoder: !!def.createCoder,
      })),
    );
  });

  app.get('/providers', (c) => {
    // Enrich each row with its definition's visual identity (icon name +
    // accent classes) so the dashboard renders tiles data-driven instead of
    // from a hardcoded kind→icon map. `null` for kinds without a definition.
    return c.json({
      providers: store.listProviders().map((p) => ({
        ...publicProvider(p),
        visual: getDefinition(p.kind)?.visual ?? null,
      })),
    });
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
      use_for_general?: boolean;
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
      use_for_general?: boolean;
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
      use_for_general: body.use_for_general ?? existing.use_for_general,
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
   * POST /providers/:id/test — cheap connectivity check. Resolves credentials
   * once (refreshing OAuth tokens), then delegates the actual ping to the
   * provider definition's `testConnection`. Returns `{ok, latencyMs, error?}`
   * so the UI can show a badge. Shapes without a `testConnection` (e.g. the
   * OpenAI-compat zai/deepseek/cloudflare/moonshot) are a no-op pass, matching
   * the prior behaviour. A plugin-contributed provider gets tested the same way.
   */
  app.post('/providers/:id/test', async (c) => {
    const cfg = store.getProvider(c.req.param('id'));
    if (!cfg) return c.json({ error: 'not found' }, 404);

    const def = getDefinition(cfg.kind);
    const started = Date.now();
    if (!def?.testConnection) {
      return c.json({ ok: true, latencyMs: Date.now() - started });
    }
    try {
      const creds = await resolveCreds(def, cfg);
      await def.testConnection({ config: cfg, creds });
      return c.json({ ok: true, latencyMs: Date.now() - started });
    } catch (e) {
      return c.json({ ok: false, latencyMs: Date.now() - started, error: (e as Error).message });
    }
  });

  /**
   * POST /providers/refresh-all — trigger immediate live discovery for all
   * enabled providers. Useful to force-refresh context_window values.
   */
  app.post('/providers/refresh-all', async (c) => {
    try {
      await refreshAllProviderModels(store);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  return app;
}
