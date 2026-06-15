import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import type { CreateRequestInput, RequestPatch } from '@mcp/store/api-client-types.js';

/**
 * CRUD for API-client collections + their requests (migration 147).
 * All routes are project-scoped under /api/projects/:projectId/api-client.
 */
export function mountApiCollectionRoutes(app: Hono, deps: ServerDeps): void {
  const store = deps.apiClientStore;
  const base = '/api/projects/:projectId/api-client';

  // ─── Collections ─────────────────────────────────────────────────────
  app.get(`${base}/collections`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    return c.json({ collections: store.listCollections(projectId) });
  });

  app.post(`${base}/collections`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const body = await parseJsonBody<{ name: string; description?: string }>(c);
    if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400);
    return c.json(store.createCollection({ project_id: projectId, name: body.name.trim(), description: body.description }));
  });

  app.patch(`${base}/collections/:cid`, async (c) => {
    const cid = parseIdParam(c, 'cid');
    if (!store.getCollection(cid)) return notFound(c, `Collection ${cid} not found`);
    const body = await parseJsonBody<{ name?: string; description?: string }>(c);
    store.updateCollection(cid, { name: body.name, description: body.description });
    return c.json(store.getCollection(cid));
  });

  app.delete(`${base}/collections/:cid`, (c) => {
    const cid = parseIdParam(c, 'cid');
    store.deleteCollection(cid);
    return c.json({ ok: true });
  });

  // ─── Requests ────────────────────────────────────────────────────────
  app.get(`${base}/collections/:cid/requests`, (c) => {
    const cid = parseIdParam(c, 'cid');
    return c.json({ requests: store.listRequests(cid) });
  });

  app.post(`${base}/collections/:cid/requests`, async (c) => {
    const cid = parseIdParam(c, 'cid');
    if (!store.getCollection(cid)) return notFound(c, `Collection ${cid} not found`);
    const body = await parseJsonBody<Partial<CreateRequestInput>>(c);
    if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400);
    return c.json(store.createRequest({
      collection_id: cid,
      name: body.name.trim(),
      method: body.method,
      path_template: body.path_template,
      headers_json: body.headers_json,
      query_json: body.query_json,
      body_json: body.body_json,
      body_kind: body.body_kind,
      sort_order: body.sort_order,
      source: body.source,
    }));
  });

  app.patch(`${base}/requests/:rid`, async (c) => {
    const rid = parseIdParam(c, 'rid');
    if (!store.getRequest(rid)) return notFound(c, `Request ${rid} not found`);
    const body = await parseJsonBody<RequestPatch>(c);
    store.updateRequest(rid, body);
    return c.json(store.getRequest(rid));
  });

  app.delete(`${base}/requests/:rid`, (c) => {
    const rid = parseIdParam(c, 'rid');
    store.deleteRequest(rid);
    return c.json({ ok: true });
  });

  // Mark a request verified: pins the expected status (+ optional shape/header
  // asserts) so the non-LLM regression runner can assert it. A falsy/absent
  // expectedStatus CLEARS verification (drops it from the battery).
  app.post(`${base}/requests/:rid/verify`, async (c) => {
    const rid = parseIdParam(c, 'rid');
    if (!store.getRequest(rid)) return notFound(c, `Request ${rid} not found`);
    const body = await parseJsonBody<{ expectedStatus: number; assert?: unknown }>(c);
    const expected = Number(body.expectedStatus);
    if (!Number.isFinite(expected) || expected <= 0) {
      store.unverifyRequest(rid);
    } else {
      store.markVerified(rid, expected, body.assert != null ? JSON.stringify(body.assert) : null);
    }
    return c.json(store.getRequest(rid));
  });
}
