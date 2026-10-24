import { err, type ToolResult } from '@mcp/code-agent/core/tool.js';

export function docPageArgs(args: Record<string, unknown>, defaultLimit: number, maxLimit: number): { offset: number; limit: number } | { error: ToolResult } {
  const offset = args.offset == null ? 0 : Number(args.offset), limit = args.limit == null ? defaultLimit : Number(args.limit);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) return { error: err('offset must be a non-negative integer and limit a positive integer') };
  return { offset, limit: Math.min(limit, maxLimit) };
}
