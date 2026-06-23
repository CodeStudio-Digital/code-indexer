import type { Hono } from 'hono';
import type { ServerDeps } from '../deps.js';
import { parseIdParam } from './_helpers.js';
import { getRecentMissingPrices } from '@mcp/code-agent/providers/pricing-cache.js';
import { refreshAllModelPrices } from '@mcp/indexer/indexer/providers/scheduled-pricing-refresh.js';
import { getEnabledPriceSources } from '@mcp/services/services/pricing/index.js';

/**
 * Telemetry routes — surface the per-turn data captured by migration 069
 * (coder_turn_telemetry) so the dashboard can show "where are tokens being
 * spent" without forcing the user to run SQL by hand.
 *
 *   GET  /api/admin/telemetry/global         → admin dashboard payload
 *   POST /api/admin/telemetry/backfill-costs  → re-price historical turns
 *   GET  /api/admin/model-prices             → model_prices rows + no-price models
 *   POST /api/admin/model-prices/sync        → manual price refresh (OpenRouter + LiteLLM)
 *   GET  /api/sessions/:id/telemetry          → per-session summary (modal)
 *   GET  /api/sessions/:id/telemetry/turns    → raw rows (for debug/inspect)
 */
export function mountTelemetryRoutes(app: Hono, deps: ServerDeps): void {
  const { sessionStore, providerStore } = deps;

  app.get('/api/admin/telemetry/global', (c) => {
    const limitRaw = c.req.query('limit');
    const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw))) : 50;
    const projectIdRaw = c.req.query('project_id');
    const project_id = projectIdRaw ? Number(projectIdRaw) : null;
    // ISO 8601 string accepted directly — SQL compares lexicographically
    // against `created_at`'s 'YYYY-MM-DD HH:MM:SS' format. Pass-through
    // makes "since=2026-05-01" or "since=2026-05-01 12:00:00" both work.
    const since = c.req.query('since') ?? null;
    return c.json(
      sessionStore.getGlobalTelemetrySummary({
        limit,
        project_id: Number.isFinite(project_id) ? project_id : null,
        since,
      }),
    );
  });

  // Recompute estimated_cost_usd for historical rows using the current price
  // cache. POST {dryRun?, onlyNullCost?, batchSize?}. Idempotent.
  app.post('/api/admin/telemetry/backfill-costs', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      dryRun?: boolean;
      onlyNullCost?: boolean;
      batchSize?: number;
    };
    return c.json(
      sessionStore.backfillTurnCosts({
        dryRun: body.dryRun === true,
        onlyNullCost: body.onlyNullCost === true,
        batchSize: typeof body.batchSize === 'number' ? body.batchSize : undefined,
      }),
    );
  });

  // Current contents of model_prices (all sources) + the in-memory list of
  // models seen this process with no resolvable price. Powers the admin
  // "Preços" tab.
  app.get('/api/admin/model-prices', (c) => {
    return c.json({
      prices: providerStore.listAllModelPrices(),
      missing: getRecentMissingPrices(),
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

  app.get('/api/sessions/:id/telemetry', (c) => {
    const id = parseIdParam(c);
    return c.json({
      ...sessionStore.getSessionTelemetrySummary(id),
      first_turn_payload: sessionStore.getFirstTurnPayloadBreakdown(id),
      turns: sessionStore.getTurnTelemetry(id),
    });
  });

  app.get('/api/sessions/:id/telemetry/turns', (c) => {
    const id = parseIdParam(c);
    return c.json({ turns: sessionStore.getTurnTelemetry(id) });
  });
}
