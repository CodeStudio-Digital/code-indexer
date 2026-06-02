import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { CompanyDriveStore } from '@mcp/company/services/CompanyDriveStore.js';
import type { IMetaBusPublisher } from '@mcp/company/services/ports.js';
import { getWorkerOrchestratorPool } from '../../../sse/workerPoolSingleton.js';
import { publish as busPublish } from '../../../coder-bus.js';

/**
 * HTTP routes for the company shared drive.
 *
 * The drive is just a metadata table (`company_drive_files`) + an on-disk
 * file pool — fully coherent across processes via SQLite (WAL) + the
 * filesystem. So we ALWAYS operate it through a fresh in-process
 * `CompanyDriveStore`.
 *
 * Critically, we must NOT reuse the live orchestrator's `driveStore`: the
 * orchestrator now runs in a worker thread and `getCompanyOrchestrator`
 * returns a `WorkerBackedOrchestrator` RPC proxy whose every method call
 * returns a *Promise* (see WorkerOrchestratorPool's proxy). Calling
 * `orchestrator.driveStore.list()` synchronously yielded a Promise that
 * Hono serialized as `{}`, so the dashboard saw `files: {}` and threw
 * "Unexpected drive response shape" for any running session.
 *
 * When the session IS live we still want dashboard-initiated mutations to
 * broadcast over SSE, so we attach a publisher bound to the session's
 * main-side mirrored bus (same bus the SSE routes pump from).
 *
 * Manual operator workflow: the dashboard's "Drive" tab uses POST
 * /upload to attach documents the user wants the agents to see, GET
 * /file?path=… to inspect contents, and DELETE to remove stale files.
 */
function getDriveStore(deps: ServerDeps, sessionId: number): CompanyDriveStore {
  const entry = getWorkerOrchestratorPool().get(sessionId);
  const publisher: IMetaBusPublisher | undefined = entry
    ? {
        bus: entry.bus,
        publish: (event, data) => {
          busPublish(entry.bus, event, data);
        },
        markEnded: () => {
          /* drive mutations never end the session bus */
        },
      }
    : undefined;
  return new CompanyDriveStore({
    db: deps.db,
    companyStore: deps.companyStore,
    companySessionId: sessionId,
    publisher,
  });
}

export function mountCompanyDriveRoutes(app: Hono, deps: ServerDeps): void {
  app.get('/api/company/sessions/:id/drive', (c) => {
    const sessionId = parseIdParam(c);
    const prefix = c.req.query('prefix') ?? undefined;
    const ownerRole = c.req.query('owner_role') ?? undefined;
    try {
      const drive = getDriveStore(deps, sessionId);
      const scopeKey = drive.resolveScopeKey();
      const files = drive.list(scopeKey, { prefix, ownerRole });
      return c.json({ scope: scopeKey, files });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.get('/api/company/sessions/:id/drive/file', (c) => {
    const sessionId = parseIdParam(c);
    const path = c.req.query('path');
    if (!path) return c.json({ error: 'path query parameter is required' }, 400);
    const offsetRaw = c.req.query('offset');
    const maxBytesRaw = c.req.query('max_bytes');
    try {
      const drive = getDriveStore(deps, sessionId);
      const scopeKey = drive.resolveScopeKey();
      const result = drive.read(scopeKey, path, {
        offset: offsetRaw != null ? Number(offsetRaw) : undefined,
        maxBytes: maxBytesRaw != null ? Number(maxBytesRaw) : undefined,
      });
      return c.json(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('not found')) return notFound(c, msg);
      return c.json({ error: msg }, 400);
    }
  });

  app.post('/api/company/sessions/:id/drive', async (c) => {
    const sessionId = parseIdParam(c);
    const body = await parseJsonBody<{ path: string; content: string; mode?: 'write' | 'append' }>(c);
    if (!body.path) return c.json({ error: 'path is required' }, 400);
    if (typeof body.content !== 'string') return c.json({ error: 'content (string) is required' }, 400);
    const mode = body.mode === 'append' ? 'append' : 'write';
    try {
      const drive = getDriveStore(deps, sessionId);
      const scopeKey = drive.resolveScopeKey();
      const owner = { role: 'human', agentRunId: null };
      const meta = mode === 'append'
        ? drive.append(scopeKey, body.path, body.content, owner)
        : drive.write(scopeKey, body.path, body.content, owner);
      return c.json({ ok: true, meta });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.delete('/api/company/sessions/:id/drive', (c) => {
    const sessionId = parseIdParam(c);
    const path = c.req.query('path');
    if (!path) return c.json({ error: 'path query parameter is required' }, 400);
    try {
      const drive = getDriveStore(deps, sessionId);
      const scopeKey = drive.resolveScopeKey();
      const deleted = drive.delete(scopeKey, path);
      if (!deleted) return notFound(c, `Path not found: ${path}`);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });
}
