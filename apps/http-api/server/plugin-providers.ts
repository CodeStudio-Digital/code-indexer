/**
 * Reconcile the provider registry with the declarative provider plugins that
 * are currently installed + enabled. The composition root (this app) is the one
 * place where the plugin loader (@mcp/plugin-host), the engine (@mcp/provider-
 * engine) and the registry (@mcp/services) all converge without a cycle — the
 * loader stays engine/registry-agnostic via injection.
 *
 * Idempotent + complete: re-seeds the built-ins (so disabling a plugin that
 * overrode one restores it), overlays the enabled plugins' specs (DATA → engine
 * → registry, NO bundle), then drops any plugin-only kind that is no longer
 * enabled. Called at boot AND after every install/enable/disable/uninstall, so a
 * plugin provider appears or disappears live — no restart, no flags.
 */
import { loadPluginProviders, isFirstPartyBundled } from '@mcp/plugin-host';
import { buildProviderDefinition, BUILTIN_SPECS } from '@mcp/provider-engine';
import {
  upsertProvider,
  unregisterProvider,
  getRegistry,
} from '@mcp/services/providers/registry.js';

export function syncPluginProviders(): void {
  const builtinKinds = new Set(BUILTIN_SPECS.map((s) => s.kind));

  // Restore built-ins first (undo any stale override left by a now-disabled plugin).
  for (const spec of BUILTIN_SPECS) upsertProvider(buildProviderDefinition(spec));

  // Overlay providers contributed by currently-enabled plugins.
  //  - A first-party BUNDLED plugin (provider-*, shipped in the app) may own a
  //    built-in kind and declare host capabilities (validated with the full
  //    schema, exempt from reservedKinds) — that's how the relocated providers
  //    take over their kind.
  //  - Any OTHER (third-party) plugin is held to the third-party schema and may
  //    NOT shadow a built-in kind.
  const res = loadPluginProviders({
    register: upsertProvider,
    buildDefinition: buildProviderDefinition,
    firstParty: isFirstPartyBundled,
    reservedKinds: builtinKinds,
    onError: (ns, e) =>
      console.warn(`[provider-plugin] ${ns}: ${e instanceof Error ? e.message : String(e)}`),
  });

  // Drop plugin-only kinds that are no longer enabled.
  const pluginKinds = new Set(res.loaded.flatMap((l) => l.kinds));
  for (const kind of [...getRegistry().keys()]) {
    if (!builtinKinds.has(kind) && !pluginKinds.has(kind)) unregisterProvider(kind);
  }

  if (res.loaded.length) {
    console.log(
      `[provider-plugin] registered: ${res.loaded
        .map((l) => `${l.namespace}(${l.kinds.join(',')})`)
        .join(', ')}`,
    );
  }
}
