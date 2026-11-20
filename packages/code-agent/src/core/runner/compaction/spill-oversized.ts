/**
 * Spill oversized `tool_result` blocks out of the live transcript.
 *
 * Used by the Compacting node when `compactWithLLM` no-ops because a single
 * MESSAGE exceeds the protected tail (`cutoff >= messages.length`): the
 * summarizer keeps the tail verbatim, so it can never shrink the message that
 * is blowing the window — the run then loops to `compact_exhausted`. The no-op
 * trigger is per-MESSAGE (`computeCutoffIndexByTokens` sums a message's blocks),
 * so we work per message: when a `role: 'tool'` message's total estimate
 * exceeds the protect budget, we spill its largest `tool_result` blocks (raw
 * content cached in the side-file store, replaced inline by a capped head +
 * `get_tool_output(id)` marker) until the message fits or no spillable block
 * remains. This covers both a single huge result AND many medium results
 * batched into one message by parallel tool calls. Pure modulo the `store.put`
 * side-effect → unit-testable.
 */
import type { AgentMessage, ContentBlock } from '@mcp/code-agent/core/messages.js';
import { estimateBlockTokens } from '@mcp/code-agent/core/token-accounting.js';
import { capToolContent, type ToolOutputSpillStore } from '../pure-helpers.js';

/** Inline head kept after spilling (fixed; no env var). */
const DEFAULT_SPILL_HEAD_CHARS = 8192;

/**
 * Char length of the inline head left behind after a spill, clamped to never
 * exceed `protectTokens`. NOTE: on realistic windows (≥128k → protectTokens
 * ≥19200) the residual head+marker is far under the protect budget; for a
 * pathologically tiny `protectTokens` (only reachable via test overrides) the
 * marker can push the residual over budget, in which case `spillOversized`'s
 * shrink guard simply leaves the block alone so the caller falls back to the
 * pre-emit irreducible bypass instead of looping.
 */
function spillHeadChars(protectTokens: number): number {
  return Math.max(256, Math.min(DEFAULT_SPILL_HEAD_CHARS, protectTokens));
}

export interface SpillOversizedResult {
  messages: AgentMessage[];
  /** Number of `tool_result` blocks spilled. */
  spilled: number;
  /** Chars removed from the transcript. */
  freedChars: number;
}

function isSpillableToolResult(b: ContentBlock): b is ContentBlock & { content: string } {
  return b.type === 'tool_result' && typeof (b as { content?: unknown }).content === 'string';
}

/**
 * Spill the largest `tool_result` blocks of any `role: 'tool'` message whose
 * total token estimate exceeds `protectTokens`, until the message fits (or no
 * spillable block remains). The input array is never mutated. `spilled === 0`
 * (and `freedChars === 0`) means nothing qualified or nothing could be freed —
 * the caller should fall back to the ordinary no-op path.
 */
export function spillOversizedToolResults(args: {
  messages: ReadonlyArray<AgentMessage>;
  protectTokens: number;
  store?: ToolOutputSpillStore;
}): SpillOversizedResult {
  const { messages, protectTokens, store } = args;
  if (!store || protectTokens <= 0) {
    return { messages: messages.slice(), spilled: 0, freedChars: 0 };
  }
  const headCap = spillHeadChars(protectTokens);
  let spilled = 0;
  let freedChars = 0;
  const out = messages.map((m): AgentMessage => {
    // tool_result blocks live in `role: 'tool'` messages in this codebase
    // (mirrors `snapCutoffPreservingPairs`). User-authored bloat is left to the
    // pre-emit irreducible bypass, which sends the request as-is.
    if (m.role !== 'tool') return m;
    let total = 0;
    for (const b of m.content) total += estimateBlockTokens(b);
    if (total <= protectTokens) return m;

    // Largest spillable blocks first — minimises how many we touch.
    const order = m.content
      .map((b, i) => ({ i, tokens: estimateBlockTokens(b), spillable: isSpillableToolResult(b) }))
      .filter((x) => x.spillable)
      .sort((a, b) => b.tokens - a.tokens);

    const replaced = new Map<number, string>(); // block index → capped content
    let remaining = total;
    for (const x of order) {
      if (remaining <= protectTokens) break;
      const text = (m.content[x.i] as { content: string }).content;
      const id = store.put(text) ?? undefined;
      const capped = capToolContent(text, headCap, id);
      // Shrink guard: skip if capping wouldn't actually free space (e.g. the
      // marker would make a near-cap block longer). Prevents a zero-progress
      // "spill" that resets the no-op streak and starves the P2 bypass.
      if (!capped.truncated || capped.content.length >= text.length) continue;
      replaced.set(x.i, capped.content);
      freedChars += text.length - capped.content.length;
      spilled += 1;
      // Recompute this block's real post-spill weight (exact, no approximation).
      remaining = remaining - x.tokens + estimateBlockTokens({ ...(m.content[x.i] as ContentBlock), content: capped.content } as ContentBlock);
    }
    if (replaced.size === 0) return m;
    const content = m.content.map((b, i): ContentBlock =>
      replaced.has(i) ? ({ ...b, content: replaced.get(i)! } as ContentBlock) : b,
    );
    return { ...m, content };
  });
  return { messages: out, spilled, freedChars };
}
