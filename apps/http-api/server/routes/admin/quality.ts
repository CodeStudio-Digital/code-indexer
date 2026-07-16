/**
 * Admin routes for hybrid Quality plus legacy counterfactual compatibility.
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
import { peekCoderWorkerPool } from '../../../sse/coderWorkerPoolSingleton.js';
import { peekWorkerOrchestratorPool } from '../../../sse/workerPoolSingleton.js';

export function mountAdminQualityRoutes(app: Hono, deps: ServerDeps): void {
  const { qualityClassificationStore, qualityInterventionStore, counterfactualLogStore } = deps;

  // ─── Runtime on/off toggle ─────────────────────────────────────────────
  // The compatibility env alias is the desired process-lifetime state. Active
  // workers must ACK it; newly spawned workers receive it in workerData.
  const qualityStatus = async () => {
    const desired = process.env.MCP_PIPELINES_QUALITY_CLASSIFIERS === '1';
    await Promise.all([
      peekCoderWorkerPool()?.refreshQualityStatus() ?? Promise.resolve([]),
      peekWorkerOrchestratorPool()?.refreshQualityStatus() ?? Promise.resolve([]),
    ]);
    const workers = [
      ...(peekCoderWorkerPool()?.qualitySnapshot().map((row) => ({ ...row, kind: 'coder' as const })) ?? []),
      ...(peekWorkerOrchestratorPool()?.qualitySnapshot().map((row) => ({ ...row, kind: 'company' as const })) ?? []),
    ];
    const acknowledged = workers.filter((worker) => worker.enabled === desired).length;
    return {
      enabled: isGlobalQualityClassifierEnabled() && acknowledged === workers.length,
      desiredEnabled: desired,
      mode: 'hybrid' as const,
      target: 'completed_round' as const,
      workers: {
        total: workers.length,
        acknowledged,
        failed: workers.length - acknowledged,
        states: workers,
      },
    };
  };

  app.get('/api/admin/quality/enabled', async (c) => c.json(await qualityStatus()));

  app.post('/api/admin/quality/enabled', async (c) => {
    let body: { enabled?: boolean } = {};
    try { body = (await c.req.json()) as { enabled?: boolean }; } catch { /* */ }
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled (boolean) required' }, 400);
    }
    process.env.MCP_PIPELINES_QUALITY_CLASSIFIERS = body.enabled ? '1' : '0';
    setGlobalQualityClassifierPipeline(deps.qualityClassifierPipeline, body.enabled);
    const jobs: Array<Promise<unknown>> = [];
    const coderPool = peekCoderWorkerPool();
    const companyPool = peekWorkerOrchestratorPool();
    if (coderPool) jobs.push(coderPool.setQualityEnabled(body.enabled));
    if (companyPool) jobs.push(companyPool.setQualityEnabled(body.enabled));
    await Promise.all(jobs);
    return c.json(await qualityStatus());
  });

  app.get('/api/admin/quality/overview', (c) => {
    const since = c.req.query('since') ?? undefined;
    return c.json(qualityClassificationStore.overview({ since }));
  });

  app.get('/api/admin/quality/delivery', (c) => {
    const since = c.req.query('since') ?? undefined;
    const limit = Math.max(1, Math.min(2000, Number(c.req.query('limit') ?? 200)));
    return c.json({ rows: qualityClassificationStore.listRecent({ scope: 'run_final', since, limit }) });
  });

  app.get('/api/admin/quality/runtime', (c) => {
    const since = c.req.query('since') ?? undefined;
    const limit = Math.max(1, Math.min(2000, Number(c.req.query('limit') ?? 200)));
    return c.json({ rows: qualityClassificationStore.listRecent({ scope: 'runtime', since, limit }) });
  });

  app.get('/api/admin/quality/legacy', (c) => {
    const since = c.req.query('since') ?? undefined;
    const limit = Math.max(1, Math.min(2000, Number(c.req.query('limit') ?? 200)));
    return c.json({
      rows: qualityClassificationStore.listRecent({ scope: 'legacy_turn', since, limit }),
      distribution: qualityClassificationStore.verdictDistribution({
        since,
        scope: 'legacy_turn',
        excludeSystemErrors: c.req.query('include_system_errors') !== '1',
      }),
    });
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
      // Mig 202: infra failures ficam FORA da distribuição de conteúdo por
      // default (eram ~90% dos 'error' e mascaravam o julgamento real);
      // `include_system_errors=1` devolve o cru.
      const includeSys = c.req.query('include_system_errors') === '1';
      const dist = qualityClassificationStore.verdictDistribution({
        since: since ?? undefined,
        excludeSystemErrors: !includeSys,
      });
      const systemErrors = qualityClassificationStore.countSystemErrors({ since: since ?? undefined });
      return c.json({ rows: [], distribution: dist, systemErrors });
    }
    return c.json({ rows });
  });

  app.get('/api/admin/quality/distribution', (c) => {
    const classifier = c.req.query('classifier_name') ?? undefined;
    const since = c.req.query('since') ?? undefined;
    const includeSys = c.req.query('include_system_errors') === '1';
    const scopeRaw = c.req.query('scope');
    const scope = scopeRaw === 'run_final' || scopeRaw === 'runtime' || scopeRaw === 'legacy_turn'
      ? scopeRaw
      : undefined;
    return c.json({
      distribution: qualityClassificationStore.verdictDistribution({
        classifierName: classifier,
        since,
        scope,
        excludeSystemErrors: !includeSys,
      }),
      systemErrors: qualityClassificationStore.countSystemErrors({ since }),
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
