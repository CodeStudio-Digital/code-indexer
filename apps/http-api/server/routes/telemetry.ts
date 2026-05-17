import type { Hono } from 'hono';
import type { ServerDeps } from '../deps.js';
import { parseIdParam } from './_helpers.js';

/**
 * Telemetry routes — surface the per-turn data captured by migration 069
 * (coder_turn_telemetry) so the dashboard can show "where are tokens being
 * spent" without forcing the user to run SQL by hand.
 *
 *   GET /api/admin/telemetry/global       → admin dashboard payload
 *   GET /api/sessions/:id/telemetry       → per-session summary (modal)
 *   GET /api/sessions/:id/telemetry/turns → raw rows (for debug/inspect)
 */
export function mountTelemetryRoutes(app: Hono, deps: ServerDeps): void {
  const { sessionStore } = deps;

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
