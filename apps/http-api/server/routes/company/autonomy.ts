/**
 * C1 — organism visibility, initial REST snapshot.
 *
 * GET /api/company/sessions/:id/autonomy returns everything the dashboard's
 * AutonomyPanel needs on mount, before (and independent of) the SSE stream:
 *
 *   - `config`    — the EFFECTIVE autonomy config (`resolveAutonomy` over the
 *                   session's `config_json` + process env), same precedence
 *                   the worker-side provider applies. No secrets: the shape
 *                   is booleans / role names / numeric caps only.
 *   - `incidents` — last N persisted supervisor incidents for THIS session
 *                   (migration 107 `agent_supervision_incidents`), read via
 *                   the shared DB handle so it works whether or not the
 *                   session's worker is alive.
 *   - `autoPosts` — last N durable board entries authored by the autonomy
 *                   machinery (content starting with `[AUTO]` or
 *                   `[auto-approved]`).
 *
 * Live updates ride the session metaBus (`scheduler_*`, `plan_auto_approved`,
 * `supervisor_incident`, `master_nudge`) — this endpoint is only the seed.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam } from '../_helpers.js';
import { resolveAutonomy } from '@mcp/company/services/autonomy/autonomy-config.js';
import {
  SqliteSupervisionPersistence,
  type IncidentQueryRow,
} from '@mcp/company/services/supervisor/index.js';

const INCIDENT_LIMIT = 20;
const AUTO_POST_LIMIT = 20;
/** Board rows scanned (newest-first window) when filtering for auto posts. */
const BOARD_SCAN_LIMIT = 200;

const AUTO_POST_PREFIXES = ['[AUTO]', '[auto-approved]'] as const;

export function mountCompanyAutonomyRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore } = deps;

  // Lazy singleton over the SHARED sqlite handle (same pattern as the admin
  // supervisor routes' IncidentReader, but without opening a second file
  // handle). Failures degrade to an empty list — the panel still renders
  // config + posts.
  let incidentStore: SqliteSupervisionPersistence | null = null;
  const listIncidents = (sessionId: number, limit: number): IncidentQueryRow[] => {
    try {
      incidentStore ??= new SqliteSupervisionPersistence(deps.db.raw());
      return incidentStore.listRecentIncidents(sessionId, limit);
    } catch {
      return [];
    }
  };

  app.get('/api/company/sessions/:id/autonomy', (c) => {
    const id = parseIdParam(c);
    const session = Number.isFinite(id) ? companyStore.getCompanySession(id) : null;
    if (!session) return c.json({ error: 'session not found' }, 404);

    const config = resolveAutonomy(session.config_json, process.env);
    const incidents = listIncidents(id, INCIDENT_LIMIT);

    let autoPosts: unknown[] = [];
    try {
      // `readBoard` without sinceId returns the LATEST N rows in ASC order,
      // so filtering + tail-slicing keeps chronological order.
      autoPosts = companyStore
        .readBoard(id, { limit: BOARD_SCAN_LIMIT })
        .filter(
          (entry) =>
            typeof entry.content === 'string' &&
            AUTO_POST_PREFIXES.some((p) => entry.content.startsWith(p)),
        )
        .slice(-AUTO_POST_LIMIT);
    } catch {
      autoPosts = [];
    }

    return c.json({ config, incidents, autoPosts });
  });
}
