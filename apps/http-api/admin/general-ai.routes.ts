/**
 * /general-ai — operator-pinned model for utility AI tasks.
 *
 * GET  /general-ai      — current selection + eligible providers/models.
 * PUT  /general-ai      — persist `{ providerId, modelId }` as the default.
 *
 * Selection scope is app-wide. The provider must be flagged
 * `use_for_general=1` (toggled on the Providers panel) and the model must be
 * enabled for that provider. The store enforces both conditions again at read
 * time so a later toggle can't leave a dangling pointer.
 */
import { Hono } from 'hono';
import type { ProviderStore } from '@mcp/store/provider-store.js';

export function generalAiRouter(store: ProviderStore): Hono {
  const app = new Hono();

  app.get('/general-ai', (c) => {
    const current = store.getGeneralDefault();
    const providers = store
      .listProviders({ enabled: true, use_for_general: true })
      .map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        models: store.listModels(p.id, true).map((m) => ({
          model_id: m.model_id,
          name: m.name,
        })),
      }));
    return c.json({
      providerId: current?.providerId ?? null,
      modelId: current?.modelId ?? null,
      availableProviders: providers,
    });
  });

  app.put('/general-ai', async (c) => {
    const body = await c.req
      .json<{ providerId?: string; modelId?: string }>()
      .catch(() => ({} as { providerId?: string; modelId?: string }));
    const providerId = typeof body.providerId === 'string' ? body.providerId : '';
    const modelId = typeof body.modelId === 'string' ? body.modelId : '';
    if (!providerId || !modelId) {
      return c.json({ error: 'providerId and modelId required' }, 400);
    }
    const provider = store.getProvider(providerId);
    if (!provider) return c.json({ error: 'provider not found' }, 404);
    if (!provider.use_for_general) {
      return c.json(
        { error: "provider is not flagged 'use_for_general'" },
        400,
      );
    }
    const hasModel = store.listModels(providerId, true).some((m) => m.model_id === modelId);
    if (!hasModel) return c.json({ error: 'model not enabled for provider' }, 400);
    store.setGeneralDefault(providerId, modelId);
    return c.json({ ok: true, providerId, modelId });
  });

  return app;
}
