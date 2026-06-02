/**
 * Admin routes for quality classifications + counterfactual logs.
 *
 *   GET  /api/admin/quality                          → recent verdicts
 *   GET  /api/admin/quality/distribution             → verdict counts per classifier
 *   POST /api/admin/quality/prune                    → drop rows older than cutoff
 *
 *   GET  /api/admin/quality/interventions/stats      → effectiveness aggregation (v2 C5)
 *
 *   GET  /api/admin/counterfactuals                  → recent shadow rows
 *   GET  /api/admin/counterfactuals/stats            → aggregated stats
 *   POST /api/admin/counterfactuals/:id/outcome      → backfill true_outcome_json
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import {
  isGlobalQualityClassifierEnabled,
  setGlobalQualityClassifierPipeline,
} from '@mcp/services/quality/index.js';

export function mountAdminQualityRoutes(app: Hono, deps: ServerDeps): void {
  const { qualityClassificationStore, qualityInterventionStore, counterfactualLogStore } = deps;

  // ─── Runtime on/off toggle ─────────────────────────────────────────────
  // The classifiers run in THIS (main) process — the global is only ever set
  // here, never in the coder/company workers — so toggling it here is enough;
  // no worker RPC needed. Persists only for the process lifetime (the boot
  // default is the MCP_PIPELINES_QUALITY_CLASSIFIERS env flag).
  app.get('/api/admin/quality/enabled', (c) =>
    c.json({ enabled: isGlobalQualityClassifierEnabled() }),
  );

  app.post('/api/admin/quality/enabled', async (c) => {
    let body: { enabled?: boolean } = {};
    try { body = (await c.req.json()) as { enabled?: boolean }; } catch { /* */ }
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled (boolean) required' }, 400);
    }
    setGlobalQualityClassifierPipeline(deps.qualityClassifierPipeline, body.enabled);
    return c.json({ enabled: isGlobalQualityClassifierEnabled() });
  });

  // ─── Quality classifications ────────────────────────────────────────
  app.get('/api/admin/quality', (c) => {
    const classifier = c.req.query('classifier_name');
    const limitRaw = c.req.query('limit');
    const since = c.req.query('since');
    const limit = limitRaw ? Math.max(1, Math.min(2000, Number(limitRaw))) : 200;

    let rows;
    if (classifier) {
      rows = qualityClassificationStore.listByClassifier(classifier, {
        limit,
        since: since ?? undefined,
      });
    } else {
      // No "list all" yet; just return distribution + a thin slice via
      // listByClassifier for the first known classifier.
      const dist = qualityClassificationStore.verdictDistribution({ since: since ?? undefined });
      return c.json({ rows: [], distribution: dist });
    }
    return c.json({ rows });
  });

  app.get('/api/admin/quality/distribution', (c) => {
    const classifier = c.req.query('classifier_name') ?? undefined;
    const since = c.req.query('since') ?? undefined;
    return c.json({
      distribution: qualityClassificationStore.verdictDistribution({
        classifierName: classifier,
        since,
      }),
    });
  });

  app.post('/api/admin/quality/prune', async (c) => {
    let body: { cutoff?: string; all?: boolean } = {};
    try { body = (await c.req.json()) as { cutoff?: string; all?: boolean }; } catch { /* */ }
    // "Limpar tudo" — wipe both quality tables regardless of age.
    if (body.all) {
      const deleted =
        qualityClassificationStore.clearAll() + qualityInterventionStore.clearAll();
      return c.json({ deleted, all: true });
    }
    const cutoff = body.cutoff ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const deleted = qualityClassificationStore.pruneOlderThan(cutoff);
    return c.json({ deleted, cutoff });
  });

  // ─── Quality v2, C5 — Intervention effectiveness ───────────────────────
  //
  // Returns per-type aggregates (improved/unchanged/worsened/pending) so the
  // dashboard can show a headline "improved rate" per intervention_type plus
  // a short list of recent activity. `since` narrows the window; omit it for
  // all-time stats.
  app.get('/api/admin/quality/interventions/stats', (c) => {
    const since = c.req.query('since') ?? undefined;
    const recentLimitRaw = c.req.query('recent_limit');
    const recentLimit = recentLimitRaw ? Math.max(1, Math.min(200, Number(recentLimitRaw))) : 20;
    return c.json(qualityInterventionStore.effectivenessStats({ since, recentLimit }));
  });

  // ─── Counterfactual logs ────────────────────────────────────────────
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
    try { body = (await c.req.json()) as typeof body; }
    catch { return c.json({ error: 'invalid_json' }, 400); }
    if (body.true_outcome == null) return c.json({ error: 'true_outcome required' }, 400);
    const updated = counterfactualLogStore.recordOutcome({
      id,
      true_outcome: body.true_outcome,
      outcome_confidence: body.outcome_confidence,
    });
    return c.json({ updated });
  });
}
