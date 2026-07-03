/**
 * @mcp/provider-engine — turns a declarative `ProviderSpec` (pure data) into a
 * runtime `ProviderDefinition` (adapters + live model discovery + connectivity
 * test), keyed by `wire` protocol. The ONE place that imports the concrete
 * adapter classes from @mcp/code-agent + @mcp/indexer.
 *
 * Built-ins and plugins both author a `ProviderSpec`; this engine is the single
 * mechanism that builds them. Sits below services/plugin-host/http-api and
 * above code-agent/indexer (which never import it) → no new cycle.
 */
export { parseModelWithMode } from './wire-helpers/model-mode.js';
export type { ParsedModelMode } from './wire-helpers/model-mode.js';
export { buildProviderDefinition } from './build-definition.js';
export { defineProviderAdapterFromSpec } from './plugin-adapter.js';
export type { ProviderAdapterFromSpecOptions } from './plugin-adapter.js';
export { discoverModels } from './discovery/index.js';
export type { DiscoveryResult } from './discovery/index.js';
export { BUILTIN_SPECS, getSpecByKind } from './specs/index.js';
