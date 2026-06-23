/**
 * Export a collection to a minimal OpenAPI 3.1 document. Pure. Best-effort: one
 * path item per (path, method); query params become `in: query` parameters and a
 * JSON body becomes a requestBody with an example. Not a round-trip of the
 * importer — enough to hand a collection to another tool.
 */
import { normalizeKvList } from '../request-builder.js';
import type { ExportRequest } from './export-postman.js';

export function exportOpenApi(title: string, requests: ExportRequest[]): unknown {
  const paths: Record<string, Record<string, unknown>> = {};
  const tagSet = new Set<string>();
  for (const r of requests) {
    const path = pathOf(r.path_template);
    const method = (r.method || 'GET').toLowerCase();
    const folder = (r.folder ?? '').trim();
    if (folder) tagSet.add(folder);
    const docs = parseParamDocs(r.param_docs_json);
    (paths[path] ??= {})[method] = {
      summary: r.name,
      description: r.description || undefined,
      tags: folder ? [folder] : undefined,
      parameters: [
        ...normalizeKvList(r.query_json).filter((q) => q.enabled && q.key).map((q) => ({ name: q.key, in: 'query', description: docs[`query:${q.key}`] || undefined, schema: { type: 'string' }, example: q.value || undefined })),
        ...normalizeKvList(r.headers_json).filter((h) => h.enabled && h.key).map((h) => ({ name: h.key, in: 'header', description: docs[`header:${h.key}`] || undefined, schema: { type: 'string' }, example: h.value || undefined })),
      ],
      requestBody: bodyOf(r),
      responses: { '200': { description: 'OK' } },
    };
  }
  const tags = [...tagSet].sort().map((name) => ({ name }));
  return { openapi: '3.1.0', info: { title, version: '1.0.0' }, tags, paths };
}

/** Parse the per-param docs map (`{ "query:limit": markdown }`); tolerant of junk. */
function parseParamDocs(json: string | null | undefined): Record<string, string> {
  if (!json) return {};
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch { return {}; }
}

/** Strip protocol+host and query, keep the path; default to '/'. */
function pathOf(template: string): string {
  let p = template.replace(/^https?:\/\/[^/]+/i, '');
  const q = p.indexOf('?');
  if (q >= 0) p = p.slice(0, q);
  return p.startsWith('/') ? p : `/${p || ''}`;
}

function bodyOf(r: ExportRequest): unknown {
  const kind = r.body_kind === 'form' ? 'urlencoded' : r.body_kind;
  if (kind === 'json' && r.body_json) {
    let example: unknown = r.body_json;
    try { example = JSON.parse(r.body_json); } catch { /* keep raw */ }
    return { content: { 'application/json': { example } } };
  }
  if (kind === 'raw' && r.body_json) return { content: { 'text/plain': { example: r.body_json } } };
  return undefined;
}
