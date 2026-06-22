import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { collectionInProject } from './_ownership.js';
import { parseCurl, type CurlBody } from '@mcp/services/api-client/import-curl/index.js';
import { exportPostman, type ExportRequest } from '@mcp/services/api-client/codegen/export-postman.js';
import { exportOpenApi } from '@mcp/services/api-client/codegen/export-openapi.js';
import type { CreateRequestInput } from '@mcp/store/api-client-types.js';

/**
 * Import a request from a curl/bash command, and export a collection to Postman
 * v2.1 / OpenAPI 3.1 JSON. OpenAPI *spec* import stays in regression.routes.ts.
 */
export function mountApiImportRoutes(app: Hono, deps: ServerDeps): void {
  // R1 — `store` is resolved per-request via deps.apiClientFor(projectId).
  const base = '/api/projects/:projectId/api-client';

  app.post(`${base}/collections/:cid/import-curl`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const cid = parseIdParam(c, 'cid');
    if (!collectionInProject(store, projectId, cid)) return notFound(c, `Collection ${cid} not found`);
    const body = await parseJsonBody<{ text?: string }>(c);
    let parsed;
    try { parsed = parseCurl(String(body.text ?? '')); }
    catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 400); }

    const input: CreateRequestInput = {
      collection_id: cid,
      name: parsed.name,
      method: parsed.method,
      path_template: parsed.path_template,
      headers_json: JSON.stringify(parsed.headers.map((h) => ({ key: h.key, value: h.value, enabled: true }))),
      query_json: JSON.stringify(parsed.query.map((q) => ({ key: q.key, value: q.value, enabled: true }))),
      source: 'manual',
      ...mapBody(parsed.body),
      ...(parsed.auth ? { auth_type: 'basic', auth_json: JSON.stringify({ username: parsed.auth.username, password: parsed.auth.password }) } : {}),
    };
    return c.json({ request: store.createRequest(input) });
  });

  app.get(`${base}/collections/:cid/export`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const cid = parseIdParam(c, 'cid');
    // A stale cid must not export another project's full request set.
    const col = collectionInProject(store, projectId, cid);
    if (!col) return notFound(c, `Collection ${cid} not found`);
    const requests = store.listRequests(cid) as unknown as ExportRequest[];
    const format = c.req.query('format') === 'openapi' ? 'openapi' : 'postman';
    const doc = format === 'openapi' ? exportOpenApi(col.name, requests) : exportPostman(col.name, requests);
    return c.json(doc);
  });
}

function mapBody(body: CurlBody): Partial<CreateRequestInput> {
  switch (body.kind) {
    case 'json': return { body_kind: 'json', body_json: body.content };
    case 'raw': return { body_kind: 'raw', body_json: body.content, body_raw_lang: rawLang(body.contentType) };
    case 'urlencoded':
      return { body_kind: 'urlencoded', body_urlencoded_json: JSON.stringify(body.fields.map((f) => ({ key: f.name, value: f.value, enabled: true }))) };
    case 'form-data':
      return { body_kind: 'form-data', body_form_json: JSON.stringify(body.fields.map((f) => ({ key: f.name, value: f.value, enabled: true, src: f.filename }))) };
    default: return { body_kind: 'none' };
  }
}

function rawLang(ct?: string): 'xml' | 'html' | 'text' {
  if (!ct) return 'text';
  if (/xml/i.test(ct)) return 'xml';
  if (/html/i.test(ct)) return 'html';
  return 'text';
}
