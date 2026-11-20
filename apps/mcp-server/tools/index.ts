import { fromIndexTool, type McpTool } from '../tool.js';
import { projectTools } from '@mcp/indexer/agent-tools/tools/projects.js';
import { searchTools } from '@mcp/indexer/agent-tools/tools/search.js';
import { fileTools } from '@mcp/indexer/agent-tools/tools/file.js';
import { symbolTools } from '@mcp/indexer/agent-tools/tools/symbols.js';
import { snapshotTools } from '@mcp/indexer/agent-tools/tools/snapshots.js';
import { miscTools } from '@mcp/indexer/agent-tools/tools/misc.js';
import { docsTools } from '@mcp/code-agent/tools/index-docs/docs.js';
import { index_project } from './index-project.js';
import { export_docs } from './export-docs.js';
import { agentTools } from './agents.js';

// get_costs, then export_docs, then list_models: the published order is kept.
const [getCosts, ...otherMiscTools] = miscTools.map(fromIndexTool);

/**
 * All MCP tools exposed by this server, grouped by domain.
 * The index tool core lives in packages/indexer/src/agent-tools; tools that
 * only the application/CLI surface offers (indexing, export, agent runs) stay here.
 */
export const allTools: McpTool[] = [
  index_project,
  ...projectTools.map(fromIndexTool),
  ...searchTools.map(fromIndexTool),
  ...fileTools.map(fromIndexTool),
  ...symbolTools.map(fromIndexTool),
  ...snapshotTools.map(fromIndexTool),
  getCosts,
  export_docs,
  ...otherMiscTools,
  // Documentation RAG. Read-only; bound to mcp:read scope. Exposed here
  // so external agents see the same `rag_search_docs` shape the in-house
  // code-agent uses internally — no rebranding for clients.
  ...docsTools.map(fromIndexTool),
  ...agentTools,
];

export function buildToolRegistry(): Map<string, McpTool> {
  const map = new Map<string, McpTool>();
  for (const t of allTools) {
    if (map.has(t.name)) throw new Error(`Duplicate MCP tool name: ${t.name}`);
    map.set(t.name, t);
  }
  return map;
}
