import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { collectionInProject } from './_ownership.js';
import { parseCurl, type CurlBody } from '@mcp/services/api-client/import-curl/index.js';
import { exportPostman, type ExportRequest } from '@mcp/services/api-client/codegen/export-postman.js';
import { exportOpenApi, pathOf, type ExportOpenApiExtras, type OpenApiResponseExample } from '@mcp/services/api-client/codegen/export-openapi.js';
import type { ApiClientStore } from '@mcp/store/api-client-store.js';
import type { ApiCollection, CreateRequestInput } from '@mcp/store/api-client-types.js';

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
    const rows = store.listRequests(cid);
    const requests = rows as unknown as ExportRequest[];
    if (c.req.query('format') !== 'openapi') return c.json(exportPostman(col.name, requests));
    // OpenAPI carries the authored Docs Studio content (overview/guides/folder
    // docs/branding links/examples) so the published page is more than a bare spec.
    return c.json(exportOpenApi(col.name, requests, buildDocExtras(store, col, rows)));
  });
}

/** Gather the authored, collection-level documentation for the OpenAPI export. */
function buildDocExtras(store: ApiClientStore, col: ApiCollection, rows: { id: number; method: string; path_template: string }[]): ExportOpenApiExtras {
  const examplesByKey: Record<string, OpenApiResponseExample[]> = {};
  for (const r of rows) {
    const exs = store.listExamples(r.id);
    if (!exs.length) continue;
    const key = `${(r.method || 'GET').toUpperCase()} ${pathOf(r.path_template)}`;
    (examplesByKey[key] ??= []).push(...exs.map((e) => ({
      name: e.name, status: e.resp_status, statusText: e.resp_status_text, contentType: e.resp_content_type, body: e.resp_body,
    })));
  }
  return {
    description: col.description,
    overview: col.overview_md,
    guides: store.listDocPages(col.id).map((p) => ({ title: p.title, body: p.body_md })),
    folderDocs: parseStringRecord(col.folder_docs_json),
    links: parseBrandingLinks(col.branding_json),
    examplesByKey,
  };
}

function parseStringRecord(json: string | null): Record<string, string> {
  if (!json) return {};
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch { return {}; }
}

function parseBrandingLinks(json: string | null): { label: string; url: string }[] {
  if (!json) return [];
  try {
    const b = JSON.parse(json) as { links?: { label?: string; url?: string }[] };
    return (b.links ?? []).filter((l): l is { label: string; url: string } => !!l && typeof l.url === 'string' && !!l.url)
      .map((l) => ({ label: l.label ?? l.url, url: l.url }));
  } catch { return []; }
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
