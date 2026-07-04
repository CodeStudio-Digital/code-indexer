/**
 * Sprite Studio — in-studio image-model picker (quick switch, no admin trip).
 *
 *   GET /api/sprite-studio/models   image-capable models across enabled providers
 *   GET /api/sprite-studio/binding  the active image_gen model (what generation uses)
 *   PUT /api/sprite-studio/binding  set the active image_gen model
 *
 * Semantics: the studio picker is SINGLE-ACTIVE — selecting a model makes it
 * THE global `sprite-studio/image_gen` binding and disables the others at the
 * global scope. Multi-link failover chains stay an admin/Pipelines concern.
 */
import type { Hono } from 'hono';
import { estimatePerImage } from '@mcp/sprite-studio/jobs/pricing.js';
import type { ServerDeps } from '../../deps.js';

const PIPELINE = 'sprite-studio';
const ROLE = 'image_gen';

export function mountSpriteModelRoutes(app: Hono, deps: ServerDeps): void {
  const { providerStore, pipelineBindingsStore, pipelineProviderResolver } = deps;

  // Every model row tagged mode='image' on an enabled provider, with an
  // approximate USD-per-image hint so the picker makes cost visible BEFORE
  // the user burns a batch on a premium tier.
  app.get('/api/sprite-studio/models', (c) => {
    const models: Array<{
      providerId: string; providerName: string; modelId: string; label: string; estUsdPerImage: number;
    }> = [];
    for (const p of providerStore.listProviders({ enabled: true })) {
      for (const m of providerStore.listModels(p.id)) {
        if (m.mode !== 'image') continue;
        models.push({
          providerId: p.id,
          providerName: p.name,
          modelId: m.model_id,
          // Subscription-billed providers (ChatGPT OAuth) cost $0 per image.
          label: `${p.name} · ${m.name || m.model_id}`,
          estUsdPerImage: p.kind === 'chatgpt' ? 0 : estimatePerImage(m.model_id),
        });
      }
      // ChatGPT (Codex OAuth): the standalone images endpoints exist on the
      // subscription backend but its model discovery only lists chat models —
      // synthesize the image entry here (no DB row → chat pickers unpolluted).
      if (p.kind === 'chatgpt' && !models.some((m) => m.providerId === p.id && /^gpt-image/.test(m.modelId))) {
        models.push({
          providerId: p.id,
          providerName: p.name,
          modelId: 'gpt-image-2',
          label: `${p.name} · gpt-image-2`,
          estUsdPerImage: 0,
        });
      }
    }
    return c.json({ models });
  });

  // The currently-active image_gen model (resolves the whole hierarchy).
  app.get('/api/sprite-studio/binding', async (c) => {
    const b = await pipelineProviderResolver.resolveOrNull(PIPELINE, ROLE, {});
    if (!b) return c.json({ binding: null });
    return c.json({ binding: { providerId: b.provider.id, modelId: b.modelId, providerName: b.provider.name } });
  });

  app.put('/api/sprite-studio/binding', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { providerId?: string; modelId?: string } | null;
    if (!body?.providerId || !body?.modelId) return c.json({ error: 'invalid_body' }, 400);
    const provider = providerStore.getProvider(body.providerId);
    if (!provider) return c.json({ error: 'unknown_provider' }, 404);

    // Single-active: disable the other global image_gen bindings, then upsert
    // the chosen one enabled. Upsert matches on (…, provider, model) so
    // re-picking the same model just re-enables it.
    const existing = pipelineBindingsStore.findAllActiveAtScope({
      pipelineName: PIPELINE, bindingRole: ROLE, scopeType: 'global', scopeId: null,
    });
    for (const b of existing) {
      if (b.provider_id !== body.providerId || b.model_id !== body.modelId) {
        pipelineBindingsStore.setEnabled(b.id, false);
      }
    }
    pipelineBindingsStore.upsert({
      pipeline_name: PIPELINE, binding_role: ROLE,
      provider_id: body.providerId, model_id: body.modelId,
      scope_type: 'global', scope_id: null, enabled: true, priority: 100,
    });
    return c.json({ binding: { providerId: body.providerId, modelId: body.modelId, providerName: provider.name } });
  });
}
