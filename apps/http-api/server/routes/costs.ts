import type { Hono } from 'hono';
import type { ServerDeps } from '../deps.js';
import { parseIdParam, parseJsonBody } from './_helpers.js';

interface EstimateCostBody {
  provider?: string;
  model?: string;
}

export function mountCostsRoutes(app: Hono, deps: ServerDeps): void {
  const { db, costTracker, providerStore } = deps;

  app.get('/api/costs', (c) => {
    return c.json(costTracker.getGlobalCosts(c.req.query('since')));
  });

  app.get('/api/projects/:id/costs', (c) => {
    return c.json(costTracker.getProjectCosts(parseIdParam(c), c.req.query('since')));
  });

  app.get('/api/runs/:id/costs', (c) => {
    return c.json(costTracker.getRunCost(parseIdParam(c)));
  });

  app.post('/api/projects/:id/costs/estimate', async (c) => {
    const projectId = parseIdParam(c);
    const body = await parseJsonBody<EstimateCostBody>(c);
    const stats = db.getStats(projectId);
    const defaults = providerStore.getDefaultProviderAndModel();
    const embeddingCfg = providerStore.getDefaultEmbedding();
    return c.json(
      costTracker.estimateCost({
        fileCount: stats.file_count || 100,
        provider: body.provider ?? defaults.kind,
        model: body.model ?? defaults.model ?? 'glm-5.1',
        embeddingsEnabled: !!embeddingCfg,
      }),
    );
  });
}
