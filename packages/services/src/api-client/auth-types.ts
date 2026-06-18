/**
 * Auth config shapes for an API-client request. Stored as `auth_type` +
 * `auth_json` columns (mig 156). All string fields may contain `{{var}}`.
 * Pure — shared by apply-auth (send/regression) and codegen. OAuth *flows* are
 * out of scope: only a held token + optional header prefix.
 */
export type ApiAuthType = 'none' | 'bearer' | 'basic' | 'apikey' | 'oauth2';

export type AuthConfig =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apikey'; key: string; value: string; in: 'header' | 'query' }
  | { type: 'oauth2'; token: string; headerPrefix?: string };

/** Safe decode of the stored columns → AuthConfig. Never throws. */
export function parseAuth(authType: string | null | undefined, authJson: string | null | undefined): AuthConfig {
  const t = (authType ?? 'none') as ApiAuthType;
  if (t === 'none') return { type: 'none' };
  let raw: Record<string, unknown> = {};
  try { raw = authJson ? JSON.parse(authJson) : {}; } catch { raw = {}; }
  const s = (k: string): string => String(raw[k] ?? '');
  switch (t) {
    case 'bearer': return { type: 'bearer', token: s('token') };
    case 'basic': return { type: 'basic', username: s('username'), password: s('password') };
    case 'apikey': return { type: 'apikey', key: s('key'), value: s('value'), in: raw.in === 'query' ? 'query' : 'header' };
    case 'oauth2': return { type: 'oauth2', token: s('token'), headerPrefix: raw.headerPrefix != null ? s('headerPrefix') : undefined };
    default: return { type: 'none' };
  }
}
