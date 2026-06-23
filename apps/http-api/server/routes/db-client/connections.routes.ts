import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { connectionInProject } from './_ownership.js';
import type { CreateDbConnectionInput, DbConnectionPatch } from '@mcp/store/db-client-store-types.js';

/**
 * CRUD for saved database connections (migration 174), project-scoped under
 * /api/projects/:projectId/db-client. `enc_*` secret fields arrive already
 * encrypted by the renderer's `secrets` shim — this layer never sees plaintext.
 */
export function mountDbConnectionRoutes(app: Hono, deps: ServerDeps): void {
  const base = '/api/projects/:projectId/db-client';

  app.get(`${base}/connections`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    return c.json({ connections: deps.dbClientFor(projectId).listConnections(projectId) });
  });

  app.get(`${base}/connections/:cid`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.dbClientFor(projectId);
    const cid = parseIdParam(c, 'cid');
    const conn = connectionInProject(store, projectId, cid);
    if (!conn) return notFound(c, `Connection ${cid} not found`);
    return c.json(conn);
  });

  app.post(`${base}/connections`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.dbClientFor(projectId);
    const body = await parseJsonBody<Omit<CreateDbConnectionInput, 'project_id'>>(c);
    if (!body.label?.trim() || !body.engine) {
      return c.json({ error: 'label and engine are required' }, 400);
    }
    if (body.ssh_tunnel_host_id != null) {
      // A tunnel host pointer must be validated by the SSH layer; here we only
      // ensure it's a number (the SSH route owns its own project guard).
      if (typeof body.ssh_tunnel_host_id !== 'number') {
        return c.json({ error: 'ssh_tunnel_host_id must be a number' }, 400);
      }
    }
    return c.json(
      store.createConnection({
        project_id: projectId,
        label: body.label.trim(),
        engine: body.engine,
        host: body.host ?? null,
        port: body.port ?? null,
        username: body.username ?? null,
        database_name: body.database_name ?? null,
        file_path: body.file_path ?? null,
        enc_password: body.enc_password ?? null,
        ssl_mode: body.ssl_mode ?? null,
        enc_ssl_ca: body.enc_ssl_ca ?? null,
        enc_ssl_cert: body.enc_ssl_cert ?? null,
        enc_ssl_key: body.enc_ssl_key ?? null,
        ssh_tunnel_host_id: body.ssh_tunnel_host_id ?? null,
        ssh_tunnel_json: body.ssh_tunnel_json ?? null,
        options: body.options,
        color: body.color ?? null,
        group_name: body.group_name ?? null,
        is_read_only: body.is_read_only,
      }),
    );
  });

  app.patch(`${base}/connections/:cid`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.dbClientFor(projectId);
    const cid = parseIdParam(c, 'cid');
    if (!connectionInProject(store, projectId, cid)) return notFound(c, `Connection ${cid} not found`);
    const patch = await parseJsonBody<DbConnectionPatch>(c);
    store.updateConnection(cid, patch);
    return c.json(store.getConnection(cid));
  });

  app.delete(`${base}/connections/:cid`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.dbClientFor(projectId);
    const cid = parseIdParam(c, 'cid');
    if (!connectionInProject(store, projectId, cid)) return notFound(c, `Connection ${cid} not found`);
    store.deleteConnection(cid);
    return c.json({ ok: true });
  });

  app.post(`${base}/connections/:cid/reorder`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.dbClientFor(projectId);
    const body = await parseJsonBody<{ orderedIds: number[] }>(c);
    const ids = Array.isArray(body.orderedIds) ? body.orderedIds : [];
    store.reorderConnections(projectId, ids);
    return c.json({ connections: store.listConnections(projectId) });
  });

  app.post(`${base}/connections/:cid/touch`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.dbClientFor(projectId);
    const cid = parseIdParam(c, 'cid');
    if (!connectionInProject(store, projectId, cid)) return notFound(c, `Connection ${cid} not found`);
    store.touchConnectionUsed(cid);
    return c.json({ ok: true });
  });
}
