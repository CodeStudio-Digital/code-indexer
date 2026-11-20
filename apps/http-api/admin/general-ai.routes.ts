/**
 * /general-ai — operator-pinned model for utility AI tasks.
 *
 * GET  /general-ai      — current selection + ALL enabled providers/models.
 * PUT  /general-ai      — persist `{ providerId, modelId }` as the default.
 *
 * History: earlier iterations filtered by an extra `use_for_general=1`
 * flag toggled from the Provider edit dialog. The flag wasn't
 * discoverable — the Configurações → IA Geral dropdown would silently
 * list one or zero providers and the user had no idea why. We dropped
 * the curation in favour of "every provider you've enabled is a
 * candidate" — the GUI gets ALL of them, the user picks, end of
 * story. If a particular provider can't actually be used for utility
 * tasks (OAuth-only kinds, no api_key, etc.), the utility caller
 * (e.g. coder generate-title) still falls through to its own
 * fallback chain.
 */
import { HttpRouter } from '@mcp/shared/http/router.js';
import type { ProviderStore } from '@mcp/store/provider-store.js';

export function generalAiRouter(store: ProviderStore): HttpRouter {
  const app = new HttpRouter();

  app.get('/general-ai', (c) => {
    const current = store.getGeneralDefault();
    const providers = store
      .listProviders({ enabled: true })
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
    if (!provider.enabled) {
      return c.json({ error: 'provider is disabled — enable it first' }, 400);
    }
    const hasModel = store.listModels(providerId, true).some((m) => m.model_id === modelId);
    if (!hasModel) return c.json({ error: 'model not enabled for provider' }, 400);
    store.setGeneralDefault(providerId, modelId);
    return c.json({ ok: true, providerId, modelId });
  });

  return app;
}
