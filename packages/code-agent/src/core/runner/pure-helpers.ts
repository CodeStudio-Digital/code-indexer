import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { ReductionReport } from '@mcp/code-agent/core/smart-reducers.js';

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
  toolName?: string,
): { content: string; truncated: boolean; originalSize?: number; preserved?: string[] } {
  if (content.length <= cap) return { content, truncated: false };
  const safeCap = Number.isFinite(cap) && cap > 0 ? Math.max(1, Math.floor(cap)) : 1;
  const marker = outputId
    ? `\n[truncated: output_id=${outputId}; original_size=${content.length}; use get_tool_output]\n`
    : `\n[truncated: original_size=${content.length}]\n`;

  const fitHeadTail = (value: string, budget: number): { value: string; preserved: string[] } => {
    if (marker.length >= budget) return { value: marker.slice(0, budget), preserved: ['metadata'] };
    const room = budget - marker.length;
    const headRoom = Math.ceil(room * 0.55);
    const tailRoom = Math.max(0, room - headRoom);
    return {
      value: value.slice(0, headRoom) + marker + (tailRoom > 0 ? value.slice(-tailRoom) : ''),
      preserved: ['head', 'tail'],
    };
  };

  let shaped: { value: string; preserved: string[] };
  if (toolName === 'code_exec') {
    const returnMarker = '\n[return]\n';
    const returnAt = content.lastIndexOf(returnMarker);
    if (returnAt >= 0 && marker.length < safeCap) {
      const header = content.slice(0, content.indexOf('\n') >= 0 ? content.indexOf('\n') : Math.min(content.length, 256));
      const errorLines = content.slice(0, returnAt).split('\n')
        .filter((line) => /\b(error|failed?|exception|stderr|stack)\b/i.test(line))
        .slice(-8)
        .join('\n');
      const base = `${header}${marker}`;
      const maxErrorChars = Math.max(
        0,
        Math.min(Math.floor(safeCap * 0.25), safeCap - base.length - returnMarker.length - 11),
      );
      const errorBlock = errorLines && maxErrorChars > 0
        ? `\n[errors]\n${errorLines.slice(-maxErrorChars)}\n`
        : '';
      const fixed = `${base}${errorBlock}${returnMarker}`;
      const room = Math.max(0, safeCap - fixed.length);
      const returnPayload = content.slice(returnAt + returnMarker.length);
      const payloadMarker = '\n[…return middle elided…]\n';
      const payload = returnPayload.length <= room
        ? returnPayload
        : room <= payloadMarker.length
          ? returnPayload.slice(0, room)
          : returnPayload.slice(0, Math.ceil((room - payloadMarker.length) * 0.55))
            + payloadMarker
            + returnPayload.slice(-Math.floor((room - payloadMarker.length) * 0.45));
      shaped = {
        value: (fixed + payload).slice(0, safeCap),
        preserved: errorBlock ? ['header', 'errors', 'return', 'return_head', 'return_tail'] : ['header', 'return', 'return_head', 'return_tail'],
      };
    } else {
      shaped = fitHeadTail(content, safeCap);
    }
  } else if (toolName === 'spawn_agent') {
    const starts = [...content.matchAll(/^### Agent \d+:/gm)].map((m) => m.index ?? 0);
    if (starts.length > 1 && marker.length < safeCap) {
      const header = content.slice(0, starts[0]);
      const sections = starts.map((start, i) => content.slice(start, starts[i + 1] ?? content.length));
      const fixedHeader = header.slice(0, Math.min(header.length, Math.floor(safeCap * 0.15)));
      const room = Math.max(0, safeCap - fixedHeader.length - marker.length - Math.max(0, sections.length - 1) * 2);
      const quota = Math.floor(room / sections.length);
      const balanced = sections.map((section) => {
        if (section.length <= quota) return section;
        const sectionMarker = '\n[…agent section elided…]\n';
        if (quota <= sectionMarker.length) return section.slice(0, quota);
        const available = quota - sectionMarker.length;
        const head = Math.ceil(available * 0.6);
        return section.slice(0, head) + sectionMarker + section.slice(-(available - head));
      });
      shaped = {
        value: fixedHeader + marker + balanced.join('\n\n'),
        preserved: ['header', 'all_agent_sections', 'section_head', 'section_tail'],
      };
    } else {
      shaped = fitHeadTail(content, safeCap);
    }
  } else {
    shaped = fitHeadTail(content, safeCap);
  }
  return {
    content: shaped.value.slice(0, safeCap),
    truncated: true,
    originalSize: content.length,
    preserved: shaped.preserved,
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
  toolName?: string;
  rawContent: string;
  shapedContent: string;
  isError: boolean;
  cap: number;
  store?: ToolOutputSpillStore;
  reductionReport?: ReductionReport;
}): { content: string; truncated?: boolean; originalSize?: number; outputId?: string; reductionReport: ReductionReport } {
  const { rawContent, shapedContent, isError, cap, store, toolName } = args;
  let outputId: string | undefined;
  if (store && (shouldSpillToolOutput({ content: rawContent, isError }, cap) || rawContent.length > shapedContent.length)) {
    outputId = store.put(rawContent) ?? undefined;
  }
  const capped = capToolContent(shapedContent, cap, outputId, toolName);
  const baseReport: ReductionReport = args.reductionReport ?? {
    kind: 'none',
    technique: 'none',
    rawChars: rawContent.length,
    shapedChars: shapedContent.length,
    cap,
    preserved: [],
  };
  if (capped.truncated) {
    return {
      content: capped.content,
      truncated: true,
      originalSize: capped.originalSize,
      outputId,
      reductionReport: {
        ...baseReport,
        kind: 'hard_cap',
        technique: toolName ? `hard-cap:${toolName}` : 'hard-cap:generic',
        shapedChars: capped.content.length,
        preserved: capped.preserved ?? ['head', 'tail'],
        ...(outputId ? { outputId } : {}),
      },
    };
  }
  // Shaped content fits the cap but a reducer (e.g. json-crush) dropped rows
  // from the spilled original — advertise the output_id so they're recoverable
  // (length-guarded so the note never pushes us back over the cap).
  if (outputId && rawContent.length > shapedContent.length) {
    const note = `\n[reduced: full output cached — call get_tool_output("${outputId}") for the elided rows]`;
    if (shapedContent.length + note.length <= cap) {
      const content = shapedContent + note;
      return {
        content,
        outputId,
        reductionReport: { ...baseReport, shapedChars: content.length, outputId },
      };
    }
  }
  return {
    content: capped.content,
    outputId,
    reductionReport: {
      ...baseReport,
      shapedChars: capped.content.length,
      ...(outputId ? { outputId } : {}),
    },
  };
}
