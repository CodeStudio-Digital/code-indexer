/**
 * apply-auth — turn an AuthConfig into headers/query to merge into a request.
 * Used identically by the send route, the regression runner and codegen so a
 * generated snippet matches the real request. When `resolve` is false the
 * `{{var}}` templates are kept verbatim (template/codegen form); basic auth then
 * base64-encodes the literal templated strings (documented caveat).
 *
 * Precedence (enforced by the caller's merge): an explicit same-named header in
 * the Headers tab WINS over auth — auth never overwrites it.
 */
import { resolveTemplate } from './request-builder.js';
import type { AuthConfig } from './auth-types.js';

export interface AuthApplication {
  headers: Record<string, string>;
  query: Record<string, string>;
}

export function computeAuth(cfg: AuthConfig, vars: Record<string, string>, resolve = true): AuthApplication {
  const out: AuthApplication = { headers: {}, query: {} };
  const r = (s: string): string => (resolve ? resolveTemplate(s, vars) : s);
  switch (cfg.type) {
    case 'none':
      break;
    case 'bearer':
      if (cfg.token) out.headers['Authorization'] = `Bearer ${r(cfg.token)}`;
      break;
    case 'basic': {
      const creds = `${r(cfg.username)}:${r(cfg.password)}`;
      out.headers['Authorization'] = `Basic ${Buffer.from(creds).toString('base64')}`;
      break;
    }
    case 'apikey': {
      if (!cfg.key) break;
      if (cfg.in === 'query') out.query[r(cfg.key)] = r(cfg.value);
      else out.headers[r(cfg.key)] = r(cfg.value);
      break;
    }
    case 'oauth2':
      if (cfg.token) out.headers['Authorization'] = `${cfg.headerPrefix?.trim() || 'Bearer'} ${r(cfg.token)}`;
      break;
  }
  return out;
}

/**
 * Merge auth headers into already-resolved request headers WITHOUT overwriting
 * an explicit same-named header (case-insensitive). Mutates+returns `headers`.
 */
export function mergeAuthHeaders(headers: Record<string, string>, authHeaders: Record<string, string>): Record<string, string> {
  const present = new Set(Object.keys(headers).map((h) => h.toLowerCase()));
  for (const [k, v] of Object.entries(authHeaders)) {
    if (!present.has(k.toLowerCase())) headers[k] = v;
  }
  return headers;
}
