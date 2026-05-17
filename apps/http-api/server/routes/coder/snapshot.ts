/**
 * Session-file snapshot routes (per-session "review diff" UI).
 *
 * Mounted at `/api/coder/sessions/:id/snapshot/*` — exposes the cumulative
 * diff between a session's pre-edit baselines and current on-disk content,
 * plus accept/revert primitives at hunk and file granularity.
 *
 * The handlers are thin: they construct a `SessionSnapshotService` over
 * the existing `SessionStore` DB handle and the project root, then forward
 * to it. No tab state lives in the dashboard — the service is the source
 * of truth.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { SessionFileSnapshotStore } from '@mcp/store/session-file-snapshot-store.js';
import { SessionSnapshotService } from '@mcp/services/services/session-snapshots.js';

export function mountCoderSnapshotRoutes(app: Hono, deps: ServerDeps): void {
  const { sessionStore, db } = deps;
  const snapshotStore = new SessionFileSnapshotStore(sessionStore.getDb());
  const service = new SessionSnapshotService(snapshotStore, (kind, sessionId) => {
    if (kind !== 'coder') return null;
    const s = sessionStore.getSession(sessionId);
    if (!s) return null;
    const p = db.getProject(s.project_id);
    return p?.root_path ?? null;
  });

  app.get('/api/coder/sessions/:id/snapshot', async (c) => {
    const id = parseIdParam(c);
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
    const includeClosed = c.req.query('includeClosed') === '1';
    const files = await service.listFiles('coder', id, { includeClosed });
    return c.json({ files });
  });

  app.get('/api/coder/sessions/:id/snapshot/file/:baselineId/diff', async (c) => {
    const baselineId = parseIdParam(c, 'baselineId');
    if (!Number.isFinite(baselineId)) return c.json({ error: 'bad baselineId' }, 400);
    const diff = await service.getDiff(baselineId);
    if (!diff) return notFound(c, 'baseline not found');
    return c.json(diff);
  });

  app.post('/api/coder/sessions/:id/snapshot/file/:baselineId/accept-hunk', async (c) => {
    const baselineId = parseIdParam(c, 'baselineId');
    const body = await parseJsonBody<{ fingerprint: string }>(c);
    if (!body.fingerprint) return c.json({ error: 'fingerprint required' }, 400);
    const r = await service.acceptHunk(baselineId, body.fingerprint);
    return c.json(r);
  });

  app.post('/api/coder/sessions/:id/snapshot/file/:baselineId/revert-hunk', async (c) => {
    const baselineId = parseIdParam(c, 'baselineId');
    const body = await parseJsonBody<{ fingerprint: string }>(c);
    if (!body.fingerprint) return c.json({ error: 'fingerprint required' }, 400);
    const r = await service.revertHunk(baselineId, body.fingerprint);
    return c.json(r);
  });

  app.post('/api/coder/sessions/:id/snapshot/file/:baselineId/accept', async (c) => {
    const baselineId = parseIdParam(c, 'baselineId');
    const r = await service.acceptFile(baselineId);
    return c.json(r);
  });

  app.post('/api/coder/sessions/:id/snapshot/file/:baselineId/revert', async (c) => {
    const baselineId = parseIdParam(c, 'baselineId');
    const r = await service.revertFile(baselineId);
    return c.json(r);
  });

  app.post('/api/coder/sessions/:id/snapshot/accept-all', async (c) => {
    const id = parseIdParam(c);
    const r = await service.acceptAll('coder', id);
    return c.json(r);
  });

  app.post('/api/coder/sessions/:id/snapshot/revert-all', async (c) => {
    const id = parseIdParam(c);
    const body = await parseJsonBody<{ confirm: boolean }>(c);
    if (!body.confirm) return c.json({ error: 'confirm required' }, 400);
    const r = await service.revertAll('coder', id);
    return c.json(r);
  });
}
