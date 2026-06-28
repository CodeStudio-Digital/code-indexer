import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { savedQueryInProject, connectionInProject } from './_ownership.js';
import type { CreateDbSavedQueryInput, DbSavedQueryPatch } from '@mcp/store/db-client-store-types.js';

/**
 * CRUD for named, reusable queries (migration 174), project-scoped.
 */
export function mountDbSavedQueryRoutes(app: Hono, deps: ServerDeps): void {
  const base = '/api/projects/:projectId/db-client';

  app.get(`${base}/saved-queries`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    return c.json({ savedQueries: deps.dbClientFor(projectId).listSavedQueries(projectId) });
  });

  app.post(`${base}/saved-queries`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.dbClientFor(projectId);
    const body = await parseJsonBody<Omit<CreateDbSavedQueryInput, 'project_id'>>(c);
    if (!body.name?.trim() || !body.sql?.trim()) {
      return c.json({ error: 'name and sql are required' }, 400);
    }
    // A connection pointer must belong to this project (no cross-project ref).
    if (body.connection_id != null && !connectionInProject(store, projectId, body.connection_id)) {
      return c.json({ error: 'connection_id not found in project' }, 400);
    }
    return c.json(
      store.createSavedQuery({
        project_id: projectId,
        connection_id: body.connection_id ?? null,
        name: body.name.trim(),
        sql: body.sql,
        description: body.description ?? null,
      }),
    );
  });

  app.patch(`${base}/saved-queries/:sqid`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.dbClientFor(projectId);
    const sqid = parseIdParam(c, 'sqid');
    if (!savedQueryInProject(store, projectId, sqid)) return notFound(c, `Saved query ${sqid} not found`);
    const patch = await parseJsonBody<DbSavedQueryPatch>(c);
    if (patch.connection_id != null && !connectionInProject(store, projectId, patch.connection_id)) {
      return c.json({ error: 'connection_id not found in project' }, 400);
    }
    store.updateSavedQuery(sqid, patch);
    return c.json(store.getSavedQuery(sqid));
  });

  app.delete(`${base}/saved-queries/:sqid`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.dbClientFor(projectId);
    const sqid = parseIdParam(c, 'sqid');
    if (!savedQueryInProject(store, projectId, sqid)) return notFound(c, `Saved query ${sqid} not found`);
    store.deleteSavedQuery(sqid);
    return c.json({ ok: true });
  });
}
