/**
 * /embeddings — list + upsert embedding backend configs.
 */
import { Hono } from 'hono';
import type { ProviderStore, EmbeddingKind } from '../../../store/provider-store.js';

export function embeddingsRouter(store: ProviderStore): Hono {
  const app = new Hono();

  app.get('/embeddings', (c) => {
    return c.json({ configs: store.listEmbeddingConfigs() });
  });

  app.put('/embeddings/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<{
      kind: EmbeddingKind;
      name: string;
      enabled?: boolean;
      is_default?: boolean;
      config?: Record<string, unknown>;
    }>();
    if (!body.kind || !body.name) return c.json({ error: 'kind, name required' }, 400);
    const saved = store.upsertEmbeddingConfig({ id, ...body });
    return c.json(saved);
  });

  return app;
}
