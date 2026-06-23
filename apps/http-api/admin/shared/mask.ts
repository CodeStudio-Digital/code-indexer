/**
 * Shared masking + serialization helpers for admin routes.
 *
 * `publicProvider` is the public shape returned to the dashboard — api_key is
 * intentionally masked so screenshots don't leak secrets.
 */
import type { ProviderConfig } from '@mcp/store/provider-store.js';

export function maskKey(k: string | null): string | null {
  if (!k) return null;
  if (k.length <= 8) return '••••';
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

const SECRET_KEY_RE = /(api[_-]?key|raw[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|authorization|bearer)/i;

function publicExtra(value: unknown, key = ''): unknown {
  if (value === null || value === undefined) return value;
  if (SECRET_KEY_RE.test(key)) {
    return typeof value === 'string' ? maskKey(value) : '••••';
  }
  if (Array.isArray(value)) return value.map((item) => publicExtra(item));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = publicExtra(v, k);
    }
    return out;
  }
  return value;
}

export function publicProvider(p: ProviderConfig) {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    base_url: p.base_url,
    api_key_masked: maskKey(p.api_key),
    has_key: !!p.api_key,
    auth_mode: p.auth_mode,
    enabled: p.enabled,
    use_for_agent: p.use_for_agent,
    use_for_coder: p.use_for_coder,
    use_for_general: p.use_for_general,
    is_default: p.is_default,
    extra: publicExtra(p.extra) as Record<string, unknown>,
    fallback_provider_id: p.fallback_provider_id ?? null,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

export type PublicProvider = ReturnType<typeof publicProvider>;
