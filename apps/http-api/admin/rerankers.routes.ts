/**
 * /rerankers — list + upsert cross-encoder reranker configs.
 *
 * Mirrors the shape of embeddings.routes.ts / vector-stores.routes.ts. The
 * admin UI uses these endpoints to turn reranking on/off and pick between
 * Cloudflare Workers AI (@cf/baai/bge-reranker-base) and Cohere Rerank —
 * applied after the RRF merge to boost precision.
 */
import { Hono } from 'hono';
import type { ProviderStore, RerankerKind } from '@mcp/store/provider-store.js';

export function rerankersRouter(store: ProviderStore): Hono {
  const app = new Hono();

  app.get('/rerankers', (c) => {
    return c.json({ configs: store.listRerankerConfigs() });
  });

  app.put('/rerankers/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<{
      kind: RerankerKind;
      name: string;
      enabled?: boolean;
      is_default?: boolean;
      config?: Record<string, unknown>;
    }>();
    if (!body.kind || !body.name) return c.json({ error: 'kind, name required' }, 400);
    const saved = store.upsertRerankerConfig({ id, ...body });
    return c.json(saved);
  });

  return app;
}
