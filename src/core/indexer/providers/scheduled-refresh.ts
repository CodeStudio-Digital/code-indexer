/**
 * Scheduled background refresh of provider model lists.
 *
 * On each cycle this module:
 *   1. Iterates every enabled provider that has credentials.
 *   2. Calls live discovery for each provider (same logic as the admin "Refresh" button).
 *   3. Persists the updated list via replaceModelsFromSource so manual entries
 *      are never overwritten.
 *   4. Calls mergeDBCapabilities() so getModelContextWindow() reflects the
 *      latest context_window values without a process restart.
 *
 * Interval: controlled by PROVIDER_REFRESH_INTERVAL_MS env var.
 * Default: 24 hours. Set to 0 to disable background refresh.
 */

import type { ProviderStore } from '../../../store/provider-store.js';
import { discoverModels } from '../../../apps/http-api/admin/model-discovery/index.js';
import { mergeDBCapabilities } from '../../coder/providers/capabilities.js';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const INITIAL_DELAY_MS = 10_000; // 10 s after startup

export async function refreshAllProviderModels(store: ProviderStore): Promise<void> {
  const providers = store.listProviders({ enabled: true });
  let refreshed = 0;
  for (const p of providers) {
    // Skip providers that can't do live discovery (no credentials, no SDK).
    const hasCredentials = !!(p.api_key || p.extra);
    if (!hasCredentials && p.kind !== 'bedrock') continue;
    try {
      const previousEtag = store.getProviderCatalogEtag(p.id);
      const result = await discoverModels(store, p, previousEtag);
      if (!result.notModified) {
        store.replaceModelsFromSource(p.id, 'live', result.models);
        store.setProviderCatalogEtag(p.id, result.etag);
      }
      refreshed++;
    } catch (e) {
      console.warn(
        `[provider-refresh] ${p.kind}/${p.id} failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  if (refreshed > 0) {
    // Re-hydrate the in-memory capability cache with updated context_windows.
    const allModels = store.listAllModels();
    mergeDBCapabilities(allModels);
    console.log(`[provider-refresh] refreshed ${refreshed}/${providers.length} providers`);
  }
}

/**
 * Start the periodic refresh timer. Returns a cleanup function that cancels
 * the timer (useful for tests or graceful shutdown).
 */
export function startProviderRefreshScheduler(store: ProviderStore): () => void {
  const intervalMs = Number(process.env.PROVIDER_REFRESH_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  if (intervalMs <= 0) {
    console.log('[provider-refresh] background refresh disabled (PROVIDER_REFRESH_INTERVAL_MS=0)');
    return () => { /* no-op */ };
  }

  // Initial run after a short delay so it doesn't compete with server startup.
  const initialTimer = setTimeout(() => {
    refreshAllProviderModels(store).catch((e) =>
      console.warn(`[provider-refresh] initial run failed: ${e instanceof Error ? e.message : String(e)}`)
    );
  }, INITIAL_DELAY_MS);

  const intervalTimer = setInterval(() => {
    refreshAllProviderModels(store).catch((e) =>
      console.warn(`[provider-refresh] periodic run failed: ${e instanceof Error ? e.message : String(e)}`)
    );
  }, intervalMs);

  // Prevent these timers from keeping the process alive if everything else exits.
  initialTimer.unref();
  intervalTimer.unref();

  console.log(`[provider-refresh] scheduler started (interval=${intervalMs / 1000}s, initial delay=${INITIAL_DELAY_MS / 1000}s)`);

  return () => {
    clearTimeout(initialTimer);
    clearInterval(intervalTimer);
  };
}
