import type { HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../deps.js';
import { parseSessionIdParam } from './_helpers.js';
import { getRecentMissingPrices } from '@mcp/code-agent/providers/pricing-cache.js';
import {
  getFilesystemFirstTurnPayload,
  getFilesystemSessionTelemetrySummary,
  listFilesystemTurnTelemetry,
} from '@mcp/session-storage/fs-store/telemetry-dashboard.js';
import {
  getFilesystemGlobalTelemetrySummary,
  inspectFilesystemCostCoverage,
} from '@mcp/session-storage/fs-store/telemetry-global-dashboard.js';
import { refreshAllModelPrices } from '@mcp/indexer/indexer/providers/scheduled-pricing-refresh.js';
import { getEnabledPriceSources, isRemotePriceSyncEnabled } from '@mcp/services/services/pricing/index.js';

/**
 * Telemetry routes over immutable per-session metric files. No handler in
 * this module has a SQLite session query or a compatibility fallback.
 *
 *   GET  /api/admin/telemetry/global         → admin dashboard payload
 *   POST /api/admin/telemetry/backfill-costs  → re-price historical turns
 *   GET  /api/admin/model-prices             → model_prices rows + no-price models
 *   POST /api/admin/model-prices/sync        → manual price refresh (OpenRouter + LiteLLM)
 *   GET  /api/sessions/:id/telemetry          → per-session summary (modal)
 *   GET  /api/sessions/:id/telemetry/turns    → raw rows (for debug/inspect)
 *   GET  /api/sessions/:id/telemetry/attempts → physical upstream attempts
 */
export function mountTelemetryRoutes(app: HttpRouter, deps: ServerDeps): void {
  const { sessionStore, providerStore } = deps;

  app.get('/api/admin/telemetry/global', async (c) => {
    const limitRaw = c.req.query('limit');
    const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw))) : 50;
    const projectIdRaw = c.req.query('project_id');
    const project_id = projectIdRaw ? Number(projectIdRaw) : null;
    const since = c.req.query('since') ?? null;
    return c.json(
      await getFilesystemGlobalTelemetrySummary(sessionStore, {
        limit,
        project_id: Number.isFinite(project_id) ? project_id : null,
        since,
      }),
    );
  });

  // The path stays stable, but filesystem turn metrics are immutable. Report
  // current coverage instead of rewriting historical records in place.
  app.post('/api/admin/telemetry/backfill-costs', async (c) => {
    return c.json(await inspectFilesystemCostCoverage(sessionStore));
  });

  // Current contents of model_prices (all sources) + the in-memory list of
  // models seen this process with no resolvable price. Powers the admin
  // "Preços" tab.
  app.get('/api/admin/model-prices', (c) => {
    return c.json({
      prices: providerStore.listAllModelPrices(),
      missing: getRecentMissingPrices(),
      remoteSyncEnabled: isRemotePriceSyncEnabled(),
    });
  });

  // Manual price refresh — fetch OpenRouter + LiteLLM now, upsert into
  // model_prices, re-hydrate the in-memory cache, and return a per-source
  // summary so the UI can show exactly what happened.
  app.post('/api/admin/model-prices/sync', async (c) => {
    const openrouter = providerStore.listProviders().find((p) => p.kind === 'openrouter');
    const sources = getEnabledPriceSources({
      openrouterApiKey: openrouter?.api_key ?? undefined,
      openrouterBaseUrl: openrouter?.base_url ?? undefined,
    });
    return c.json(await refreshAllModelPrices(providerStore, sources));
  });

  app.get('/api/sessions/:id/telemetry', async (c) => {
    const id = parseSessionIdParam(c);
    const [summary, firstTurn, turns, attempts] = await Promise.all([
      getFilesystemSessionTelemetrySummary(sessionStore, id),
      getFilesystemFirstTurnPayload(sessionStore, id),
      listFilesystemTurnTelemetry(sessionStore, id),
      sessionStore.listProviderAttempts(id),
    ]);
    if (!summary) return c.json({ error: 'Session not found' }, 404);
    return c.json({
      ...summary,
      first_turn_payload: firstTurn,
      turns,
      attempts,
    });
  });

  app.get('/api/sessions/:id/telemetry/turns', async (c) => {
    const id = parseSessionIdParam(c);
    return c.json({
      turns: await listFilesystemTurnTelemetry(sessionStore, id),
    });
  });

  app.get('/api/sessions/:id/telemetry/attempts', async (c) => {
    const id = parseSessionIdParam(c);
    return c.json({ attempts: await sessionStore.listProviderAttempts(id) });
  });
}
