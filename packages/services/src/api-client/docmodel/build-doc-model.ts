/**
 * build-doc-model — PURE assembly of a DocModel from already-loaded store rows.
 * No I/O: the caller passes the collection, its requests, guide pages, and the
 * examples grouped by request id. Reuses exportOpenApi (reference pane) and the
 * codegen generators (per-endpoint multi-language samples). Examples must ALREADY
 * be redacted (the capture route redacts on write), so the result is safe to ship.
 */
import type { ApiCollection, ApiRequest, ApiDocPage, ApiRequestExample } from '@mcp/store/api-client-types.js';
import { exportOpenApi } from '../codegen/export-openapi.js';
import type { ExportRequest } from '../codegen/export-postman.js';
import { buildCodegenRequest, generate, languageFor, type CodegenTarget } from '../codegen/index.js';
import type { ExecRequest } from '../execute-request.js';
import type { DocBranding, DocEndpoint, DocExample, DocFolder, DocGuide, DocModel, DocParam, DocSample } from './types.js';

const DEFAULT_SAMPLE_TARGETS: CodegenTarget[] = ['curl-bash', 'js-fetch', 'python'];

export interface BuildDocModelInput {
  collection: ApiCollection;
  requests: ApiRequest[];
  docPages: ApiDocPage[];
  examplesByRequest: Map<number, ApiRequestExample[]>;
  sampleTargets?: CodegenTarget[];
}

export function buildDocModel(input: BuildDocModelInput): DocModel {
  const { collection, requests, docPages } = input;
  const targets = input.sampleTargets ?? DEFAULT_SAMPLE_TARGETS;
  const folderDocs = parseRecord(collection.folder_docs_json);

  const branding = parseBranding(collection.branding_json);
  const guides: DocGuide[] = docPages.map((p) => ({ slug: p.slug, title: p.title, body: p.body_md }));

  // Folder set = explicit list ∪ folders used by requests (sorted), each with its doc.
  const folderNames = new Set<string>();
  try { for (const f of (JSON.parse(collection.folders_json || '[]') as string[])) if (typeof f === 'string') folderNames.add(f); } catch { /* ignore */ }
  for (const r of requests) { const f = (r.folder ?? '').trim(); if (f) folderNames.add(f); }
  const folders: DocFolder[] = [...folderNames].sort((a, b) => a.localeCompare(b)).map((name) => ({ name, description: folderDocs[name] ?? '' }));

  const endpoints: DocEndpoint[] = requests.map((r) => buildEndpoint(r, input.examplesByRequest.get(r.id) ?? [], targets));

  return {
    schemaVersion: 1,
    meta: { title: collection.name, description: collection.description, updatedAt: collection.updated_at },
    branding,
    overview: collection.overview_md ?? '',
    guides,
    folders,
    endpoints,
    openapi: exportOpenApi(collection.name, requests as unknown as ExportRequest[]),
  };
}

function buildEndpoint(r: ApiRequest, examples: ApiRequestExample[], targets: CodegenTarget[]): DocEndpoint {
  const cg = buildCodegenRequest({ request: r as unknown as ExecRequest, baseUrl: '', variables: {}, resolve: false });
  const samples: DocSample[] = targets.map((t) => ({ target: t, language: languageFor(t), code: generate(t, cg) }));
  return {
    id: r.id,
    name: r.name,
    method: (r.method || 'GET').toUpperCase(),
    path: pathOf(r.path_template),
    folder: r.folder,
    description: r.description ?? '',
    paramDocs: parseParamDocs(r.param_docs_json),
    examples: examples.map(toDocExample),
    samples,
  };
}

function toDocExample(e: ApiRequestExample): DocExample {
  let req = { method: '', url: '' };
  try { const s = JSON.parse(e.req_snapshot_json) as { method?: string; url?: string }; req = { method: s.method ?? '', url: s.url ?? '' }; } catch { /* keep */ }
  let headers: Record<string, string> = {};
  try { if (e.resp_headers_json) headers = JSON.parse(e.resp_headers_json) as Record<string, string>; } catch { /* keep */ }
  return {
    name: e.name, req,
    status: e.resp_status, statusText: e.resp_status_text,
    contentType: e.resp_content_type, headers, body: e.resp_body,
  };
}

function parseParamDocs(json: string | null): DocParam[] {
  const rec = parseRecord(json);
  return Object.entries(rec).map(([key, description]) => {
    const i = key.indexOf(':');
    return { in: i >= 0 ? key.slice(0, i) : 'query', name: i >= 0 ? key.slice(i + 1) : key, description };
  });
}

function parseBranding(json: string | null): DocBranding {
  if (!json) return {};
  try { return JSON.parse(json) as DocBranding; } catch { return {}; }
}

function parseRecord(json: string | null): Record<string, string> {
  if (!json) return {};
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch { return {}; }
}

function pathOf(template: string): string {
  let p = template.replace(/^https?:\/\/[^/]+/i, '');
  const q = p.indexOf('?');
  if (q >= 0) p = p.slice(0, q);
  return p.startsWith('/') ? p : `/${p || ''}`;
}
