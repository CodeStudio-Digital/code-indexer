/**
 * Export a collection to a minimal OpenAPI 3.1 document. Pure. Best-effort: one
 * path item per (path, method); query params become `in: query` parameters and a
 * JSON body becomes a requestBody with an example. Not a round-trip of the
 * importer — enough to hand a collection to another tool.
 *
 * When `extras` is supplied (the Docs Studio publish path), the doc also carries
 * the authored rich docs: collection overview + guide pages + branding links fold
 * into `info.description` (markdown), folder docs become per-tag descriptions, and
 * saved request/response examples become per-operation response `examples`. This
 * is what makes the published Swagger-UI surface the authored documentation
 * instead of a bare spec.
 */
import { normalizeKvList } from '../request-builder.js';
import type { ExportRequest } from './export-postman.js';

/** A saved response example, flattened for embedding into an OpenAPI operation. */
export interface OpenApiResponseExample {
  name: string;
  status: number | null;
  statusText?: string | null;
  contentType?: string | null;
  body: string | null;
}

/** Authored, collection-level documentation folded into the exported spec. */
export interface ExportOpenApiExtras {
  /** Collection.description — short tagline (used only if there is no overview). */
  description?: string | null;
  /** Collection overview markdown — rendered at the top of the published docs. */
  overview?: string | null;
  /** Authored guide pages — appended to `info.description` as `##` sections. */
  guides?: { title: string; body: string }[];
  /** `{ [folderName]: markdown }` → per-tag descriptions. */
  folderDocs?: Record<string, string>;
  /** Branding links — appended to `info.description` as a Links section. */
  links?: { label: string; url: string }[];
  /** Saved response examples keyed by `${METHOD} ${path}` (see {@link pathOf}). */
  examplesByKey?: Record<string, OpenApiResponseExample[]>;
}

// Keep the published spec comfortably under the hosting size cap (~1.5 MB): bound
// per-example body size and the number of examples folded into one operation.
const MAX_EXAMPLE_BODY = 64 * 1024;
const MAX_EXAMPLES_PER_OP = 10;

export function exportOpenApi(title: string, requests: ExportRequest[], extras?: ExportOpenApiExtras): unknown {
  const paths: Record<string, Record<string, unknown>> = {};
  const tagSet = new Set<string>();
  for (const r of requests) {
    const path = pathOf(r.path_template);
    const method = (r.method || 'GET').toLowerCase();
    const folder = (r.folder ?? '').trim();
    if (folder) tagSet.add(folder);
    const docs = parseParamDocs(r.param_docs_json);
    const key = `${method.toUpperCase()} ${path}`;
    (paths[path] ??= {})[method] = {
      summary: r.name,
      description: r.description || undefined,
      tags: folder ? [folder] : undefined,
      parameters: [
        ...normalizeKvList(r.query_json).filter((q) => q.enabled && q.key).map((q) => ({ name: q.key, in: 'query', description: docs[`query:${q.key}`] || undefined, schema: { type: 'string' }, example: q.value || undefined })),
        ...normalizeKvList(r.headers_json).filter((h) => h.enabled && h.key).map((h) => ({ name: h.key, in: 'header', description: docs[`header:${h.key}`] || undefined, schema: { type: 'string' }, example: h.value || undefined })),
      ],
      requestBody: bodyOf(r),
      responses: responsesOf(extras?.examplesByKey?.[key]),
    };
  }
  const folderDocs = extras?.folderDocs ?? {};
  const tags = [...tagSet].sort().map((name) => (folderDocs[name] ? { name, description: folderDocs[name] } : { name }));
  const info: Record<string, unknown> = { title, version: '1.0.0' };
  const description = composeDescription(extras);
  if (description) info.description = description;
  return { openapi: '3.1.0', info, tags, paths };
}

/** The path key for an operation — exported so callers can build a matching
 *  `examplesByKey` map keyed identically to the operations produced here. */
export function pathOf(template: string): string {
  let p = template.replace(/^https?:\/\/[^/]+/i, '');
  const q = p.indexOf('?');
  if (q >= 0) p = p.slice(0, q);
  return p.startsWith('/') ? p : `/${p || ''}`;
}

/** Build the `responses` object from saved examples, or a bare `200` when none. */
function responsesOf(examples: OpenApiResponseExample[] | undefined): Record<string, unknown> {
  if (!examples?.length) return { '200': { description: 'OK' } };
  const responses: Record<string, { description: string; content?: Record<string, { examples: Record<string, unknown> }> }> = {};
  for (const ex of examples.slice(0, MAX_EXAMPLES_PER_OP)) {
    const code = ex.status != null ? String(ex.status) : 'default';
    const resp = (responses[code] ??= { description: ex.statusText || 'Response' });
    if (ex.body == null || ex.body === '') continue;
    const ct = ex.contentType || 'application/json';
    const media = ((resp.content ??= {})[ct] ??= { examples: {} });
    const body = ex.body.length > MAX_EXAMPLE_BODY ? ex.body.slice(0, MAX_EXAMPLE_BODY) : ex.body;
    media.examples[uniqueKey(media.examples, ex.name || 'example')] = { value: parseMaybeJson(body, ct) };
  }
  return Object.keys(responses).length ? responses : { '200': { description: 'OK' } };
}

/** Parse a JSON body to an object (so Swagger-UI renders it structured); fall
 *  back to the raw string for non-JSON or unparseable bodies. */
function parseMaybeJson(body: string, contentType: string): unknown {
  if (/json/i.test(contentType) || /^\s*[[{]/.test(body)) {
    try { return JSON.parse(body); } catch { /* keep raw */ }
  }
  return body;
}

/** Compose the markdown `info.description` from overview + guides + links. */
function composeDescription(extras?: ExportOpenApiExtras): string {
  if (!extras) return '';
  const parts: string[] = [];
  const lead = (extras.overview ?? '').trim() || (extras.description ?? '').trim();
  if (lead) parts.push(lead);
  for (const g of extras.guides ?? []) {
    const title = (g?.title ?? '').trim();
    const bodyMd = (g?.body ?? '').trim();
    if (!title && !bodyMd) continue;
    parts.push(title ? `## ${title}\n\n${bodyMd}`.trim() : bodyMd);
  }
  const links = (extras.links ?? []).filter((l) => l && l.url);
  if (links.length) parts.push(['## Links', ...links.map((l) => `- [${l.label || l.url}](${l.url})`)].join('\n'));
  return parts.join('\n\n').trim();
}

function uniqueKey(obj: Record<string, unknown>, base: string): string {
  if (!(base in obj)) return base;
  let i = 2;
  while (`${base} (${i})` in obj) i += 1;
  return `${base} (${i})`;
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
