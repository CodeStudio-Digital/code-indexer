/**
 * request-builder — resolve `{{var}}` templates and assemble the outgoing URL
 * for an API-client request. Pure + dependency-free so the "send" route AND
 * the non-LLM regression runner share one implementation.
 *
 * Env variables are stored as `{ key: { value, secret } }` in
 * api_environments.variables_json; `parseEnvVariables` flattens them to a
 * plain `{ key: value }` map for substitution. Secrets are resolved here on
 * the server only — they never reach the browser in cleartext.
 */
const TEMPLATE_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** One header/query/form row. The on-disk shape for headers_json/query_json. */
export interface KvRow {
  key: string;
  value: string;
  enabled: boolean;
  description?: string;
  /** form-data only: absolute path when this row is a file part. */
  src?: string;
}

/**
 * Normalize any accepted shape into an ordered KvRow[]:
 *   - legacy object `{ k: v }` (pre-mig-156, OpenAPI importer, agent tools),
 *   - new array `[{ key, value, enabled, description }]`,
 *   - a raw JSON string of either, or null/empty.
 * Disabled rows are preserved (filtering happens at resolution time).
 */
export function normalizeKvList(
  input: string | KvRow[] | Record<string, unknown> | null | undefined,
): KvRow[] {
  if (input == null) return [];
  let v: unknown = input;
  if (typeof input === 'string') {
    if (!input.trim()) return [];
    try { v = JSON.parse(input); } catch { return []; }
  }
  if (Array.isArray(v)) {
    return v
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
      .map((r) => ({
        key: String(r.key ?? ''),
        value: String(r.value ?? ''),
        enabled: r.enabled !== false,
        description: r.description != null ? String(r.description) : undefined,
        src: r.src != null ? String(r.src) : undefined,
      }));
  }
  if (v && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .map(([key, val]) => ({ key, value: String(val ?? ''), enabled: true }));
  }
  return [];
}

/** Replace every `{{key}}` with `vars[key]`; unknown keys are left verbatim. */
export function resolveTemplate(input: string, vars: Record<string, string>): string {
  return input.replace(TEMPLATE_RE, (_m, k: string) => (k in vars ? vars[k] : `{{${k}}}`));
}

/** Flatten `{ key: { value, secret } }` (or `{ key: "value" }`) to `{ key: value }`. */
export function parseEnvVariables(variablesJson: string | null | undefined): Record<string, string> {
  if (!variablesJson) return {};
  try {
    const obj = JSON.parse(variablesJson) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object' && 'value' in v) out[k] = String((v as { value?: unknown }).value ?? '');
      else out[k] = String(v ?? '');
    }
    return out;
  } catch {
    return {};
  }
}

/** Resolve every key+value of a string map through the template engine. */
export function resolveMap(
  map: Record<string, string> | null | undefined,
  vars: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map ?? {})) {
    if (!k) continue;
    out[resolveTemplate(k, vars)] = resolveTemplate(String(v ?? ''), vars);
  }
  return out;
}

/**
 * Decode headers_json / query_json into a `{ k: v }` map of enabled rows only.
 * Accepts both the legacy object form and the new KvRow[] array form (via
 * normalizeKvList). Duplicate keys collapse last-write-wins — for query params
 * where duplicates matter on the wire, use buildUrlFromRows instead.
 */
export function parseMap(json: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of normalizeKvList(json)) {
    if (!row.enabled || !row.key) continue;
    out[row.key] = row.value;
  }
  return out;
}

/**
 * Build the absolute request URL. `pathTemplate` is joined onto `baseUrl`
 * unless it is already absolute (http/https). Query params are appended after
 * template resolution. Throws on an unresolvable URL — the caller surfaces it.
 */
export function buildUrl(
  baseUrl: string,
  pathTemplate: string,
  query: Record<string, string>,
  vars: Record<string, string>,
): URL {
  const base = resolveTemplate(baseUrl ?? '', vars).replace(/\/+$/, '');
  const path = resolveTemplate(pathTemplate ?? '', vars);
  const joined = /^https?:\/\//i.test(path)
    ? path
    : `${base}${path.startsWith('/') || path === '' ? '' : '/'}${path}`;
  const url = new URL(joined);
  for (const [k, v] of Object.entries(resolveMap(query, vars))) {
    if (k) url.searchParams.set(k, v);
  }
  return url;
}

/**
 * Like buildUrl but takes the query as KvRow[] and uses `append`, preserving
 * duplicate query keys (`?id=1&id=2`) and row order — which the object-collapse
 * in parseMap would lose. Disabled rows are skipped. Templates resolve here.
 */
export function buildUrlFromRows(
  baseUrl: string,
  pathTemplate: string,
  query: KvRow[],
  vars: Record<string, string>,
): URL {
  const base = resolveTemplate(baseUrl ?? '', vars).replace(/\/+$/, '');
  const path = resolveTemplate(pathTemplate ?? '', vars);
  const joined = /^https?:\/\//i.test(path)
    ? path
    : `${base}${path.startsWith('/') || path === '' ? '' : '/'}${path}`;
  const url = new URL(joined);
  const rows = query.filter((r) => r.enabled && r.key);
  // When query rows exist they are authoritative — drop any `?…` already in the
  // path (the URL bar mirrors the grid) so a mirrored param isn't duplicated.
  // With no rows, a query embedded in the path (legacy / curl import) is kept.
  if (rows.length) url.search = '';
  for (const row of rows) {
    url.searchParams.append(resolveTemplate(row.key, vars), resolveTemplate(row.value, vars));
  }
  return url;
}
