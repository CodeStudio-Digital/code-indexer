import type { Hono } from 'hono';
import type { ServerDeps } from '../deps.js';

interface EstimateCostBody {
  provider?: string;
  model?: string;
}

export function mountCostsRoutes(app: Hono, deps: ServerDeps): void {
  const { db, config, costTracker } = deps;

  app.get('/api/costs', (c) => {
    return c.json(costTracker.getGlobalCosts(c.req.query('since')));
  });

  app.get('/api/projects/:id/costs', (c) => {
    return c.json(costTracker.getProjectCosts(parseInt(c.req.param('id'), 10), c.req.query('since')));
  });

  app.get('/api/runs/:id/costs', (c) => {
    return c.json(costTracker.getRunCost(parseInt(c.req.param('id'), 10)));
  });

  app.post('/api/projects/:id/costs/estimate', async (c) => {
    const projectId = parseInt(c.req.param('id'), 10);
    const body = await c.req
      .json<EstimateCostBody>()
      .catch((): Record<string, never> => ({}));
    const stats = db.getStats(projectId);
    return c.json(
      costTracker.estimateCost({
        fileCount: stats.file_count || 100,
        provider: body.provider ?? config.provider ?? 'zai',
        model: body.model ?? config.model ?? 'glm-5.1',
        embeddingsEnabled: config.embeddings.enabled,
      }),
    );
  });
}
