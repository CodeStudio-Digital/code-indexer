import type { McpTool } from '../tool.js';
import { projectTools } from './projects.js';
import { searchTools } from './search.js';
import { fileTools } from './file.js';
import { symbolTools } from './symbols.js';
import { snapshotTools } from './snapshots.js';
import { miscTools } from './misc.js';

/**
 * All MCP tools exposed by this server, grouped by domain.
 * To add a new tool: create a `defineTool({...})` in the appropriate
 * group file (or a new one) and append it to this list.
 */
export const allTools: McpTool[] = [
  ...projectTools,
  ...searchTools,
  ...fileTools,
  ...symbolTools,
  ...snapshotTools,
  ...miscTools,
];

export function buildToolRegistry(): Map<string, McpTool> {
  const map = new Map<string, McpTool>();
  for (const t of allTools) {
    if (map.has(t.name)) throw new Error(`Duplicate MCP tool name: ${t.name}`);
    map.set(t.name, t);
  }
  return map;
}
