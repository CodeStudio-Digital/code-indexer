import type { AuthContext } from '@mcp/services/auth/domain/auth-context.js';
import type { McpTier } from '@mcp/services/auth/domain/api-token.js';
import type { IndexTool, McpToolInputSchema, McpToolResult } from '@mcp/indexer/agent-tools/tool.js';
import type { ToolContext } from './context.js';

// The result contract lives with the transport-neutral index tool core.
export {
  normalizeMcpToolResult,
  mcpToolResultFields,
  type McpToolInputSchema,
  type McpToolOutput,
  type McpToolResult,
} from '@mcp/indexer/agent-tools/tool.js';

const MCP_ACCESS = {
  read: {
    scope: 'mcp:read',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  write: {
    scope: 'mcp:write',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  admin: {
    scope: 'mcp:admin',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
} as const;

/** Keep scope and MCP safety annotations coupled at the definition site. */
export function mcpAccess<K extends keyof typeof MCP_ACCESS>(kind: K): (typeof MCP_ACCESS)[K] {
  return MCP_ACCESS[kind];
}

export interface McpTool {
  name: string;
  description: string;
  /** Canonical external tier. Required so an unclassified tool fails at build time. */
  tier: McpTier;
  /**
   * Scope required to call this tool. Required so tools/list and tools/call
   * cannot drift into the old "advertised but rejected" state.
   */
  scope: 'mcp:read' | 'mcp:write' | 'mcp:admin';
  /** Standard MCP safety hints consumed by Codex, Claude Code and other hosts. */
  annotations: {
    title?: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
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
  ): Promise<McpToolResult> | McpToolResult;
}

/**
 * Identity helper for defining a tool with full type inference.
 * Drop a `defineTool({ ... })` object in any file under tools/ and
 * re-export it from tools/index.ts to plug a new tool into the server.
 */
export function defineTool(tool: McpTool): McpTool {
  return tool;
}

/** Expose a transport-neutral index tool over MCP with its coupled scope and hints. */
export function fromIndexTool(tool: Pick<IndexTool, 'name' | 'description' | 'tier' | 'access' | 'inputSchema'> & {
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<McpToolResult> | McpToolResult;
}): McpTool {
  const { access, ...definition } = tool;
  return defineTool({ ...definition, ...mcpAccess(access) });
}
