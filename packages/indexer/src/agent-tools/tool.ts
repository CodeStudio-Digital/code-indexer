/** Tier label of an index tool definition (bootstrap < navigate < admin). */
export type McpTier = 'bootstrap' | 'navigate' | 'admin';
import type { IndexToolContext } from './context.js';

export interface McpToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface McpSourceTruncation {
  technique: string;
  inputSize: number;
  inputSizeExact?: boolean;
  outputSize: number;
  unit: 'chars' | 'bytes' | 'lines' | 'rows' | 'items';
  recoverable: boolean;
}

export interface McpToolOutput {
  text: string;
  /** An owner lost confirmation after a mutating dispatch. Never infer failure. */
  effectOutcome?: 'unknown';
  /** Machine-readable result mirrored alongside legacy text content. */
  structuredContent?: Record<string, unknown>;
  /** Structured producer-side omission proof transported in CallToolResult._meta. */
  sourceTruncations?: McpSourceTruncation[];
}

export type McpToolResult = string | McpToolOutput;

export function normalizeMcpToolResult(result: McpToolResult): McpToolOutput {
  return typeof result === 'string' ? { text: result } : result;
}

export function mcpToolResultFields(result: McpToolOutput) {
  return {
    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
    ...(result.effectOutcome === 'unknown' ? { isError: true } : {}),
    ...(result.sourceTruncations?.length || result.effectOutcome ? { _meta: {
      ...(result.sourceTruncations?.length ? { sourceTruncations: result.sourceTruncations } : {}),
      ...(result.effectOutcome ? { effectOutcome: result.effectOutcome } : {}),
    } } : {}),
  };
}

/** Access class of an index tool; the MCP server derives scope and safety hints from it. */
export type IndexToolAccess = 'read' | 'write' | 'admin';

/** Transport-neutral index tool: no auth, scope or MCP annotations. */
export interface IndexTool {
  name: string;
  description: string;
  /** Canonical external tier. Required so an unclassified tool fails at build time. */
  tier: McpTier;
  access: IndexToolAccess;
  inputSchema: McpToolInputSchema;
  handler(args: Record<string, unknown>, ctx: IndexToolContext): Promise<McpToolResult> | McpToolResult;
}

/** Identity helper for defining an index tool with full type inference. */
export function defineTool(tool: IndexTool): IndexTool {
  return tool;
}
