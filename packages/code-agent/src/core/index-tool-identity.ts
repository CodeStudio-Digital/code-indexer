import type { CoderTool } from './tool.js';

/** Provider of the first-party index tools (mcp__*), served in-process by the index tools port. */
export const INDEX_TOOLS_PROVIDER_ID = 'code-indexer';

/**
 * The index tools are `source: 'native'` (they run in this process), but they
 * keep the behaviour they had while served over MCP, now by explicit rule:
 * the slow timeout, staying out of isolated Ultra children (they are bound
 * to the main project's root and index), and the 'mcp' label in contracts
 * published before (operational tool events, project tool-filter hooks and
 * the find_tools listing the model reads). Telemetry tells them apart by
 * `capabilityProvenance.providerId` and `provenanceRef`.
 */
export function isIndexTool(tool: Pick<CoderTool, 'capabilityProvenance'> | undefined): boolean {
  return tool?.capabilityProvenance?.providerId === INDEX_TOOLS_PROVIDER_ID;
}

/** The source label already published for a tool: index tools keep 'mcp'. */
export function publishedToolSource(tool: Pick<CoderTool, 'source' | 'capabilityProvenance'>): string {
  return isIndexTool(tool) ? 'mcp' : tool.source;
}
