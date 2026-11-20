import { mcpToolResultFields, normalizeMcpToolResult, type McpToolResult } from './tool.js';
import { coerceArgs } from './utils.js';

/** The CallToolResult the MCP server sends for one call. */
export interface IndexToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

interface CallableTool<C> {
  handler(args: Record<string, unknown>, ctx: C): Promise<McpToolResult> | McpToolResult;
}

/**
 * One tool call exactly as the stdio server answers it: string scalars coerced,
 * cancellation checked around the handler, and any throw reported as an
 * `Error: <message>` result. Shared by the server and in-process callers.
 */
export async function callIndexTool<C extends { signal?: AbortSignal }>(
  tool: CallableTool<C> | undefined,
  name: string,
  rawArgs: Record<string, unknown> | undefined,
  ctx: C,
): Promise<IndexToolCallResult> {
  if (!tool) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  try {
    const args = coerceArgs((rawArgs ?? {}) as Record<string, unknown>);
    ctx.signal?.throwIfAborted();
    const result = normalizeMcpToolResult(await tool.handler(args, ctx));
    ctx.signal?.throwIfAborted();
    return {
      content: [{ type: 'text', text: result.text }],
      ...mcpToolResultFields(result),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }
}
