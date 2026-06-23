import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseIntQuery, parseJsonBody } from '../_helpers.js';
import { connectionInProject } from './_ownership.js';
import type { CreateDbQueryHistoryInput } from '@mcp/store/db-client-store-types.js';

/**
 * Query-history CRUD (migration 174), project-scoped. The renderer writes a row
 * after each run (keeps the live-plane handlers free of the metadata store).
 */
export function mountDbHistoryRoutes(app: Hono, deps: ServerDeps): void {
  const base = '/api/projects/:projectId/db-client';

  app.get(`${base}/connections/:cid/history`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.dbClientFor(projectId);
    const cid = parseIdParam(c, 'cid');
    if (!connectionInProject(store, projectId, cid)) return c.json({ history: [] });
    const limit = parseIntQuery(c, 'limit', 100);
    return c.json({ history: store.listHistory(cid, limit) });
  });

  app.post(`${base}/connections/:cid/history`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.dbClientFor(projectId);
    const cid = parseIdParam(c, 'cid');
    if (!connectionInProject(store, projectId, cid)) return c.json({ error: 'connection not found' }, 404);
    const body = await parseJsonBody<Omit<CreateDbQueryHistoryInput, 'project_id' | 'connection_id'>>(c);
    if (!body.sql?.trim()) return c.json({ error: 'sql is required' }, 400);
    return c.json(
      store.addHistory({
        project_id: projectId,
        connection_id: cid,
        sql: body.sql,
        database_name: body.database_name ?? null,
        duration_ms: body.duration_ms ?? null,
        row_count: body.row_count ?? null,
        status: body.status ?? 'ok',
        error_message: body.error_message ?? null,
      }),
    );
  });

  app.delete(`${base}/connections/:cid/history`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.dbClientFor(projectId);
    const cid = parseIdParam(c, 'cid');
    if (!connectionInProject(store, projectId, cid)) return c.json({ error: 'connection not found' }, 404);
    store.clearHistory(cid);
    return c.json({ ok: true });
  });

  app.delete(`${base}/history/:hid`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.dbClientFor(projectId);
    const hid = parseIdParam(c, 'hid');
    const row = store.getHistoryRow(hid);
    if (!row || row.project_id !== projectId) return c.json({ error: 'not found' }, 404);
    store.deleteHistoryRow(hid);
    return c.json({ ok: true });
  });
}
