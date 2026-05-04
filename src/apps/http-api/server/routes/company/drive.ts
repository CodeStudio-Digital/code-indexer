import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { activeOrchestrators } from './stream.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { CompanyDriveStore } from '../../../../../core/coder/company/services/CompanyDriveStore.js';

/**
 * HTTP routes for the company shared drive.
 *
 * The drive is just a metadata table + file pool, so reads and writes
 * never need a live orchestrator: when the session is running we reuse
 * the orchestrator's `driveStore` (so any future in-memory caches stay
 * coherent), otherwise we instantiate a fresh `CompanyDriveStore` from
 * the same DB + companyStore deps. Either way the storage is identical.
 *
 * Manual operator workflow: the dashboard's "Drive" tab uses POST
 * /upload to attach documents the user wants the agents to see, GET
 * /file?path=… to inspect contents, and DELETE to remove stale files.
 */
function getDriveStore(deps: ServerDeps, sessionId: number): CompanyDriveStore {
  const orchestrator = activeOrchestrators.get(sessionId);
  if (orchestrator) return orchestrator.driveStore;
  return new CompanyDriveStore({
    db: deps.db,
    companyStore: deps.companyStore,
    companySessionId: sessionId,
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
