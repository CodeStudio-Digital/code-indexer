import type { AuthContext } from '@mcp/services/auth/domain/auth-context.js';
import type { ToolContext } from './context.js';

export interface McpToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface McpTool {
  name: string;
  description: string;
  /**
   * Scope required to call this tool. Defaults to 'mcp:write' when absent
   * (fail-safe: authors must opt into broader exposure). The scope registry
   * is built automatically from this field — no parallel map to maintain.
   */
  scope?: string;
  inputSchema: McpToolInputSchema;
  /**
   * Tool handler. The third argument carries per-request authentication
   * context when the HTTP transport is used with auth enabled. It is
   * `undefined` for stdio transport and for HTTP without auth.
   */
  handler(
    args: Record<string, unknown>,
    ctx: ToolContext,
    authCtx?: AuthContext,
  ): Promise<string> | string;
}

/**
 * Identity helper for defining a tool with full type inference.
 * Drop a `defineTool({ ... })` object in any file under tools/ and
 * re-export it from tools/index.ts to plug a new tool into the server.
 */
export function defineTool(tool: McpTool): McpTool {
  return tool;
}
