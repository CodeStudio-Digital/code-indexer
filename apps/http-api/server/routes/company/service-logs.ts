/**
 * Structured service-log + transition history routes (company B4).
 *
 * Read-only projections of the mig-188 tables. The WRITE path lives in
 * the company worker (ServiceSupervisor tick → CompanyServiceLogsStore /
 * CompanyServiceTransitionsStore); these routes run on MAIN and read the
 * same SQLite file through the stores already carried on `ServerDeps` —
 * WAL keeps the cross-process read safe.
 *
 * Live tail is NOT served here: the dashboard gets it via the
 * `sandbox.service.log_batch` SSE event. These endpoints back the
 * "load earlier" pagination and the transitions timeline.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, notFound } from '../_helpers.js';

const LOG_STREAMS = new Set(['devserver', 'container', 'scaffold']);

function parseCursor(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export function mountCompanyServiceLogsRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore } = deps;

  // Registered BEFORE any `/services/:serviceId` sibling patterns would
  // matter, but note there is no bare GET `/services/:serviceId` route —
  // `transitions` cannot be shadowed.
  app.get('/api/company/sessions/:id/services/transitions', (c) => {
    const id = parseIdParam(c);
    if (!companyStore.getCompanySession(id)) return notFound(c);
    const rows = deps.companyServiceTransitionsStore.listPage(id, {
      serviceId: c.req.query('service_id') || undefined,
      beforeId: parseCursor(c.req.query('before_id')),
      limit: parseCursor(c.req.query('limit')),
    });
    return c.json({
      transitions: rows.map((r) => ({
        id: r.id,
        service_id: r.serviceId,
        kind: r.kind,
        from_state: r.fromState,
        to_state: r.toState,
        reason: r.reason,
        actor: r.actor,
        at_ms: r.atMs,
      })),
    });
  });

  // Paged history of the structured log ring buffer. Newest-first
  // (id DESC) with keyset pagination: pass the smallest `id` of the
  // previous page as `before_id` to walk backwards.
  app.get('/api/company/sessions/:id/services/:serviceId/logs/history', (c) => {
    const id = parseIdParam(c);
    if (!companyStore.getCompanySession(id)) return notFound(c);
    const serviceId = c.req.param('serviceId');
    if (!serviceId) return c.json({ error: 'serviceId required' }, 400);
    const streamRaw = c.req.query('stream') || undefined;
    if (streamRaw !== undefined && !LOG_STREAMS.has(streamRaw)) {
      return c.json({ error: `stream must be one of: ${[...LOG_STREAMS].join(', ')}` }, 400);
    }
    const rows = deps.companyServiceLogsStore.listPage(id, {
      serviceId,
      stream: streamRaw as 'devserver' | 'container' | 'scaffold' | undefined,
      beforeId: parseCursor(c.req.query('before_id')),
      limit: parseCursor(c.req.query('limit')),
      q: c.req.query('q') || undefined,
    });
    return c.json({
      lines: rows.map((r) => ({
        id: r.id,
        service_id: r.serviceId,
        stream: r.stream,
        line: r.line,
        at_ms: r.atMs,
      })),
    });
  });
}
