/**
 * sdk:copilot live model discovery.
 *
 * GitHub Copilot discovery:
 *  1. Refresh the short-lived Copilot token (~25min TTL). The api_key mirror on
 *     provider_configs is a fallback for the common case where the token is
 *     still valid.
 *  2. Hit the published /models endpoint with the header set the API requires.
 *     Prefer endpoints.api from the token exchange when present (the only way
 *     enterprise instances advertise their edge).
 *
 * This format THROWS on failure (no seed/empty fallback) — preserved verbatim.
 * `spec` is unused beyond the uniform signature.
 */
import type {
  ProviderStore,
  ProviderConfig,
  UpsertModelInput,
} from '@mcp/store/provider-store.js';
import {
  refreshIfExpired,
  copilotHeaders,
  getStoredCopilotOpts,
} from '@mcp/services/services/oauth/copilot.js';
import { resolveCopilotApiBase } from '@apps/http-api/admin/shared/copilot-opts.js';
import { getRegistryContextWindow } from '@mcp/code-agent/providers/capabilities.js';
import type { ProviderSpec } from '@mcp/provider-sdk';

export async function discoverCopilotModels(
  _spec: ProviderSpec,
  cfg: ProviderConfig,
  store: ProviderStore,
): Promise<UpsertModelInput[]> {
  let token = cfg.api_key ?? '';
  try {
    const fresh = await refreshIfExpired(store, cfg.id);
    if (fresh) token = fresh;
  } catch (e) {
    throw new Error(
      `Copilot token refresh failed: ${(e as Error).message}. ` +
        `Re-connect Copilot in the admin UI.`
    );
  }
  if (!token) {
    throw new Error('No Copilot token. Click "Connect Copilot" to start the device flow.');
  }

  const opts = getStoredCopilotOpts(store, cfg.id);
  const base = resolveCopilotApiBase(store, cfg);
  const url = `${base}/models`;
  const r = await fetch(url, { headers: copilotHeaders(token, opts) });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Copilot /models HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const data = (await r.json()) as { data: { id: string; name?: string }[] };
  return data.data.map((m) => ({
    model_id: m.id,
    name: m.name ?? m.id,
    context_window: getRegistryContextWindow(m.id),
    source: 'live' as const,
  }));
}
