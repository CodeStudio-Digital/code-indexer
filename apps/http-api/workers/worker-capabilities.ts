/**
 * Capability hydration for worker threads. `capabilities.ts`'s dbLayer is a
 * module global and worker_threads don't share module state (same gotcha as
 * the doc-corpus shims) — without this call, per-model context_window /
 * max_tools set by the admin are silently ignored inside the worker.
 * Best-effort: a failure only costs DB overrides (registry fallbacks win).
 */
import { ProviderStore } from '../../../packages/store/src/provider-store.js';
import { mergeDBCapabilities } from '../../../packages/code-agent/src/providers/capabilities.js';

export function hydrateWorkerCapabilities(
  db: ConstructorParameters<typeof ProviderStore>[0],
  label: string,
): void {
  try {
    mergeDBCapabilities(new ProviderStore(db).listAllModels());
  } catch (e) {
    console.warn(`[${label}] capability hydration failed:`, e);
  }
}
