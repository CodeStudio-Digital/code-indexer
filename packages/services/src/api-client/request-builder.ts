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

/** Safe JSON.parse → object map, used to decode headers_json / query_json. */
export function parseMap(json: string | null | undefined): Record<string, string> {
  if (!json) return {};
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = String(v ?? '');
    return out;
  } catch {
    return {};
  }
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
