/**
 * Admin routes for global counterfactual shadow-traffic observations.
 * Session-owned observations are stored in their filesystem bundles.
 *
 *   GET  /api/admin/counterfactuals
 *   GET  /api/admin/counterfactuals/stats
 *   POST /api/admin/counterfactuals/:id/outcome
 */
import type { HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../../deps.js';

export function mountAdminCounterfactualRoutes(app: HttpRouter, deps: ServerDeps): void {
  const { counterfactualLogStore } = deps;

  app.get('/api/admin/counterfactuals', (c) => {
    const pipelineName = c.req.query('pipeline_name') ?? undefined;
    const shadowVariant = c.req.query('shadow_variant') ?? undefined;
    const since = c.req.query('since') ?? undefined;
    const limitRaw = c.req.query('limit');
    const limit = limitRaw ? Math.max(1, Math.min(2000, Number(limitRaw))) : 200;
    return c.json({
      rows: counterfactualLogStore.list({ pipelineName, shadowVariant, since, limit }),
    });
  });

  app.get('/api/admin/counterfactuals/stats', (c) => {
    const since = c.req.query('since') ?? undefined;
    return c.json(counterfactualLogStore.stats({ since }));
  });

  app.post('/api/admin/counterfactuals/:id/outcome', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid_id' }, 400);
    let body: { true_outcome?: unknown; outcome_confidence?: number };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (body.true_outcome == null) return c.json({ error: 'true_outcome required' }, 400);
    const updated = counterfactualLogStore.recordOutcome({
      id,
      true_outcome: body.true_outcome,
      outcome_confidence: body.outcome_confidence,
    });
    return c.json({ updated });
  });
}
