/**
 * GitHub Copilot model discovery.
 *
 * 1. Refresh the short-lived Copilot token (~25min TTL). The api_key mirror on
 *    provider_configs is a fallback for the common case where the token is
 *    still valid.
 * 2. Hit the published /models endpoint with the header set the API requires.
 *    Prefer endpoints.api from the token exchange when present (that's the
 *    only way enterprise instances advertise their edge).
 */
import type {
  ProviderStore,
  ProviderConfig,
  UpsertModelInput,
} from '../../../../store/provider-store.js';
import {
  refreshIfExpired,
  copilotHeaders,
  getStoredCopilotOpts,
} from '../../../../core/services/oauth/copilot.js';
import { resolveCopilotApiBase } from '../shared/copilot-opts.js';

export async function discoverCopilot(
  store: ProviderStore,
  cfg: ProviderConfig
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
    source: 'live',
  }));
}
