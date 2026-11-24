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
 *   - `incidents` — last N filesystem-persisted supervisor incidents for
 *                   THIS Company root, available whether or not its worker
 *                   is alive.
 *   - `autoPosts` — last N durable board entries authored by the autonomy
 *                   machinery (content starting with `[AUTO]` or
 *                   `[auto-approved]`).
 *
 * Live updates ride the session metaBus (`scheduler_*`, `plan_auto_approved`,
 * `supervisor_incident`, `master_nudge`) — this endpoint is only the seed.
 */
import type { HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../../deps.js';
import {
  parseCompanySessionIdParam,
  resolveCompanySessionContext,
} from '../_helpers.js';
import { resolveAutonomy } from '@mcp/company/services/autonomy/autonomy-config.js';
import {
  FileSupervisionPersistence,
} from '@mcp/company/services/supervisor/index.js';

const INCIDENT_LIMIT = 20;
const AUTO_POST_LIMIT = 20;
/** Board rows scanned (newest-first window) when filtering for auto posts. */
const BOARD_SCAN_LIMIT = 200;

const AUTO_POST_PREFIXES = ['[AUTO]', '[auto-approved]'] as const;

export function mountCompanyAutonomyRoutes(app: HttpRouter, deps: ServerDeps): void {
  app.get('/api/company/sessions/:id/autonomy', async (c) => {
    const id = parseCompanySessionIdParam(c);
    const context = await resolveCompanySessionContext(deps.sessionStore, id);
    if (!context) return c.json({ error: 'session not found' }, 404);

    const config = resolveAutonomy(context.requested.config_json, process.env);
    let incidents: unknown[] = [];
    try {
      const incidentStore = new FileSupervisionPersistence({
        companySessionId: id,
        sessionRoot: context.requestedFiles.location.bundle_path,
      });
      incidents = incidentStore.listRecentIncidents(id, INCIDENT_LIMIT);
    } catch {
      incidents = [];
    }

    let autoPosts: unknown[] = [];
    try {
      // The filesystem projection returns the LATEST N rows in ASC order,
      // so filtering + tail-slicing keeps chronological order.
      autoPosts = context.requestedFiles
        .listBoardEntriesSync({ limit: BOARD_SCAN_LIMIT })
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
