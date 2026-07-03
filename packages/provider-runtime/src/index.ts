/**
 * @mcp/provider-runtime
 *
 * Reusable runtime primitives for provider plugins. This package turns a
 * provider-owned ProviderSpec into executable provider adapters without making
 * plugins depend on the IDE's provider-engine package.
 */

export { buildProviderDefinition } from './build-definition.js';
export { defineProviderAdapterFromSpec } from './plugin-adapter.js';
export type { ProviderAdapterFromSpecOptions } from './plugin-adapter.js';

export { parseModelWithMode } from './wire-helpers/model-mode.js';
export type { ParsedModelMode } from './wire-helpers/model-mode.js';
