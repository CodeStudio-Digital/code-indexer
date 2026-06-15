import type { AgentMessage } from '@mcp/code-agent/core/messages.js';

/**
 * Coarse character count over a transcript. Adds a fixed per-block
 * overhead and counts string fields on `content` / `text` / `input`.
 * NOT exact tokens, but good enough as a budget gauge.
 */
export function approxChars(messages: AgentMessage[]): number {
  let total = 0;
  for (const m of messages) {
    for (const b of m.content) {
      total += 32; // per-block overhead estimate
      if (typeof (b as { content?: unknown }).content === 'string') {
        total += ((b as { content: string }).content).length;
      }
      if (typeof (b as { text?: unknown }).text === 'string') {
        total += ((b as { text: string }).text).length;
      }
      if (typeof (b as { input?: unknown }).input === 'object' && (b as { input?: unknown }).input) {
        try { total += JSON.stringify((b as { input: unknown }).input).length; } catch { /* ignore */ }
      }
    }
  }
  return total;
}

/**
 * Decide whether a tool result should be spilled to the side-file store
 * (`ToolOutputStore`) so the agent can recover the full content later via
 * `get_tool_output(id)`. Two triggers:
 *
 *   1. **Size**: content exceeds the push-time cap (would otherwise be
 *      truncated to head + marker by buildToolResultBlock).
 *   2. **Failure**: the call returned an error, regardless of size.
 *      Short failure lines ("FAILED tests/foo.py::bar") routinely hide
 *      the full stack trace behind a smart-reducer or truncation marker
 *      — preserving the raw output unconditionally on isError lets the
 *      agent inspect the trace without rerunning the failing command.
 *
 * Extracted from the runner's tool-dispatch loop (around the
 * `toolResultBlocks.push(buildToolResultBlock(...))` site) to keep the
 * spill condition independently testable. Pure function — caller still
 * gates on `toolOutputStore` availability separately.
 */
export function shouldSpillToolOutput(
  result: { content: string; isError?: boolean },
  cap: number,
): boolean {
  return result.content.length > cap || !!result.isError;
}

/**
 * Pure head-cut + deterministic truncation marker. Shared by
 * `buildToolResultBlock` (resume) and `finalizeToolOutput` (live) so both
 * produce byte-identical truncation. The marker depends only on the original
 * size + outputId (a content hash) — stable across turns, preserving
 * prefix-cache stability.
 */
export function capToolContent(
  content: string,
  cap: number,
  outputId?: string,
): { content: string; truncated: boolean; originalSize?: number } {
  if (content.length <= cap) return { content, truncated: false };
  const head = content.slice(0, cap);
  const idSuffix = outputId
    ? `; output_id=${outputId}, call get_tool_output("${outputId}") to retrieve the full content (supports offset/limit for pagination)`
    : '';
  return {
    content:
      head +
      `\n\n[truncated: original_size=${content.length} chars; ${content.length - cap} chars elided — call the tool again with narrower params if needed, OR use 'spawn_agent' (with an explore agent) to delegate this exploration without bloating your main context window${idSuffix}]`,
    truncated: true,
    originalSize: content.length,
  };
}

/** Minimal structural view of the side-file store (avoids importing the class). */
export interface ToolOutputSpillStore {
  put(content: string): string | null;
}

/**
 * Live final shaping for a tool result. Spills the RAW pre-reduction original
 * to `store` (so reducer/cap elisions are recoverable via `get_tool_output`)
 * and applies the generic fail-safe cap to the SHAPED content, embedding the
 * output_id in the marker. Pure modulo the `store.put` side-effect, so the
 * spill+cap composition is unit-testable. When `store` is absent the fail-safe
 * cap still applies; nothing is spilled.
 */
export function finalizeToolOutput(args: {
  rawContent: string;
  shapedContent: string;
  isError: boolean;
  cap: number;
  store?: ToolOutputSpillStore;
}): { content: string; truncated?: boolean; originalSize?: number } {
  const { rawContent, shapedContent, isError, cap, store } = args;
  let outputId: string | undefined;
  if (store && shouldSpillToolOutput({ content: rawContent, isError }, cap)) {
    outputId = store.put(rawContent) ?? undefined;
  }
  const capped = capToolContent(shapedContent, cap, outputId);
  if (capped.truncated) {
    return { content: capped.content, truncated: true, originalSize: capped.originalSize };
  }
  // Shaped content fits the cap but a reducer (e.g. json-crush) dropped rows
  // from the spilled original — advertise the output_id so they're recoverable
  // (length-guarded so the note never pushes us back over the cap).
  if (outputId && rawContent.length > shapedContent.length) {
    const note = `\n[reduced: full output cached — call get_tool_output("${outputId}") for the elided rows]`;
    if (shapedContent.length + note.length <= cap) {
      return { content: shapedContent + note };
    }
  }
  return { content: capped.content };
}
