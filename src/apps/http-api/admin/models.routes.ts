/**
 * /providers/:id/models CRUD + live refresh.
 *
 * Manual upserts are tagged `source='manual'` so the next live refresh
 * doesn't wipe them. Live refresh replaces only `source='live'` rows.
 */
import { Hono } from 'hono';
import type { ProviderStore, UpsertModelInput } from '../../../store/provider-store.js';
import { discoverModels } from './model-discovery/index.js';

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
    store.replaceModelsFromSource(id, 'manual', [
      // listModels then merge: replace only clears rows with source='manual',
      // so existing manual entries are overwritten but live rows survive.
      ...store
        .listModels(id)
        .filter((m) => m.source === 'manual' && m.model_id !== body.model_id)
        .map((m) => ({
          model_id: m.model_id,
          mode: m.mode,
          name: m.name,
          context_window: m.context_window,
          default_max_tokens: m.default_max_tokens,
          can_reason: m.can_reason,
          supports_attachments: m.supports_attachments,
          enabled: m.enabled,
          source: 'manual',
        })),
      { ...body, source: 'manual' },
    ]);
    return c.json({ ok: true });
  });

  app.patch('/providers/:id/models/:modelId', async (c) => {
    const id = c.req.param('id');
    const modelId = c.req.param('modelId');
    const mode = c.req.query('mode') ?? '';
    const body = await c.req.json<{ enabled?: boolean; name?: string }>();
    store.updateModel(id, modelId, mode, body);
    return c.json({ ok: true });
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

  return app;
}
