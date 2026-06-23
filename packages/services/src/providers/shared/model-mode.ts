/**
 * Moved to `@mcp/provider-engine` (the wire builders own model-id parsing).
 * Re-exported here so existing importers keep working during the migration;
 * this shim is removed in the cleanup phase.
 */
export { parseModelWithMode } from '@mcp/provider-engine/wire-helpers/model-mode.js';
export type { ParsedModelMode } from '@mcp/provider-engine/wire-helpers/model-mode.js';
