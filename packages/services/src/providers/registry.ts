import type { ProviderDefinition } from '@mcp/provider-sdk';
// Leaf subpath imports (not the barrel): the barrel re-exports discoverModels,
// which would drag the discovery subgraph into registry's module cycle. These
// two leaves keep the registry↔store cycle to the adapter path only.
import { buildProviderDefinition } from '@mcp/provider-engine/build-definition.js';
import { BUILTIN_SPECS } from '@mcp/provider-engine/specs/index.js';

/**
 * Provider registry — single source of truth for all provider shapes.
 *
 * Built-in providers are built from their declarative `ProviderSpec`s
 * (`@mcp/provider-engine`'s `BUILTIN_SPECS`) via the single
 * `buildProviderDefinition` engine — the same mechanism a plugin uses. The Map
 * is built LAZILY on first access (see {@link registry}). Plugin providers
 * register at install/enable time through the same door
 * ({@link registerProvider} / {@link upsertProvider}), so a third-party
 * provider authored against `@mcp/provider-sdk` dispatches identically to a
 * built-in.
 *
 * To add a new built-in provider:
 *   1. Create a `ProviderSpec` in `@mcp/provider-engine/specs/*` and add it to
 *      `BUILTIN_SPECS` (in the documented order).
 * It then surfaces automatically in the CLI wizard, admin picker, model
 * discovery, cost lookup, env auto-seed, and both factories.
 *
 * NOTE: `BUILTIN_SPECS` order is load-bearing — pricing first-match + env-var
 * fallback iterate the Map in insertion order. The engine's spec list preserves
 * the exact former BUILTIN_DEFINITIONS order.
 */

/**
 * Lazily-built singleton. The registry sits on the pre-existing
 * registry↔store↔seed import cycle (`store/provider/seed.ts` statically imports
 * `listDefinitions`). Building the Map eagerly at module eval would call
 * `buildProviderDefinition` while `@mcp/provider-engine/build-definition.ts` is
 * still mid-initialization (its `WIRES` const in the temporal dead zone) whenever
 * the cycle is entered engine-first. Deferring to first access guarantees every
 * module in the cycle has finished evaluating before any definition is built.
 */
let registrySingleton: Map<string, ProviderDefinition> | null = null;
function registry(): Map<string, ProviderDefinition> {
  if (registrySingleton) return registrySingleton;
  const map = new Map<string, ProviderDefinition>();
  for (const spec of BUILTIN_SPECS) {
    const def = buildProviderDefinition(spec);
    if (map.has(def.kind)) {
      throw new Error(`Duplicate provider kind in registry: ${def.kind}`);
    }
    map.set(def.kind, def);
  }
  registrySingleton = map;
  return map;
}

/**
 * Register a provider definition (e.g. contributed by a plugin). Throws on a
 * duplicate kind to catch an accidental clash with a built-in or another
 * plugin. Use {@link upsertProvider} for a plugin reload that intentionally
 * replaces an existing kind.
 */
export function registerProvider(def: ProviderDefinition): void {
  const map = registry();
  if (map.has(def.kind)) {
    throw new Error(`Duplicate provider kind in registry: ${def.kind}`);
  }
  map.set(def.kind, def);
}

/** Insert or replace a provider definition (idempotent; for plugin reloads). */
export function upsertProvider(def: ProviderDefinition): void {
  registry().set(def.kind, def);
}

/** Remove a registered provider (plugin uninstall/disable). Built-ins should not be removed. */
export function unregisterProvider(kind: string): void {
  registry().delete(kind);
}

export function getRegistry(): Map<string, ProviderDefinition> {
  return registry();
}

/** All definitions as an array (for admin UI serialization). */
export function listDefinitions(): ProviderDefinition[] {
  return [...registry().values()];
}

/** Shortcut: lookup a definition by kind. */
export function getDefinition(kind: string): ProviderDefinition | undefined {
  return registry().get(kind);
}

/**
 * List the kinds registered with a `createCoder` builder — i.e. all shapes
 * usable by the coder runner. Derived dynamically so adding a new
 * coder-capable shape automatically surfaces it to the HTTP list route.
 */
export function listCoderKinds(): string[] {
  return listDefinitions().filter((d) => !!d.createCoder).map((d) => d.kind);
}

/** List the kinds registered with an indexer builder (sync or async). */
export function listIndexerKinds(): string[] {
  return listDefinitions()
    .filter((d) => !!d.createIndexer || !!d.createIndexerAsync)
    .map((d) => d.kind);
}
