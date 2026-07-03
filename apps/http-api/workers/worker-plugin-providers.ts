/**
 * Overlay plugin providers into THIS worker_thread's provider
 * registry, so the agent running inside the worker can resolve a kind that is
 * contributed only by a plugin (a worker has its own module graph — the main
 * process's registry is not shared). V2 provider definitions lazy-import the
 * plugin-owned adapter from the installed plugin bundle.
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
import { loadPluginProviders, isFirstPartyBundled } from '../../../packages/plugin-host/src/index.js';
import { buildProviderDefinition, BUILTIN_SPECS } from '../../../packages/provider-engine/src/index.js';
import { upsertProvider } from '../../../packages/services/src/providers/registry.js';

export function registerWorkerPluginProviders(): void {
  try {
    loadPluginProviders({
      register: upsertProvider,
      buildDefinition: buildProviderDefinition,
      firstParty: isFirstPartyBundled,
      reservedKinds: new Set(BUILTIN_SPECS.map((s) => s.kind)),
    });
  } catch (err) {
    console.warn(
      `[provider-plugin/worker] ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
