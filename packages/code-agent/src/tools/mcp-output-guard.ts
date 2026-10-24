import type {
  CoderTool,
  ToolContext,
  ToolResult,
  ToolSourceTruncation,
} from '@mcp/code-agent/core/tool.js';
import { capToolContent } from '@mcp/code-agent/core/runner/pure-helpers.js';
export const MCP_PATHOLOGICAL_OUTPUT_CHARS = 8_000_000;

export const MCP_PATHOLOGICAL_STORE_MAX_CHARS = 32_000_000;


/** Last-resort guard for a broken/hostile MCP server. */
export function guardPathologicalMcpOutputDetailed(
  text: string,
  ctx: ToolContext,
  pathologicalCap = MCP_PATHOLOGICAL_OUTPUT_CHARS,
): { content: string; sourceTruncations?: ToolSourceTruncation[] } {
  const guardCap = Number.isFinite(pathologicalCap) && pathologicalCap > 0
    ? Math.floor(pathologicalCap)
    : 8_000_000;
  if (text.length <= guardCap) return { content: text };
  const outputId = text.length <= MCP_PATHOLOGICAL_STORE_MAX_CHARS
    ? ctx.toolOutputStore?.put(text) ?? undefined
    : undefined;
  const contextualCap = ctx.toolOutputInlineCap;
  const inlineCap = Math.max(1, Math.min(
    guardCap,
    typeof contextualCap === 'number' && Number.isFinite(contextualCap) && contextualCap > 0
      ? Math.floor(contextualCap)
      : guardCap,
  ));
  const content = capToolContent(
    text,
    inlineCap,
    outputId,
    'mcp_pathological_output',
    'head_tail',
    'output_store',
    text.length,
  ).content;
  return {
    content,
    sourceTruncations: [{
      technique: 'mcp-pathological-guard',
      inputSize: text.length,
      outputSize: content.length,
      unit: 'chars',
      recoverable: !!outputId,
      ...(outputId ? { outputId } : {}),
    }],
  };
}


export function guardPathologicalMcpOutput(
  text: string,
  ctx: ToolContext,
  pathologicalCap = MCP_PATHOLOGICAL_OUTPUT_CHARS,
): string {
  return guardPathologicalMcpOutputDetailed(text, ctx, pathologicalCap).content;
}


export function guardMcpToolResult(
  result: ToolResult,
  ctx: ToolContext,
  additional: ToolSourceTruncation[] = [],
): ToolResult {
  const guarded = guardPathologicalMcpOutputDetailed(result.content, ctx);
  const sourceTruncations = [
    ...(result.sourceTruncations ?? []),
    ...additional,
    ...(guarded.sourceTruncations ?? []),
  ];
  return {
    ...result,
    content: guarded.content,
    ...(sourceTruncations.length > 0 ? { sourceTruncations } : {}),
  };
}
