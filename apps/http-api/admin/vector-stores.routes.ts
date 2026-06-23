/**
 * /vector-stores — list + upsert vector-store backend configs.
 *
 * Mirrors the shape of embeddings.routes.ts. The admin UI uses these
 * endpoints to pick between Cloudflare Vectorize, Qdrant, OpenSearch
 * (Bedrock), Pinecone, etc. — independently of the embedding model.
 */
import { Hono } from 'hono';
import type { ProviderStore, VectorStoreKind } from '@mcp/store/provider-store.js';

export function vectorStoresRouter(store: ProviderStore): Hono {
  const app = new Hono();

  app.get('/vector-stores', (c) => {
    return c.json({ configs: store.listVectorStoreConfigs() });
  });

  app.put('/vector-stores/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<{
      kind: VectorStoreKind;
      name: string;
      enabled?: boolean;
      is_default?: boolean;
      config?: Record<string, unknown>;
    }>();
    if (!body.kind || !body.name) return c.json({ error: 'kind, name required' }, 400);
    const saved = store.upsertVectorStoreConfig({ id, ...body });
    return c.json(saved);
  });

  return app;
}
