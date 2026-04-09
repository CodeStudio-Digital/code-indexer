/**
 * Shared masking + serialization helpers for admin routes.
 *
 * `publicProvider` is the public shape returned to the dashboard — api_key is
 * intentionally masked so screenshots don't leak secrets.
 */
import type { ProviderConfig } from '../../../../store/provider-store.js';

export function maskKey(k: string | null): string | null {
  if (!k) return null;
  if (k.length <= 8) return '••••';
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
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
    is_default: p.is_default,
    extra: p.extra,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

export type PublicProvider = ReturnType<typeof publicProvider>;
