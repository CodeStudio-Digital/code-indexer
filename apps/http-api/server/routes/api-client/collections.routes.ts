import type { HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { collectionInProject, requestInProject } from './_ownership.js';
import type { CreateRequestInput, RequestPatch } from '@mcp/store/api-client-types.js';

/**
 * CRUD for API-client collections + their requests (migration 147).
 * All routes are project-scoped under /api/projects/:projectId/api-client.
 */
export function mountApiCollectionRoutes(app: HttpRouter, deps: ServerDeps): void {
  // R1 — `store` is resolved per-request via deps.apiClientFor(projectId).
  const base = '/api/projects/:projectId/api-client';

  // ─── Collections ─────────────────────────────────────────────────────
  app.get(`${base}/collections`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    return c.json({ collections: store.listCollections(projectId) });
  });

  app.post(`${base}/collections`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const body = await parseJsonBody<{ name: string; description?: string }>(c);
    if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400);
    return c.json(store.createCollection({ project_id: projectId, name: body.name.trim(), description: body.description }));
  });

  app.patch(`${base}/collections/:cid`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const cid = parseIdParam(c, 'cid');
    if (!collectionInProject(store, projectId, cid)) return notFound(c, `Collection ${cid} not found`);
    const body = await parseJsonBody<{ name?: string; description?: string; overview_md?: string; branding_json?: string; folder_docs_json?: string }>(c);
    store.updateCollection(cid, {
      name: body.name, description: body.description,
      overview_md: body.overview_md, branding_json: body.branding_json, folder_docs_json: body.folder_docs_json,
    });
    return c.json(store.getCollection(cid));
  });

  app.delete(`${base}/collections/:cid`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const cid = parseIdParam(c, 'cid');
    // Guard BEFORE the cascade — deleteCollection also drops the collection's
    // requests + regression runs, so a stale cid must never reach it.
    if (!collectionInProject(store, projectId, cid)) return notFound(c, `Collection ${cid} not found`);
    store.deleteCollection(cid);
    return c.json({ ok: true });
  });

  // ─── Folders (manual grouping) ───────────────────────────────────────
  app.post(`${base}/collections/:cid/folders`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const cid = parseIdParam(c, 'cid');
    if (!collectionInProject(store, projectId, cid)) return notFound(c, `Collection ${cid} not found`);
    const body = await parseJsonBody<{ name: string }>(c);
    if (!body.name?.trim()) return c.json({ error: 'folder name is required' }, 400);
    store.addFolder(cid, body.name.trim());
    return c.json(store.getCollection(cid));
  });

  app.patch(`${base}/collections/:cid/folders`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const cid = parseIdParam(c, 'cid');
    if (!collectionInProject(store, projectId, cid)) return notFound(c, `Collection ${cid} not found`);
    const body = await parseJsonBody<{ from: string; to: string }>(c);
    if (!body.from || !body.to?.trim()) return c.json({ error: 'from and to are required' }, 400);
    store.renameFolder(cid, body.from, body.to.trim());
    return c.json(store.getCollection(cid));
  });

  app.delete(`${base}/collections/:cid/folders/:name`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const cid = parseIdParam(c, 'cid');
    if (!collectionInProject(store, projectId, cid)) return notFound(c, `Collection ${cid} not found`);
    store.deleteFolder(cid, decodeURIComponent(c.req.param('name')));
    return c.json(store.getCollection(cid));
  });

  // Effective folder list (explicit + used by requests) — for the Save modal.
  app.get(`${base}/collections/:cid/folders`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const cid = parseIdParam(c, 'cid');
    if (!collectionInProject(store, projectId, cid)) return c.json({ folders: [] });
    return c.json({ folders: store.listFolders(cid) });
  });

  // ─── Requests ────────────────────────────────────────────────────────
  app.get(`${base}/collections/:cid/requests`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const cid = parseIdParam(c, 'cid');
    if (!collectionInProject(store, projectId, cid)) return notFound(c, `Collection ${cid} not found`);
    return c.json({ requests: store.listRequests(cid) });
  });

  app.post(`${base}/collections/:cid/requests`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const cid = parseIdParam(c, 'cid');
    if (!collectionInProject(store, projectId, cid)) return notFound(c, `Collection ${cid} not found`);
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
      body_raw_lang: body.body_raw_lang,
      body_form_json: body.body_form_json,
      body_urlencoded_json: body.body_urlencoded_json,
      body_graphql_json: body.body_graphql_json,
      body_binary_path: body.body_binary_path,
      pre_request_script: body.pre_request_script,
      test_script: body.test_script,
      auth_type: body.auth_type,
      auth_json: body.auth_json,
      folder: body.folder,
      sort_order: body.sort_order,
      source: body.source,
    }));
  });

  app.patch(`${base}/requests/:rid`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const rid = parseIdParam(c, 'rid');
    if (!requestInProject(store, projectId, rid)) return notFound(c, `Request ${rid} not found`);
    const body = await parseJsonBody<RequestPatch>(c);
    store.updateRequest(rid, body);
    return c.json(store.getRequest(rid));
  });

  app.delete(`${base}/requests/:rid`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const rid = parseIdParam(c, 'rid');
    // Guard BEFORE delete — it cascades the request's history.
    if (!requestInProject(store, projectId, rid)) return notFound(c, `Request ${rid} not found`);
    store.deleteRequest(rid);
    return c.json({ ok: true });
  });

  app.post(`${base}/requests/:rid/duplicate`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const rid = parseIdParam(c, 'rid');
    if (!requestInProject(store, projectId, rid)) return notFound(c, `Request ${rid} not found`);
    const dup = store.duplicateRequest(rid);
    if (!dup) return notFound(c, `Request ${rid} not found`);
    return c.json(dup);
  });

  // Persist a drag-reorder: orderedIds is the target folder's full ordered list.
  app.post(`${base}/collections/:cid/reorder`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const cid = parseIdParam(c, 'cid');
    if (!collectionInProject(store, projectId, cid)) return notFound(c, `Collection ${cid} not found`);
    const body = await parseJsonBody<{ orderedIds?: number[]; folder?: string | null }>(c);
    const ids = Array.isArray(body.orderedIds) ? body.orderedIds.filter((n) => Number.isFinite(n)) : [];
    store.reorderRequests(cid, ids, body.folder ?? null);
    return c.json({ ok: true });
  });

  // Mark a request verified: pins the expected status (+ optional shape/header
  // asserts) so the non-LLM regression runner can assert it. A falsy/absent
  // expectedStatus CLEARS verification (drops it from the battery).
  app.post(`${base}/requests/:rid/verify`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const rid = parseIdParam(c, 'rid');
    if (!requestInProject(store, projectId, rid)) return notFound(c, `Request ${rid} not found`);
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
