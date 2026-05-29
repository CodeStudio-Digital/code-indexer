/**
 * Admin routes for the pipeline_telemetry table (migration 080).
 *
 *   GET /api/admin/telemetry/pipelines              → recent rows (filterable)
 *   GET /api/admin/telemetry/pipelines/summary      → window-wide aggregate (cards)
 *   GET /api/admin/telemetry/pipelines/histogram    → bucket counts
 *   GET /api/admin/telemetry/pipelines/cache-stats  → hit rate per component
 *   POST /api/admin/telemetry/pipelines/prune       → drop rows older than cutoff
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';

export function mountAdminPipelineTelemetryRoutes(app: Hono, deps: ServerDeps): void {
  const { pipelineTelemetryStore } = deps;

  app.get('/api/admin/telemetry/pipelines', (c) => {
    const pipelineName = c.req.query('pipeline_name') ?? undefined;
    const stage        = c.req.query('stage') ?? undefined;
    const sessionIdRaw = c.req.query('session_id');
    const companySessionIdRaw = c.req.query('company_session_id');
    const since        = c.req.query('since') ?? undefined;
    const limitRaw     = c.req.query('limit');
    const limit = limitRaw ? Math.max(1, Math.min(2000, Number(limitRaw))) : 500;

    const opts: {
      pipelineName?: string;
      stage?: string;
      sessionId?: number;
      companySessionId?: number;
      since?: string;
      limit?: number;
    } = { limit };
    if (pipelineName) opts.pipelineName = pipelineName;
    if (stage) opts.stage = stage;
    if (sessionIdRaw && Number.isFinite(Number(sessionIdRaw))) opts.sessionId = Number(sessionIdRaw);
    if (companySessionIdRaw && Number.isFinite(Number(companySessionIdRaw))) opts.companySessionId = Number(companySessionIdRaw);
    if (since) opts.since = since;

    return c.json({ rows: pipelineTelemetryStore.list(opts) });
  });

  app.get('/api/admin/telemetry/pipelines/summary', (c) => {
    const pipelineName = c.req.query('pipeline_name') ?? undefined;
    const stage        = c.req.query('stage') ?? undefined;
    const since        = c.req.query('since') ?? undefined;

    const opts: { pipelineName?: string; stage?: string; since?: string } = {};
    if (pipelineName) opts.pipelineName = pipelineName;
    if (stage) opts.stage = stage;
    if (since) opts.since = since;

    return c.json({ summary: pipelineTelemetryStore.summary(opts) });
  });

  app.get('/api/admin/telemetry/pipelines/histogram', (c) => {
    const pipelineName = c.req.query('pipeline_name') ?? undefined;
    const stage        = c.req.query('stage') ?? undefined;
    const bucketField  = c.req.query('bucket_field') === 'size_bucket' ? 'size_bucket' : 'duration_bucket';
    const since        = c.req.query('since') ?? undefined;

    const opts: {
      pipelineName?: string;
      stage?: string;
      bucketField: 'duration_bucket' | 'size_bucket';
      since?: string;
    } = { bucketField };
    if (pipelineName) opts.pipelineName = pipelineName;
    if (stage) opts.stage = stage;
    if (since) opts.since = since;

    return c.json({ histogram: pipelineTelemetryStore.histogram(opts), bucketField });
  });

  app.get('/api/admin/telemetry/pipelines/cache-stats', (c) => {
    const pipelineName = c.req.query('pipeline_name') ?? undefined;
    const stage        = c.req.query('stage') ?? undefined;
    const since        = c.req.query('since') ?? undefined;

    const opts: { pipelineName?: string; stage?: string; since?: string } = {};
    if (pipelineName) opts.pipelineName = pipelineName;
    if (stage) opts.stage = stage;
    if (since) opts.since = since;

    return c.json({ stats: pipelineTelemetryStore.cacheStats(opts) });
  });

  app.post('/api/admin/telemetry/pipelines/prune', async (c) => {
    let body: { cutoff?: string } = {};
    try {
      body = (await c.req.json()) as { cutoff?: string };
    } catch {
      /* allow empty body */
    }
    const cutoff = body.cutoff ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const deleted = pipelineTelemetryStore.pruneOlderThan(cutoff);
    return c.json({ deleted, cutoff });
  });
}
