import { HttpRouter } from '@mcp/shared/http/router.js';
import { SqliteAuditLogRepo } from '@mcp/store/auth/sqlite-audit-log-repo.js';
import type { AuditEventKind } from '@mcp/services/auth/domain/audit-event.js';
import type { IndexerConfig } from '@mcp/shared/utils/config.js';

/**
 * Read-only window into the auth audit log.
 * Query params: since, until, principal, event, limit.
 */
export function createAuditLogRouter(config: IndexerConfig): HttpRouter {
  const app = new HttpRouter();
  const repo = new SqliteAuditLogRepo(config.dbPath);

  app.get('/audit-log', (c) => {
    const q = c.req.query();
    const events = repo.query({
      since: numOr(q.since, undefined),
      until: numOr(q.until, undefined),
      principal: q.principal || undefined,
      event: (q.event as AuditEventKind | undefined) || undefined,
      limit: numOr(q.limit, 500),
    });
    return c.json({ events });
  });

  return app;
}

function numOr(raw: string | undefined, fallback: number | undefined): number | undefined {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
