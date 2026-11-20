/** Same union as McpTier in @mcp/indexer/agent-tools/tool.ts (code-agent does not depend on the indexer). */
type McpTier = 'bootstrap' | 'navigate' | 'admin';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { ToolSourceTruncation } from '@mcp/code-agent/core/tool.js';

/** Omission proof carried in CallToolResult._meta, as the index tool core emits it. */
export type McpSourceTruncation = Omit<ToolSourceTruncation, 'outputId'>;

export interface McpToolOutput {
  text: string;
  sourceTruncations?: McpSourceTruncation[];
}

export type McpToolResult = string | McpToolOutput;

/** Documentation tools only read the shared corpus through the caller's database. */
export interface DocToolContext {
  signal?: AbortSignal;
  db: CodeIndexDB;
}

/** Transport-neutral documentation tool; the MCP server derives scope and hints from `access`. */
export interface DocTool {
  name: string;
  description: string;
  tier: McpTier;
  access: 'read' | 'write' | 'admin';
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  handler(args: Record<string, unknown>, ctx: DocToolContext): Promise<McpToolResult> | McpToolResult;
}

export function defineTool(tool: DocTool): DocTool {
  return tool;
}

/** Same lookup and message as the index tool core (packages/indexer/src/agent-tools/utils.ts). */
export function resolveProject(db: CodeIndexDB, name: string) {
  const project = db.getProjectByName(name);
  if (!project) throw new Error(`Project "${name}" not found. Use list_projects to see available projects.`);
  return project;
}
