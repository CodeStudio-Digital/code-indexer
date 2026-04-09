import type { ToolContext } from './context.js';

export interface McpToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: McpToolInputSchema;
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<string> | string;
}

/**
 * Identity helper for defining a tool with full type inference.
 * Drop a `defineTool({ ... })` object in any file under tools/ and
 * re-export it from tools/index.ts to plug a new tool into the server.
 */
export function defineTool(tool: McpTool): McpTool {
  return tool;
}
