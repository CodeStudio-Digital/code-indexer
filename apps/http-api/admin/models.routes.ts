/**
 * /providers/:id/models CRUD + live refresh.
 *
 * Manual upserts are tagged `source='manual'` so the next live refresh
 * doesn't wipe them. Live refresh replaces only `source='live'` rows.
 */
import { Hono } from 'hono';
import type { ProviderStore, UpsertModelInput } from '@mcp/store/provider-store.js';
import { discoverModels } from './model-discovery/index.js';
import {
  getRegistryContextWindow,
  mergeDBCapabilities,
  resolveContextWindowWithSource,
} from '@mcp/code-agent/providers/capabilities.js';

export function modelsRouter(store: ProviderStore): Hono {
  const app = new Hono();

  app.get('/providers/:id/models', (c) => {
    const id = c.req.param('id');
    if (!store.getProvider(id)) return c.json({ error: 'not found' }, 404);
    return c.json({ models: store.listModels(id) });
  });

  app.post('/providers/:id/models', async (c) => {
    // Manual upsert of a single model entry (used by the admin UI when the
    // user adds a model that didn't come from live discovery, e.g. a custom
    // Meridian model). Source is forced to 'manual' so the next refresh
    // doesn't wipe it.
    const id = c.req.param('id');
    if (!store.getProvider(id)) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json<UpsertModelInput>();
    if (!body.model_id || !body.name) {
      return c.json({ error: 'model_id, name required' }, 400);
    }
    // Phase F — auto-backfill context_window when admin omitted it. Saves
    // the resolved value silently when source is high-confidence (registry
    // exact/prefix or family-heuristic inferred). The hardcoded 128K
    // fallback is NOT written to DB — leaving NULL preserves the runtime
    // warning so the admin notices and overrides explicitly.
    let resolvedNote: string | null = null;
    const incomingBody: UpsertModelInput = { ...body, source: 'manual' };
    if (incomingBody.context_window == null) {
      const resolved = resolveContextWindowWithSource(incomingBody.model_id);
      if (resolved.source !== 'fallback') {
        incomingBody.context_window = resolved.window;
        resolvedNote = `${resolved.source} (${resolved.via})`;
        console.log(
          `[admin] auto-backfilled context_window=${resolved.window} for ${incomingBody.model_id} via ${resolved.via}`,
        );
      }
    }
    store.replaceModelsFromSource(id, 'manual', [
      // listModels then merge: replace only clears rows with source='manual',
      // so existing manual entries are overwritten but live rows survive.
      ...store
        .listModels(id)
        .filter((m) => m.source === 'manual' && m.model_id !== incomingBody.model_id)
        .map((m) => ({
          model_id: m.model_id,
          mode: m.mode,
          name: m.name,
          context_window: m.context_window,
          context_window_overridden: m.context_window_overridden,
          default_max_tokens: m.default_max_tokens,
          can_reason: m.can_reason,
          supports_attachments: m.supports_attachments,
          enabled: m.enabled,
          source: 'manual',
        })),
      incomingBody,
    ]);
    // If we backfilled a context_window, refresh the in-memory cache so
    // newly-created sessions pick it up without a server restart (mirrors
    // the PATCH route's behaviour at the bottom of this file).
    if (resolvedNote) {
      try { mergeDBCapabilities(store.listAllModels()); } catch { /* best-effort */ }
    }
    return c.json({ ok: true, context_window_resolved_from: resolvedNote });
  });

  app.patch('/providers/:id/models/:modelId', async (c) => {
    const id = c.req.param('id');
    const modelId = c.req.param('modelId');
    const mode = c.req.query('mode') ?? '';
    const body = await c.req.json<{
      enabled?: boolean;
      name?: string;
      default_reasoning_level?: string | null;
      context_window?: number | null;
      max_tools?: number | null;
    }>();
    if (body.default_reasoning_level !== undefined && body.default_reasoning_level !== null) {
      // Validate against the model's persisted supported_reasoning_levels — if
      // the row says null, we don't know what the model accepts, so don't gate.
      const row = store.listModels(id).find((m) => m.model_id === modelId && m.mode === mode);
      const supported = row?.supported_reasoning_levels;
      if (supported && !supported.includes(body.default_reasoning_level)) {
        return c.json(
          {
            error: `reasoning_level '${body.default_reasoning_level}' not supported for ${modelId}; supported: ${supported.join(',')}`,
          },
          400,
        );
      }
    }
    if (body.context_window !== undefined && body.context_window !== null) {
      // Sanity bounds: 1k–10M tokens. Avoids fat-finger like 200 (instead
      // of 200_000) silently destroying the dashboard.
      if (body.context_window < 1024 || body.context_window > 10_000_000) {
        return c.json(
          { error: `context_window must be between 1024 and 10_000_000 (got ${body.context_window})` },
          400,
        );
      }
    }
    if (body.max_tools !== undefined && body.max_tools !== null) {
      // Sanity bounds: below 4 the agent can't even hold the discovery core;
      // above 256 the cap is meaningless (largest catalogs are ~200).
      if (body.max_tools < 4 || body.max_tools > 256) {
        return c.json(
          { error: `max_tools must be between 4 and 256 (got ${body.max_tools})` },
          400,
        );
      }
    }
    store.updateModel(id, modelId, mode, body);
    // If we just changed a capability value, rehydrate the in-memory cache so
    // newly-created sessions pick up the value without a server restart.
    if (body.context_window !== undefined || body.max_tools !== undefined) {
      try {
        mergeDBCapabilities(store.listAllModels());
      } catch {
        /* best-effort */
      }
    }
    return c.json({ ok: true });
  });

  app.delete('/providers/:id/models/:modelId', (c) => {
    // Remove a single manually-added model. Scoped to source='manual' in the
    // store, so live/seeded rows can't be deleted here (the admin disables
    // those via the enabled toggle; they'd return on the next refresh).
    const id = c.req.param('id');
    const modelId = c.req.param('modelId');
    const mode = c.req.query('mode') ?? '';
    if (!store.getProvider(id)) return c.json({ error: 'not found' }, 404);
    const deleted = store.deleteManualModel(id, modelId, mode);
    if (deleted === 0) {
      return c.json(
        { error: 'no manual model matched (only manually-added models can be deleted)' },
        404,
      );
    }
    // Drop the row from the in-memory capability cache so newly-created
    // sessions stop seeing its overrides without a server restart.
    try {
      mergeDBCapabilities(store.listAllModels());
    } catch {
      /* best-effort */
    }
    return c.json({ ok: true });
  });

  /**
   * POST /providers/models/backfill-context-windows — walks every row in
   * provider_models that has context_window=NULL and fills it from the
   * full resolution chain (registry exact → prefix → family-heuristic).
   * Phase F adds the inferred layer so custom-named models get a
   * sensible default instead of the hardcoded 128K fallback at runtime.
   *
   * Idempotent, no network. The hardcoded 128K fallback is NOT written
   * to DB — leaving NULL preserves the runtime warning so the admin sees
   * it and overrides explicitly. Use `?strict=1` to force the legacy
   * registry-only behaviour (no inferred backfill).
   */
  app.post('/providers/models/backfill-context-windows', (c) => {
    const strict = c.req.query('strict') === '1';
    const lookup = strict
      ? getRegistryContextWindow
      : (modelId: string): number | null => {
          const r = resolveContextWindowWithSource(modelId);
          return r.source === 'fallback' ? null : r.window;
        };
    const result = store.backfillContextWindowsFromRegistry(lookup);
    if (result.updated > 0) {
      try {
        mergeDBCapabilities(store.listAllModels());
      } catch {
        /* best-effort */
      }
    }
    return c.json({ ...result, strict });
  });

  /**
   * POST /providers/:id/models/refresh — triggers live discovery and
   * replaces `source='live'` rows in provider_models. Manual rows survive.
   *
   * For providers that support catalog ETag (ChatGPT/Codex), passes the
   * stored ETag via `If-None-Match`. A 304 response short-circuits the
   * write — existing rows are left as-is and `notModified: true` is
   * returned so the UI can render "no changes" state.
   */
  app.post('/providers/:id/models/refresh', async (c) => {
    const cfg = store.getProvider(c.req.param('id'));
    if (!cfg) return c.json({ error: 'not found' }, 404);

    try {
      const previousEtag = store.getProviderCatalogEtag(cfg.id);
      const result = await discoverModels(store, cfg, previousEtag);
      if (result.notModified) {
        const current = store.listModels(cfg.id).filter((m) => m.source === 'live').length;
        return c.json({ ok: true, count: current, notModified: true });
      }
      store.replaceModelsFromSource(cfg.id, 'live', result.models);
      store.setProviderCatalogEtag(cfg.id, result.etag);
      return c.json({ ok: true, count: result.models.length, notModified: false });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  app.patch('/providers/:id/subagent-model', async (c) => {
    const id = c.req.param('id');
    if (!store.getProvider(id)) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json<{ provider_id?: string | null; model_id?: string | null }>();
    const targetProviderId = body.provider_id && body.provider_id.length > 0 ? body.provider_id : id;
    const targetProvider = store.getProvider(targetProviderId);
    if (!targetProvider || !targetProvider.enabled || !targetProvider.use_for_coder) {
      return c.json({ error: 'subagent provider must be an enabled coder provider' }, 400);
    }
    store.setSubagentTarget(id, targetProviderId, body.model_id ?? null);
    return c.json({ ok: true });
  });

  return app;
}
