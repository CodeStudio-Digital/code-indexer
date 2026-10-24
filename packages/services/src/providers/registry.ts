import type { ProviderDefinition } from '@mcp/provider-sdk';
// Load declarative specs separately so database seeding can use their metadata
// without constructing runtime adapters or importing model discovery.
import { buildProviderDefinition } from '@mcp/provider-engine/build-definition.js';
import { BUILTIN_SPECS } from '@mcp/provider-engine/specs/index.js';
import { setProviderSeedDefinitionsResolver } from './seed-catalog.js';

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
 * discovery, cost lookup, env auto-seed, and the coder factory.
 *
 * NOTE: `BUILTIN_SPECS` order is load-bearing — pricing first-match + env-var
 * fallback iterate the Map in insertion order. The engine's spec list preserves
 * the exact former BUILTIN_DEFINITIONS order.
 */

/** Construct adapters only when a runtime consumer requests the registry. */
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

setProviderSeedDefinitionsResolver(listDefinitions);
