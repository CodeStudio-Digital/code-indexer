import type { Hono } from 'hono';
import type { ProviderName } from '@mcp/shared/types.js';
import type { ServerDeps } from '../deps.js';

export function mountModelsRoutes(app: Hono, deps: ServerDeps): void {
  const { modelDiscovery } = deps;

  app.get('/api/models', async (c) => {
    const provider = c.req.query('provider') as ProviderName | undefined;
    const live = c.req.query('live') === 'true';
    return c.json(await modelDiscovery.discoverModels(provider, live, { signal: c.req.raw.signal }));
  });
}
