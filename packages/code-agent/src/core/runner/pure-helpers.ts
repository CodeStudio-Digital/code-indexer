import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { ReductionReport, ReductionStage } from '@mcp/code-agent/core/smart-reducers.js';
import type { ResolvedToolOutputPolicy } from '@mcp/code-agent/core/tool-output-policy.js';
import type { ToolSourceTruncation } from '@mcp/code-agent/core/tool.js';
import { stripUnpairedSurrogates } from '@mcp/code-agent/core/text-boundaries.js';

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
  capStrategy: 'head_tail' | 'contiguous' = 'head_tail',
  recovery?: ResolvedToolOutputPolicy['recovery'],
  sourceSize?: number,
): { content: string; truncated: boolean; originalSize?: number; preserved?: string[] } {
  if (content.length <= cap) return { content, truncated: false };
  const safeCap = Number.isFinite(cap) && cap > 0 ? Math.max(1, Math.floor(cap)) : 1;
  const preferredRecovery = recovery === 'cursor'
    ? toolName === 'read_file' || toolName?.endsWith('__read_file')
      ? 'retry with narrower start_line/end_line'
      : toolName === 'get_tool_output'
        ? 'request the next offset/limit page'
        : 'retry with a narrower cursor or range'
    : recovery === 'section'
      ? 'request a narrower section'
      : recovery === 'rerun'
        ? 'rerun with narrower arguments'
        : null;
  const originalSize = sourceSize ?? content.length;
  const shapedSize = originalSize !== content.length ? `; shaped_size=${content.length}` : '';
  const marker = outputId
    ? `\n[truncated: output_id=${outputId}; original_size=${originalSize}${shapedSize}; ${preferredRecovery ? `prefer ${preferredRecovery}; ` : ''}exact fallback: get_tool_output]\n`
    : `\n[truncated: original_size=${originalSize}${shapedSize}; ${preferredRecovery ?? (recovery === 'output_store' ? 'output store unavailable in this context — do not blindly rerun mutations' : 'no recovery available')}]\n`;

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
  if (capStrategy === 'contiguous') {
    if (marker.length >= safeCap) {
      shaped = { value: marker.slice(0, safeCap), preserved: ['metadata'] };
    } else {
      shaped = {
        value: content.slice(0, safeCap - marker.length) + marker,
        preserved: ['contiguous_prefix'],
      };
    }
  } else if (toolName === 'code_exec') {
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
    content: stripUnpairedSurrogates(shaped.value.slice(0, safeCap)),
    truncated: true,
    originalSize,
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
  policy?: ResolvedToolOutputPolicy;
  sourceTruncations?: ToolSourceTruncation[];
}): { content: string; truncated?: boolean; originalSize?: number; outputId?: string; inlineCap: number; reductionReport: ReductionReport } {
  const { rawContent, shapedContent, isError, cap, store, toolName, policy } = args;
  // A producer may already have persisted the exact pre-cap source (notably
  // the MCP pathological guard). Reuse that id as the authoritative recovery
  // target; storing the producer's preview would create a snapshot-of-snapshot.
  const completeSource = args.sourceTruncations?.find(
    (source) => source.recoverable && source.outputId,
  );
  const sourceOutputId = completeSource?.outputId;
  const originalChars = completeSource?.unit === 'chars'
    ? Math.max(rawContent.length, completeSource.inputSize)
    : rawContent.length;
  let outputId: string | undefined = sourceOutputId;
  let didSpill = false;
  // A page already points at its source output id. Spilling that page creates
  // recovery-of-recovery chains and must never happen.
  const recoveryPage = toolName === 'get_tool_output';
  const preserveError = policy?.preserveOnError ?? true;
  // `recovery` is the preferred UX, not permission to discard the snapshot.
  // Spill only when information was actually lost, but keep that exact fallback
  // for cursor/rerun/section tools too: a single huge line, a mutating query,
  // or a bad third-party page cannot always be reproduced safely. `none` is
  // the only explicit opt-out. get_tool_output already references its source.
  const outputStoreRecovery = policy?.recovery !== 'none';
  const shouldSpill = rawContent.length > cap
    || rawContent.length > shapedContent.length
    || (isError && preserveError);
  if (!outputId && store && !recoveryPage && outputStoreRecovery && shouldSpill) {
    outputId = store.put(rawContent) ?? undefined;
    didSpill = !!outputId;
  }
  const capped = capToolContent(
    shapedContent,
    cap,
    outputId,
    toolName,
    policy?.capStrategy ?? 'head_tail',
    policy?.recovery,
    originalChars,
  );
  const initialReport: ReductionReport = args.reductionReport ?? {
    kind: 'none',
    technique: 'none',
    rawChars: rawContent.length,
    shapedChars: shapedContent.length,
    cap,
    preserved: [],
    stages: [],
  };
  const sourceStages: ReductionStage[] = (args.sourceTruncations ?? []).map((source) => ({
    stage: 'source_cap',
    technique: source.technique,
    inputChars: source.inputSize,
    outputChars: source.outputSize,
    recoverable: source.recoverable,
    source,
  }));
  const sourceTechnique = sourceStages.length > 0
    ? new Set(sourceStages.map((stage) => stage.technique)).size === 1
      ? sourceStages[0].technique
      : 'source-cap:multiple'
    : null;
  const baseReport: ReductionReport = sourceTechnique && initialReport.kind === 'none'
    ? { ...initialReport, kind: 'source_cap', technique: sourceTechnique }
    : initialReport;
  const stages = [
    ...sourceStages,
    ...(baseReport.stages ?? []),
  ];
  if (didSpill) {
    stages.push({
      stage: 'spill',
      technique: 'tool-output-store',
      inputChars: rawContent.length,
      outputChars: rawContent.length,
      recoverable: true,
    });
  }
  if (capped.truncated) {
    stages.push({
      stage: 'hard_cap',
      technique: toolName ? `hard-cap:${toolName}` : 'hard-cap:generic',
      inputChars: shapedContent.length,
      outputChars: capped.content.length,
      recoverable: !!outputId
        || policy?.recovery === 'cursor'
        || policy?.recovery === 'section'
        || policy?.recovery === 'rerun',
    });
    return {
      content: capped.content,
      truncated: true,
      originalSize: capped.originalSize,
      outputId,
      inlineCap: cap,
      reductionReport: {
        ...baseReport,
        kind: 'hard_cap',
        technique: toolName ? `hard-cap:${toolName}` : 'hard-cap:generic',
        shapedChars: capped.content.length,
        preserved: capped.preserved ?? ['head', 'tail'],
        stages,
        policyMode: policy?.mode,
        recovery: policy?.recovery,
        ...(outputId ? { outputId } : {}),
      },
    };
  }
  // Shaped content fits the cap but a reducer (e.g. json-crush) dropped rows
  // from the spilled original — advertise the output_id so they're recoverable
  // (length-guarded so the note never pushes us back over the cap).
  if (outputId && rawContent.length > shapedContent.length) {
    const preferred = policy?.recovery === 'cursor'
      ? toolName === 'read_file' || toolName?.endsWith('__read_file')
        ? 'prefer narrower start_line/end_line; '
        : 'prefer a narrower cursor/range; '
      : policy?.recovery === 'rerun'
        ? 'prefer rerunning with narrower arguments; '
        : policy?.recovery === 'section'
          ? 'prefer requesting a narrower section; '
          : '';
    const note = `\n[reduced: ${preferred}exact snapshot: get_tool_output("${outputId}") for elided content]`;
    const room = Math.max(0, cap - note.length);
    const visible = shapedContent.length <= room
      ? shapedContent
      : policy?.capStrategy === 'contiguous'
        ? shapedContent.slice(0, room)
        : shapedContent.slice(0, Math.ceil(room * 0.55))
          + shapedContent.slice(-Math.floor(room * 0.45));
    const content = note.length >= cap
      ? note.slice(0, cap)
      : stripUnpairedSurrogates(visible) + note;
    if (visible.length < shapedContent.length) {
      stages.push({
        stage: 'recovery_marker',
        technique: 'reserve-output-id-marker',
        inputChars: shapedContent.length,
        outputChars: content.length,
        recoverable: true,
      });
    }
    return {
      content,
      outputId,
      inlineCap: cap,
      reductionReport: {
        ...baseReport,
        shapedChars: content.length,
        outputId,
        stages,
        policyMode: policy?.mode,
        recovery: policy?.recovery,
      },
    };
  }
  return {
    content: capped.content,
    outputId,
    inlineCap: cap,
    reductionReport: {
      ...baseReport,
      shapedChars: capped.content.length,
      stages,
      policyMode: policy?.mode,
      recovery: policy?.recovery,
      ...(outputId ? { outputId } : {}),
    },
  };
}
