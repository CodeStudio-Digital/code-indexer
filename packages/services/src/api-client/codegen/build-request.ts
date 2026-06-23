/**
 * build-request — turn a stored request into a CodegenRequest. The ONLY codegen
 * file that imports request-builder + apply-auth, so generators stay dumb. When
 * `resolve` is false, {{var}} templates are kept verbatim (safe to share) but
 * auth is still folded into a header so the snippet is structurally complete.
 */
import { basename } from 'node:path';
import { normalizeKvList, parseMap, resolveMap, resolveTemplate, type KvRow } from '../request-builder.js';
import { computeAuth, mergeAuthHeaders } from '../apply-auth.js';
import { parseAuth } from '../auth-types.js';
import type { ExecRequest } from '../execute-request.js';
import type { CodegenBody, CodegenHeader, CodegenRequest } from './types.js';

const RAW_MIME: Record<string, string> = {
  text: 'text/plain', json: 'application/json', xml: 'application/xml',
  html: 'text/html', javascript: 'application/javascript',
};

/** Adapter: legacy object OR KvRow[] array → CodegenHeader[] (enabled only). */
export function toCodegenHeaders(
  headers: Record<string, string> | Array<{ key: string; value: string; enabled?: boolean }>,
): CodegenHeader[] {
  return normalizeKvList(headers as never).filter((r) => r.enabled && r.key).map((r) => ({ name: r.key, value: r.value }));
}

export function buildCodegenRequest(input: {
  request: ExecRequest;
  baseUrl: string;
  variables: Record<string, string>;
  resolve: boolean;
}): CodegenRequest {
  const req = input.request;
  const vars = input.resolve ? input.variables : {};

  const auth = computeAuth(parseAuth(req.auth_type, req.auth_json), vars, input.resolve);
  const headerMap = mergeAuthHeaders(resolveMap(parseMap(req.headers_json), vars), auth.headers);

  const queryRows = normalizeKvList(req.query_json);
  for (const [k, v] of Object.entries(auth.query)) queryRows.push({ key: k, value: v, enabled: true });
  // Encode in resolved mode so the snippet matches the live request; keep raw in
  // template mode so `{{var}}` stays readable.
  const url = joinUrl(input.baseUrl, req.path_template, queryRows, vars, input.resolve);

  const body = mapBody(req, vars);
  const ct = contentTypeFor(body);
  if (ct && !Object.keys(headerMap).some((h) => h.toLowerCase() === 'content-type')) {
    headerMap['Content-Type'] = ct;
  }

  return {
    method: (req.method || 'GET').toUpperCase(),
    url,
    headers: Object.entries(headerMap).map(([name, value]) => ({ name, value })),
    body,
  };
}

function joinUrl(baseUrl: string, pathTemplate: string, query: KvRow[], vars: Record<string, string>, encode: boolean): string {
  const base = resolveTemplate(baseUrl ?? '', vars).replace(/\/+$/, '');
  const path = resolveTemplate(pathTemplate ?? '', vars);
  let url = /^https?:\/\//i.test(path) ? path : `${base}${path.startsWith('/') || path === '' ? '' : '/'}${path}`;
  const rows = query.filter((r) => r.enabled && r.key);
  if (rows.length) {
    const q = url.indexOf('?');
    if (q >= 0) url = url.slice(0, q);
    const e = (s: string): string => (encode ? encodeURIComponent(s) : s);
    url += `?${rows.map((r) => `${e(resolveTemplate(r.key, vars))}=${e(resolveTemplate(r.value, vars))}`).join('&')}`;
  }
  return url;
}

function rows(json: string | null | undefined, vars: Record<string, string>): KvRow[] {
  return normalizeKvList(json).filter((r) => r.enabled && r.key)
    .map((r) => ({ ...r, key: resolveTemplate(r.key, vars), value: resolveTemplate(r.value, vars) }));
}

function mapBody(req: ExecRequest, vars: Record<string, string>): CodegenBody {
  const kind = req.body_kind === 'form' ? 'urlencoded' : req.body_kind;
  switch (kind) {
    case 'json': return { kind: 'json', content: resolveTemplate(req.body_json ?? '', vars) };
    case 'raw': return { kind: 'raw', content: resolveTemplate(req.body_json ?? '', vars), contentType: RAW_MIME[req.body_raw_lang ?? 'text'] };
    case 'urlencoded': return { kind: 'urlencoded', fields: rows(req.body_urlencoded_json, vars).map((r) => [r.key, r.value] as [string, string]) };
    case 'form-data': return { kind: 'form-data', fields: rows(req.body_form_json, vars).map((r) => ({ name: r.key, value: r.src ? '' : r.value, filename: r.src ? basename(r.src) : undefined })) };
    case 'graphql': {
      try { const g = JSON.parse(req.body_graphql_json ?? '{}'); return { kind: 'graphql', query: resolveTemplate(g.query ?? '', vars), variables: g.variables ? resolveTemplate(g.variables, vars) : undefined }; }
      catch { return { kind: 'graphql', query: '' }; }
    }
    case 'binary': return { kind: 'binary', note: req.body_binary_path ?? '' };
    default: return { kind: 'none' };
  }
}

function contentTypeFor(b: CodegenBody): string | undefined {
  switch (b.kind) {
    case 'json': case 'graphql': return 'application/json';
    case 'raw': return b.contentType;
    case 'urlencoded': return 'application/x-www-form-urlencoded';
    default: return undefined; // form-data/binary: the generator sets it
  }
}
