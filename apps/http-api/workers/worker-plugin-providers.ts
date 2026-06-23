/**
 * Overlay declarative plugin providers into THIS worker_thread's provider
 * registry, so the agent running inside the worker can resolve a kind that is
 * contributed only by a plugin (a worker has its own module graph — the main
 * process's registry is not shared).
 *
 * IMPORTANT: workers import via RELATIVE paths only (Node resolves before tsx/
 * tsconfig `paths`, so `@mcp/*` aliases throw inside a worker_thread). This is a
 * deliberate, tiny duplicate of `server/plugin-providers.ts` for that reason.
 *
 * Best-effort: any failure is swallowed so the worker still boots with the
 * built-in providers (no regression). The full reconcile (restore built-ins,
 * drop stale) isn't needed here — a freshly-spawned worker starts from the
 * lazily-seeded built-ins, so it only needs to OVERLAY the enabled plugins.
 */
import { loadPluginProviders } from '../../../packages/plugin-host/src/index.js';
import { buildProviderDefinition } from '../../../packages/provider-engine/src/index.js';
import { upsertProvider } from '../../../packages/services/src/providers/registry.js';

export function registerWorkerPluginProviders(): void {
  try {
    loadPluginProviders({ register: upsertProvider, buildDefinition: buildProviderDefinition });
  } catch (err) {
    console.warn(
      `[provider-plugin/worker] ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
