import { ProviderStore } from '../../../store/provider-store.js';
import { loadConfig } from '../../../utils/config.js';

/**
 * Singleton ProviderStore shared by all provider factories and the
 * registry. Previously duplicated in indexer/providers/factory.ts and
 * coder/providers/factory.ts; consolidated here so both factories hit
 * the same instance (important for OAuth token refresh state).
 */
let cached: ProviderStore | null = null;

export function getStore(): ProviderStore | null {
  if (cached) return cached;
  try {
    const cfg = loadConfig();
    cached = new ProviderStore(cfg.dbPath);
    cached.seedFromEnvIfEmpty();
    return cached;
  } catch {
    return null;
  }
}

/** Test hook: force a specific store (or null to re-open on next call). */
export function __setStoreForTests(store: ProviderStore | null): void {
  cached = store;
}
