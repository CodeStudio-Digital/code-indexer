/**
 * Export a collection to Postman Collection v2.1 JSON. Pure. Headers/query use
 * the normalized KvRow form; bodies map to Postman's body modes.
 */
import { normalizeKvList } from '../request-builder.js';
import type { ExecRequest } from '../execute-request.js';

export type ExportRequest = ExecRequest & {
  name: string;
  folder?: string | null;
  /** Docs Studio: per-endpoint markdown (folded into OpenAPI operation.description). */
  description?: string | null;
  /** Docs Studio: `{ "query:limit": markdown }` → OpenAPI parameter.description. */
  param_docs_json?: string | null;
};

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

function toItem(r: ExportRequest): unknown {
  return {
    name: r.name,
    request: {
      method: (r.method || 'GET').toUpperCase(),
      header: normalizeKvList(r.headers_json).filter(h => h.key).map(h => ({ key: h.key, value: h.value, disabled: !h.enabled || undefined })),
      url: buildUrl(r),
      body: buildBody(r),
    },
  };
}

export function exportPostman(name: string, requests: ExportRequest[]): unknown {
  // Group by folder into nested Postman v2.1 folder items (a folder = an item
  // with its own `item[]`). Top-level (no folder) requests come first.
  const byFolder = new Map<string, ExportRequest[]>();
  for (const r of requests) {
    const f = (r.folder ?? '').trim();
    if (!byFolder.has(f)) byFolder.set(f, []);
    byFolder.get(f)!.push(r);
  }
  const item: unknown[] = (byFolder.get('') ?? []).map(toItem);
  for (const [folder, reqs] of [...byFolder.entries()].filter(([f]) => f).sort((a, b) => a[0].localeCompare(b[0]))) {
    item.push({ name: folder, item: reqs.map(toItem) });
  }
  return { info: { name, schema: SCHEMA }, item };
}

function buildUrl(r: ExportRequest): unknown {
  const raw = r.path_template;
  const query = normalizeKvList(r.query_json).filter((q) => q.key).map((q) => ({ key: q.key, value: q.value, disabled: !q.enabled || undefined }));
  return { raw, query: query.length ? query : undefined };
}

function buildBody(r: ExportRequest): unknown {
  const kind = r.body_kind === 'form' ? 'urlencoded' : r.body_kind;
  switch (kind) {
    case 'json': case 'raw':
      return { mode: 'raw', raw: r.body_json ?? '', options: { raw: { language: kind === 'json' ? 'json' : (r.body_raw_lang ?? 'text') } } };
    case 'graphql': {
      try { const g = JSON.parse(r.body_graphql_json ?? '{}'); return { mode: 'graphql', graphql: { query: g.query ?? '', variables: g.variables ?? '' } }; }
      catch { return undefined; }
    }
    case 'urlencoded':
      return { mode: 'urlencoded', urlencoded: normalizeKvList(r.body_urlencoded_json).map((f) => ({ key: f.key, value: f.value, disabled: !f.enabled || undefined })) };
    case 'form-data':
      return { mode: 'formdata', formdata: normalizeKvList(r.body_form_json).map((f) => f.src ? { key: f.key, type: 'file', src: f.src } : { key: f.key, value: f.value, type: 'text' }) };
    default:
      return undefined;
  }
}
