/**
 * Auto-compaction for the coder agent's message history.
 *
 * Complements (does NOT replace) push-time tool_result truncation:
 *
 *   push-time truncation → every tool_result block is capped at creation,
 *                          preserving prefix cache within a session.
 *
 *   auto-compaction      → when the running total still overflows the
 *                          context window (e.g. hundreds of small cached
 *                          reads that individually fit the cap but add up
 *                          to 80k+ chars), replace the *content* of older
 *                          tool_result blocks with a deterministic marker.
 *
 * Determinism matters: compaction is applied per-turn by `compactHistoryForLLM`
 * and MUST produce the same output for the same prefix on every call, or we
 * bust server-side prompt caches. The rule is:
 *
 *   1. If total chars < PRUNE_MINIMUM → pass through unchanged (fast path).
 *   2. Walk backwards from the tail and sum chars until we've accounted for
 *      PRUNE_PROTECT worth of recent content. That index becomes `cutoff`.
 *   3. Every tool_result block strictly before `cutoff` has its content
 *      replaced with `[compacted: original_size=N]`. Everything at or after
 *      `cutoff` is kept verbatim.
 *
 * Because step 2 walks from the tail and the tail contents are stable
 * between adjacent turns (push-time cap + append-only semantics), the
 * computed cutoff advances monotonically — so compaction never "un-compacts"
 * a block it already pruned.
 *
 * What we DO NOT do here:
 *   - Call an LLM to summarize the pruned region. opencode does this, but
 *     it's expensive and error-prone on resume. We may add it in a follow-up
 *     once we have usage data showing it's worth the cost.
 *   - Touch non-tool_result blocks. Assistant text and user messages are
 *     always preserved; only tool outputs are pruned.
 *   - Mutate the persistent history. Compaction is per-turn transformation;
 *     the full transcript stays in the DB so the dashboard can display it.
 */

import type { AgentMessage, ContentBlock } from '@mcp/code-agent/core/messages.js';
import { estimateMessageTokens } from '@mcp/code-agent/core/token-accounting.js';
import type { TokenSnapshot } from '@mcp/code-agent/core/token-accounting.js';
import { getEffectiveContextWindow } from '@mcp/code-agent/providers/capabilities.js';

/**
 * Below this char total, auto-compaction is a no-op. Default 60k — fallback
 * for models without a known context_window. Use deriveCompactionLimits() to
 * get model-aware thresholds when context_window is available.
 *
 * @deprecated Char-based thresholds are retained only for the legacy code
 * path (CODER_NEW_COMPACTION=0). New path uses token-based limits derived
 * from the model's effective context window. Will be removed.
 */
export const PRUNE_MINIMUM = Number(process.env.CODER_PRUNE_MINIMUM ?? 60_000);

/**
 * How many chars of the most-recent history are guaranteed to survive
 * compaction verbatim when using the fixed fallback. Use deriveCompactionLimits()
 * for model-aware protection budgets.
 *
 * @deprecated See PRUNE_MINIMUM.
 */
export const PRUNE_PROTECT = Number(process.env.CODER_PRUNE_PROTECT ?? 80_000);

/** Fraction of context window (in chars) at which compaction triggers. */
const TRIGGER_RATIO = 0.90;
/** Fraction of context window (in chars) kept verbatim after compaction. */
const PROTECT_RATIO = 0.55;
/** chars-per-token heuristic, matching token-budget.ts. */
const CHARS_PER_TOKEN = 4;

// ─── Token-based triggers (new path) ────────────────────────────────────────
//
// Reasoning for these numbers (mirrors Claude Code's autoCompact constants):
//
//   AUTOCOMPACT_BUFFER_TOKENS = 13_000
//     Reserve 13K tokens of headroom below the effective window before we
//     trigger compaction. The model needs room to run at least one more
//     tool-emitting turn while we're summarising, so we can't pack right
//     to the edge.
//
//   PROTECT_TOKEN_RATIO = 0.55
//     After compaction the most-recent N messages adding up to ~55% of the
//     effective window are kept verbatim. Empirically the right tradeoff
//     between losing recent context and freeing enough room.
//
// Both are env-overridable so we can tune in the field without a release.

export const AUTOCOMPACT_BUFFER_TOKENS = Number(process.env.CODER_AUTOCOMPACT_BUFFER ?? 50_000);
export const PROTECT_TOKEN_RATIO = Number(process.env.CODER_PROTECT_RATIO ?? 0.55);

/**
 * Phase D — multidimensional compaction triggers.
 *
 * The primary `trigger` (effective − BUFFER) is per-turn: if THIS turn's
 * prompt is bigger than the threshold, compact. That works for sessions
 * that grow steadily, but missed session 763 (`list_subordinates` polling
 * loop) — each individual turn stayed under 200k tokens (below the 206k
 * trigger for a 272k-window model) yet 535 turns burned 58M cumulative.
 *
 * Three additional triggers, OR-combined:
 *
 *  1. CUMULATIVE — `totalInputTokens > effective × CUMULATIVE_RATIO`.
 *     A session that consumed >N effective-window-worths of input has
 *     spent enough; compact even if the current turn fits.
 *
 *  2. POLLING-AWARE — when Phase C detects polling-loop tendency,
 *     compaction runs at `trigger × POLLING_TRIGGER_RATIO` instead of
 *     the full trigger. The loop benefits from compaction *more* than
 *     a healthy session because the summary surfaces "tool X called
 *     N× with no progress" to the model.
 *
 *  3. STUCK-PROGRESS — N consecutive turns without any assistant text
 *     (only tool calls) indicates the model has stopped reasoning and
 *     is mechanically poking tools. Force compact so the summary
 *     re-anchors intent.
 */
export const COMPACT_CUMULATIVE_RATIO = Number(
  process.env.CODER_COMPACT_CUMULATIVE_RATIO ?? 10,
);
export const COMPACT_POLLING_TRIGGER_RATIO = Number(
  process.env.CODER_COMPACT_POLLING_TRIGGER_RATIO ?? 0.5,
);
export const COMPACT_STUCK_TURN_CAP = Number(
  process.env.CODER_COMPACT_STUCK_TURN_CAP ?? 8,
);

/**
 * Pure inputs for the trigger decision. Pass `null` for branches that
 * don't apply (e.g., `snapshotTotal: null` when on the legacy char path).
 */
export interface CompactionTriggerInputs {
  /** Token-mode primary path (null when legacy / no model). */
  snapshotTotal: number | null;
  trigger: number | null;
  effective: number | null;
  /** Legacy char-mode fallback. */
  charTotal: number;
  charMinimum: number;
  legacyTriggerTokens: number | null;
  lastKnownInputTokens: number | null;
  /** Phase D inputs. */
  cumulativeInputTokens: number;
  pollingLoopDetected: boolean;
  consecutiveNoTextTurns: number;
  /** Tunables (callable passes these so tests can override). */
  cumulativeRatio: number;
  pollingTriggerRatio: number;
  stuckTurnCap: number;
}

export interface CompactionTriggerDecision {
  shouldCompact: boolean;
  /** Which branch fired, or 'none' when no branch triggered. */
  reason:
    | 'token-budget'
    | 'char-budget'
    | 'cumulative'
    | 'polling-loop'
    | 'stuck-progress'
    | 'none';
  /** Human-readable string for the runner's compaction log line. */
  detail: string;
}

/**
 * Multidimensional compaction trigger. Used by the runner to decide
 * whether to invoke the LLM summarizer before this turn. Pure function —
 * deterministic given the same inputs, no side effects.
 *
 * Evaluation order:
 *   1. polling-aware (lowest threshold — fires earliest in loops)
 *   2. stuck-progress (independent of token count — catches no-reasoning)
 *   3. cumulative (independent of per-turn — catches steady burn)
 *   4. primary token-budget (existing behaviour)
 *   5. legacy char-budget (existing fallback)
 *
 * The first matching branch wins, but all branches are checked so
 * future telemetry can report which trigger would've fired even if a
 * higher-priority one already did.
 */
export function computeCompactionTrigger(
  inp: CompactionTriggerInputs,
): CompactionTriggerDecision {
  // Reference token threshold for the cumulative + polling-aware
  // checks. Prefer the token-mode `trigger`; fall back to a tokenized
  // estimate of the char minimum (4 chars/token heuristic).
  const refTrigger =
    inp.trigger != null
      ? inp.trigger
      : inp.legacyTriggerTokens != null
        ? inp.legacyTriggerTokens
        : Math.floor(inp.charMinimum / CHARS_PER_TOKEN);
  const refEffective =
    inp.effective != null
      ? inp.effective
      : refTrigger > 0 ? refTrigger + AUTOCOMPACT_BUFFER_TOKENS : null;

  // 1. polling-aware: when loop tendency detected, lower the threshold.
  if (inp.pollingLoopDetected && inp.snapshotTotal != null && refTrigger > 0) {
    const loweredTrigger = Math.floor(refTrigger * inp.pollingTriggerRatio);
    if (inp.snapshotTotal >= loweredTrigger) {
      return {
        shouldCompact: true,
        reason: 'polling-loop',
        detail: `polling loop detected; tokens=${inp.snapshotTotal} ≥ ${loweredTrigger} (lowered from ${refTrigger} via ratio ${inp.pollingTriggerRatio})`,
      };
    }
  }

  // 2. stuck-progress: independent of token size. `stuckTurnCap <= 0`
  // disables this branch (operator escape via env var = 0).
  if (inp.stuckTurnCap > 0 && inp.consecutiveNoTextTurns >= inp.stuckTurnCap) {
    return {
      shouldCompact: true,
      reason: 'stuck-progress',
      detail: `${inp.consecutiveNoTextTurns} consecutive turns with zero assistant text (cap ${inp.stuckTurnCap})`,
    };
  }

  // 3. cumulative: catches sessions that burn many small contexts.
  // `cumulativeRatio <= 0` disables this branch (operator escape).
  if (inp.cumulativeRatio > 0 && refEffective != null && refEffective > 0) {
    const cumulativeThreshold = refEffective * inp.cumulativeRatio;
    if (inp.cumulativeInputTokens >= cumulativeThreshold) {
      return {
        shouldCompact: true,
        reason: 'cumulative',
        detail: `cumulative input tokens ${inp.cumulativeInputTokens} ≥ ${cumulativeThreshold} (${inp.cumulativeRatio}× effective window ${refEffective})`,
      };
    }
  }

  // 4. primary token-budget (existing behaviour).
  if (inp.snapshotTotal != null && inp.trigger != null) {
    if (inp.snapshotTotal >= inp.trigger) {
      return {
        shouldCompact: true,
        reason: 'token-budget',
        detail: `tokens=${inp.snapshotTotal} ≥ trigger ${inp.trigger}`,
      };
    }
  }

  // 5. legacy char-budget fallback.
  if (inp.snapshotTotal == null) {
    const fired =
      inp.legacyTriggerTokens != null && inp.lastKnownInputTokens != null
        ? inp.lastKnownInputTokens >= inp.legacyTriggerTokens
        : inp.charTotal > inp.charMinimum;
    if (fired) {
      return {
        shouldCompact: true,
        reason: 'char-budget',
        detail: inp.lastKnownInputTokens != null
          ? `legacy tokens=${inp.lastKnownInputTokens} ≥ ${inp.legacyTriggerTokens}`
          : `legacy chars=${inp.charTotal} > minimum ${inp.charMinimum}`,
      };
    }
  }

  return { shouldCompact: false, reason: 'none', detail: '' };
}

/** Feature flag — set to 0 to fall back to the legacy char-based path. */
export function isNewCompactionEnabled(): boolean {
  return process.env.CODER_NEW_COMPACTION !== '0';
}

export interface CompactionLimits {
    /** Char total above which compaction is triggered (char-based fallback). */
    minimum: number;
    /** How many recent chars to keep verbatim during compaction. */
    protect: number;
    /** Input-token count above which compaction is triggered (null = no known context_window). */
    triggerTokens: number | null;
    /** Token budget for the protected tail (null = no known context_window). */
    protectTokens: number | null;
}

/**
 * Derive context-aware compaction limits from the model's known context window.
 * When contextWindowTokens is null/undefined, falls back to the hardcoded env
 * defaults so behaviour is unchanged for models without registered capacity.
 *
 * Note: when the new path is enabled, prefer `deriveTokenLimits(model)` which
 * incorporates output reservation. This shim is kept for the legacy path and
 * for code that only has a token count, not a model id.
 */
export function deriveCompactionLimits(contextWindowTokens: number | null | undefined): CompactionLimits {
    if (!contextWindowTokens) {
        return { minimum: PRUNE_MINIMUM, protect: PRUNE_PROTECT, triggerTokens: null, protectTokens: null };
    }
    const contextChars = contextWindowTokens * CHARS_PER_TOKEN;
    return {
        minimum: Math.floor(contextChars * TRIGGER_RATIO),
        protect: Math.floor(contextChars * PROTECT_RATIO),
        triggerTokens: Math.floor(contextWindowTokens * TRIGGER_RATIO),
        protectTokens: Math.floor(contextWindowTokens * PROTECT_TOKEN_RATIO),
    };
}

export interface TokenLimits {
    /** Effective context window (raw window − reserved output). */
    effective: number;
    /** Trigger compaction when total tokens ≥ this. = effective − buffer. */
    trigger: number;
    /** Tokens of recent tail to protect verbatim during compaction. */
    protect: number;
    /** Raw context window before output reservation (for telemetry). */
    rawWindow: number;
    /** True when we used the fallback (no registry/prefix entry). */
    isFallback: boolean;
}

/**
 * Token-based compaction limits derived from the effective window.
 *
 *   effective = window − min(max_output, 20K)
 *   trigger   = effective − 13K        (autocompact buffer)
 *   protect   = floor(effective * 0.55)
 */
export function deriveTokenLimits(model: string): TokenLimits {
  const eff = getEffectiveContextWindow(model);
  return {
    effective: eff.effective,
    trigger: Math.max(1, eff.effective - AUTOCOMPACT_BUFFER_TOKENS),
    protect: Math.max(1, Math.floor(eff.effective * PROTECT_TOKEN_RATIO)),
    rawWindow: eff.window,
    isFallback: eff.isFallback,
  };
}

/** Should we compact? `total` is the snapshot total (confirmed + estimate). */
export function shouldCompact(snapshot: TokenSnapshot, model: string): boolean {
  const limits = deriveTokenLimits(model);
  return snapshot.total >= limits.trigger;
}

/**
 * Content marker written in place of a pruned tool_result. Deterministic:
 * depends only on the original size, not on surrounding context, so repeated
 * compactions produce identical output and cache prefixes stay stable.
 */
function compactedMarker(originalSize: number): string {
    return `[compacted: original_size=${originalSize} chars elided at auto-compaction]`;
}

function blockChars(block: ContentBlock): number {
    // Mirrors the estimator in runner.approxChars so the two agree.
    let n = 32; // per-block overhead
    const asStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    const content = asStr((block as { content?: unknown }).content);
    if (content) n += content.length;
    const text = asStr((block as { text?: unknown }).text);
    if (text) n += text.length;
    const input = (block as { input?: unknown }).input;
    if (input && typeof input === 'object') {
        try {
            n += JSON.stringify(input).length;
        } catch {
            /* ignore */
        }
    }
    return n;
}

function messageChars(m: AgentMessage): number {
    let n = 0;
    for (const b of m.content) n += blockChars(b);
    return n;
}

export function totalChars(messages: AgentMessage[]): number {
    let n = 0;
    for (const m of messages) n += messageChars(m);
    return n;
}

/**
 * Determine the cutoff index: the smallest index `i` such that the combined
 * size of messages[i..] is ≤ PRUNE_PROTECT. Messages strictly before this
 * index are candidates for compaction.
 */
export function computeCutoffIndex(messages: AgentMessage[], protect = PRUNE_PROTECT): number {
    let running = 0;
    // Walk from tail toward head, growing the protected tail.
    for (let i = messages.length - 1; i >= 0; i--) {
        running += messageChars(messages[i]);
        if (running > protect) {
            // messages[i] pushed us over the budget — everything BEFORE i is
            // compactable, i itself stays.
            return i + 1;
        }
    }
    // Entire history fits under the protect budget.
    return 0;
}

/**
 * Token-based cutoff: walk from the tail and keep messages until their
 * combined token estimate exceeds `protectTokens`. The first index whose
 * INCLUSION would push us over the budget is the cutoff — everything strictly
 * before is compactable, everything from cutoff onward stays verbatim.
 *
 * Returns 0 if the entire history fits under the budget (no compaction needed).
 */
export function computeCutoffIndexByTokens(messages: AgentMessage[], protectTokens: number): number {
    let running = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        running += estimateMessageTokens(messages[i]);
        if (running > protectTokens) return i + 1;
    }
    return 0;
}

/**
 * Atomic-pair-preserving cutoff: ensure no `tool_result` whose paired
 * `tool_use` lives in the compactable prefix survives in the kept tail (the
 * provider rejects orphaned tool_results with 400 "No tool call found").
 * Likewise, no `tool_use` can be kept while its paired `tool_result` was
 * compacted away.
 *
 * Algorithm:
 *   1. Collect every `tool_use` id present in messages[cutoff..] (the tail).
 *   2. For each such id, find the pairing `tool_result` somewhere in
 *      messages[0..]. If the result lives BEFORE cutoff, the pair is
 *      split — adjust cutoff to whichever side is cheaper:
 *        - If pulling the assistant containing the tool_use INTO the prefix
 *          is cheaper than pulling the tool_result OUT of the prefix, do
 *          that (advance cutoff past the assistant + its tool message).
 *        - Otherwise pull the tool_result into the tail (recede cutoff to
 *          include the assistant + its tool message).
 *   3. Symmetric pass for `tool_result` blocks in the tail whose `tool_use`
 *      lives in the prefix.
 *
 * In practice the sane outcome is almost always: never split a pair — recede
 * the cutoff to include both halves. We only advance when receding would push
 * us above the protect budget, in which case we accept losing that one pair.
 */
export function snapCutoffPreservingPairs(messages: AgentMessage[], cutoff: number): number {
    if (cutoff <= 0 || cutoff >= messages.length) return cutoff;

    // Build maps: tool_use_id → { useMsgIdx, resultMsgIdx | null }
    interface PairRef { useMsg: number; resultMsg: number | null; }
    const pairs = new Map<string, PairRef>();
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.role === 'assistant') {
            for (const b of m.content) {
                if (b.type === 'tool_use') {
                    const id = (b as { id: string }).id;
                    if (!pairs.has(id)) pairs.set(id, { useMsg: i, resultMsg: null });
                    else pairs.get(id)!.useMsg = i;
                }
            }
        } else if (m.role === 'tool') {
            for (const b of m.content) {
                if (b.type === 'tool_result') {
                    const id = (b as { tool_use_id?: string }).tool_use_id ?? '';
                    if (!id) continue;
                    const existing = pairs.get(id);
                    if (existing) existing.resultMsg = i;
                    else pairs.set(id, { useMsg: -1, resultMsg: i });
                }
            }
        }
    }

    // Walk pairs and find the smallest cutoff that places EVERY pair entirely
    // on one side. We start from the proposed cutoff and only ever recede
    // (move toward 0) — the protect budget guarantees we can't violate the
    // tail size cap by receding (we'd just keep more of the prefix verbatim,
    // which is always safe).
    //
    // For each split pair we try to recede cutoff to min(useMsg, resultMsg)
    // so both halves end up in the tail. If both halves are after the
    // current cutoff (no split), nothing to do.
    let safe = cutoff;
    for (const { useMsg, resultMsg } of pairs.values()) {
        if (useMsg < 0 || resultMsg === null) continue; // half-known, leave alone
        const minSide = Math.min(useMsg, resultMsg);
        const maxSide = Math.max(useMsg, resultMsg);
        // Pair straddles the cutoff iff minSide < cutoff && maxSide >= cutoff.
        if (minSide < safe && maxSide >= safe) {
            // Recede cutoff to include the earlier half in the kept tail.
            safe = minSide;
        }
    }

    // Defensive: if cutoff landed on a `tool` role (shouldn't happen after
    // the pair pass above, but cheap to guarantee) advance past it so we
    // never start the tail with a tool_result whose tool_use is gone.
    while (safe < messages.length && messages[safe].role === 'tool') {
        safe++;
    }
    // And: never start the tail with an assistant that has tool_use blocks
    // when the next message (its tool_result message) is past safe — this
    // would orphan the use. The pair-walk above handles this; the role
    // check is belt-and-suspenders.
    return safe;
}

/**
 * Recede `cutoff` toward 0 until at least `n` user-role messages live in the
 * tail (PR-3, R4 from docs/agent-research/COMPARISON.md). Mirrors kimi-cli's
 * "preserve last 2 user/assistant turn pairs verbatim" rule
 * (`compaction.py:170-189`). The downside of summarizing too aggressively
 * is that fine-grained user-intent detail from the most recent turns gets
 * paraphrased — observed in 609-style "what was I doing" regressions. By
 * keeping the last N user messages plus everything after them as raw text,
 * the model retains the exact wording of recent intent.
 *
 * Caller is expected to feed the result through `snapCutoffPreservingPairs`
 * so atomic tool_use/tool_result pairs aren't split — this function only
 * recedes; it never advances.
 */
export function recedeToPreserveLastNTurns(
    messages: AgentMessage[],
    cutoff: number,
    n: number,
): number {
    if (n <= 0 || cutoff <= 0 || cutoff >= messages.length) return cutoff;

    // Count user messages already in the tail (indices >= cutoff).
    let userInTail = 0;
    for (let i = cutoff; i < messages.length; i++) {
        if (messages[i].role === 'user') userInTail++;
    }
    if (userInTail >= n) return cutoff;

    // Walk backward from cutoff-1 looking for user messages. Stop when we
    // have enough; recede to the index of the Nth-from-tail user message.
    let needed = n - userInTail;
    for (let i = cutoff - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
            needed--;
            if (needed === 0) return i;
        }
    }
    // Fewer than N user messages exist in the entire history — keep
    // everything raw. This is the trivial case: a fresh session where the
    // protect budget triggered compaction extremely early.
    return 0;
}

/**
 * Adjust cutoff so it never falls between an assistant message (with tool_use
 * blocks) and its paired tool message (with tool_result blocks). If the
 * message at `cutoff` is role='tool', advance past it — those tool_results
 * reference tool_uses in the preceding assistant message, which would be
 * spliced away by the summarizer, causing a 400 "No tool call found" error
 * from the provider.
 *
 * @deprecated Use `snapCutoffPreservingPairs` — handles split pairs correctly.
 */
export function snapCutoffToRoleBoundary(messages: AgentMessage[], cutoff: number): number {
    // Advance past tool messages (their tool_uses are in the preceding assistant)
    while (cutoff < messages.length && messages[cutoff].role === 'tool') {
        cutoff++;
    }
    // If cutoff landed on an assistant, include it + its tool results too.
    // Otherwise the summarizer's synthetic assistant would create consecutive
    // assistant messages — illegal in OpenAI-compatible APIs (GLM error 1214).
    if (cutoff < messages.length && messages[cutoff].role === 'assistant') {
        cutoff++;
        while (cutoff < messages.length && messages[cutoff].role === 'tool') {
            cutoff++;
        }
    }
    return cutoff;
}

export interface CompactionResult {
    messages: AgentMessage[];
    /** Number of tool_result blocks whose content was replaced with a marker. */
    prunedBlocks: number;
    /** Sum of original content lengths across pruned blocks (approximate). */
    prunedChars: number;
    /** Whether compaction was actually applied (false = below threshold). */
    applied: boolean;
}

/**
 * Apply deterministic compaction. Pure function: does not mutate `messages`.
 * Returns a fresh array with replaced tool_result blocks past the cutoff.
 *
 * Supports two modes:
 *   - **char mode (legacy)**: pass `minimum`/`protect` (chars). Used when
 *     CODER_NEW_COMPACTION=0 or no model id is available.
 *   - **token mode (new)**: pass `protectTokens`. Cutoff computed by the
 *     hybrid token estimator; pairs are preserved atomically.
 */
export function compactMessages(
    messages: AgentMessage[],
    opts: {
        minimum?: number;
        protect?: number;
        /** When set, use token-based cutoff via `computeCutoffIndexByTokens`. */
        protectTokens?: number;
        /** When set, skip the char-total guard (token mode decides via shouldCompact). */
        skipMinimumGuard?: boolean;
    } = {},
): CompactionResult {
    const minimum = opts.minimum ?? PRUNE_MINIMUM;
    const protect = opts.protect ?? PRUNE_PROTECT;
    const useTokenCutoff = opts.protectTokens != null;

    if (!opts.skipMinimumGuard) {
        const total = totalChars(messages);
        if (total <= minimum) {
            return { messages, prunedBlocks: 0, prunedChars: 0, applied: false };
        }
    }

    let cutoff: number;
    if (useTokenCutoff) {
        cutoff = computeCutoffIndexByTokens(messages, opts.protectTokens!);
        cutoff = snapCutoffPreservingPairs(messages, cutoff);
    } else {
        cutoff = computeCutoffIndex(messages, protect);
        cutoff = snapCutoffToRoleBoundary(messages, cutoff);
    }
    if (cutoff === 0) {
        // Tail protection already covers the whole history; nothing to prune.
        return { messages, prunedBlocks: 0, prunedChars: 0, applied: false };
    }

    let prunedBlocks = 0;
    let prunedChars = 0;
    const out: AgentMessage[] = messages.map((m, idx): AgentMessage => {
        if (idx >= cutoff) return m;
        let touched = false;
        const newContent = m.content.map((b): ContentBlock => {
            if (b.type !== 'tool_result') return b;
            const originalContent = typeof b.content === 'string' ? b.content : '';
            if (!originalContent) return b;
            // Skip if the block is already a compaction marker (idempotent).
            if (originalContent.startsWith('[compacted:')) return b;
            prunedBlocks++;
            prunedChars += originalContent.length;
            touched = true;
            return {
                ...b,
                content: compactedMarker(originalContent.length),
                // Preserve truncated flag if it was already set; mark originalSize
                // so the DB layer (if it ever re-hydrates) can tell.
                truncated: true,
                originalSize: (b as { originalSize?: number }).originalSize ?? originalContent.length,
            };
        });
        return touched ? { ...m, content: newContent } : m;
    });

    return {
        messages: out,
        prunedBlocks,
        prunedChars,
        applied: prunedBlocks > 0,
    };
}

/**
 * Rolling reduction (Camada 5 — AgentDiet pattern).
 *
 * Run on every turn (cheap). Replaces tool_result content for stale repeats
 * BEFORE the size-based compactMessages even runs — so sessions grow more
 * slowly and the heavy compaction kicks in less often. Two heuristics:
 *
 *   1. **Same-file re-reads.** If the same `read_file` / `mcp__read_file`
 *      call (matched by file path) appears more than once in the protected
 *      window, keep ONLY the most recent result; replace the others with
 *      `[stale: superseded by later read of <path>]`.
 *   2. **Stale searches.** Two consecutive `grep_code` / `mcp__search` /
 *      `mcp__grep_code` results in the protected window: replace earlier
 *      with `[stale: superseded by later <tool> query]`.
 *
 * What we DO NOT touch:
 *   - The most-recent N messages (keep them verbatim — model needs them).
 *   - Tool calls that mutated state (write_file, run_command, etc).
 *   - Markers already left by earlier reductions (idempotent).
 *
 * Determinism: this is a pure function over the input array. The same
 * sequence of messages always reduces to the same output — prefix cache
 * remains stable across turns.
 */
export interface RollingReductionResult {
    messages: AgentMessage[];
    /** How many tool_result contents were replaced. */
    reduced: number;
    /** Approximate chars freed by the reduction. */
    freedChars: number;
}

/** Tools whose outputs are cheap to invalidate when superseded. */
export const REDUCIBLE_READ_TOOLS = new Set<string>([
    'read_file',
    'mcp__read_file',
    'mcp__get_file_skeleton',
    'mcp__get_file_structure',
]);

const REDUCIBLE_SEARCH_TOOLS = new Set<string>([
    'mcp__grep_code',
    'mcp__search',
    'mcp__search_global',
    'glob',
]);

interface ToolCallIndex {
    msgIdx: number;
    blockIdx: number;
    name: string;
    /**
     * Composite key for "this tool returned the same INFORMATION before".
     * For reads it's `path#<json of slice fields>` so two reads of the
     * same file with DIFFERENT line ranges / symbols are NOT treated as
     * duplicates — only re-fetches of the EXACT same slice are. Empty for
     * non-read tools.
     */
    pathKey: string;
    /** Bare path (no slice). Used by the human-readable retirement reason. */
    pathLabel: string;
    /** Tool use id — used to find matching tool_result. */
    useId: string;
}

export function getStringField(input: Record<string, unknown> | undefined, ...keys: string[]): string {
    if (!input) return '';
    for (const k of keys) {
        const v = input[k];
        if (typeof v === 'string') return v;
    }
    return '';
}

/**
 * Build the dedup key for a read_file-style tool call. Includes the slice
 * fields so the rolling reducer doesn't collapse distinct chunks of the
 * same file into one (the bug that caused session 609 to loop on
 * itens-receita.component.ts: 5 ranges rotated 18–21× each).
 *
 * Stable JSON ordering is preserved by spelling out every field explicitly
 * — protects prompt-cache stability across runs of the reducer.
 */
export function buildReadDedupKey(path: string, inp: Record<string, unknown> | undefined): string {
    const slice = {
        symbol: (inp?.['symbol'] as unknown) ?? null,
        around_line: (inp?.['around_line'] as unknown) ?? null,
        start_line: (inp?.['start_line'] as unknown) ?? null,
        end_line: (inp?.['end_line'] as unknown) ?? null,
        max_lines: (inp?.['max_lines'] as unknown) ?? null,
    };
    return `${path}#${JSON.stringify(slice)}`;
}

export function applyRollingReduction(messages: AgentMessage[], opts: { protectTail?: number } = {}): RollingReductionResult {
    const protectTail = opts.protectTail ?? 6; // last 6 messages stay verbatim
    if (messages.length <= protectTail + 2) {
        return { messages, reduced: 0, freedChars: 0 };
    }

    // Walk forward and index every tool_use that looks reducible.
    const readCalls: ToolCallIndex[] = [];
    const searchCalls: ToolCallIndex[] = [];
    for (let i = 0; i < messages.length - protectTail; i++) {
        const m = messages[i];
        if (m.role !== 'assistant') continue;
        for (let bi = 0; bi < m.content.length; bi++) {
            const b = m.content[bi];
            if (b.type !== 'tool_use') continue;
            const name = (b as { name: string }).name;
            const inp = (b as { input?: Record<string, unknown> }).input;
            const useId = (b as { id: string }).id;
            if (REDUCIBLE_READ_TOOLS.has(name)) {
                const path = getStringField(inp, 'path', 'file_path');
                if (path) {
                    const pathKey = buildReadDedupKey(path, inp);
                    readCalls.push({ msgIdx: i, blockIdx: bi, name, pathKey, pathLabel: path, useId });
                }
            } else if (REDUCIBLE_SEARCH_TOOLS.has(name)) {
                searchCalls.push({ msgIdx: i, blockIdx: bi, name, pathKey: '', pathLabel: '', useId });
            }
        }
    }

    // Decide which tool_use_ids to retire. A read is retired ONLY when a
    // later read of the same SLICE (path + range/symbol) exists — distinct
    // chunks of the same file are kept verbatim because they carry
    // independent information. A search is retired if a LATER search exists.
    const retiredIds = new Map<string, string>(); // useId → reason
    const lastBySlice = new Map<string, ToolCallIndex>();
    for (const r of readCalls) {
        const prev = lastBySlice.get(r.pathKey);
        if (prev) {
            // Imperative marker (Fix H — session 609 regression). The earlier
            // version said "superseded by later identical read" which models
            // sometimes interpreted as "stale → re-read it". The current
            // version is a direct instruction NOT to re-call. Combined with
            // Fix F (dup-call cap) and Fix G (dominance guard) gives three
            // layers of defense against rotating-read loops.
            retiredIds.set(prev.useId, `${r.pathLabel} — DO NOT re-call this tool with these args`);
        }
        lastBySlice.set(r.pathKey, r);
    }
    for (let i = 0; i < searchCalls.length - 1; i++) {
        const r = searchCalls[i];
        retiredIds.set(r.useId, `superseded by later ${searchCalls[i + 1].name} query`);
    }
    if (retiredIds.size === 0) {
        return { messages, reduced: 0, freedChars: 0 };
    }

    // Walk again, replace tool_result content for retired ids. Stable ordering
    // → cache-safe.
    let reduced = 0;
    let freed = 0;
    const out = messages.map((m): AgentMessage => {
        if (m.role !== 'tool') return m;
        let touched = false;
        const newContent = m.content.map((b): ContentBlock => {
            if (b.type !== 'tool_result') return b;
            const tid = (b as { tool_use_id?: string }).tool_use_id;
            if (!tid || !retiredIds.has(tid)) return b;
            const original = typeof b.content === 'string' ? b.content : '';
            // Idempotent: skip if already a stale marker.
            // Idempotent: skip blocks that were already retired/compacted on
            // a previous reducer pass (whether by the legacy `[stale: ...]`
            // marker or the new `[duplicate-read elided]` text).
            if (
              original.startsWith('[stale:') ||
              original.startsWith('[compacted:') ||
              original.startsWith('[duplicate-read elided]')
            ) return b;
            reduced++;
            freed += original.length;
            touched = true;
            return {
                ...b,
                content: `[duplicate-read elided] You already have the latest content of ${retiredIds.get(tid)} (original ${original.length} chars). Look at later reads in this conversation, or call a different tool — repeating this exact call will be refused.`,
                truncated: true,
                originalSize: (b as { originalSize?: number }).originalSize ?? original.length,
            };
        });
        return touched ? { ...m, content: newContent } : m;
    });

    return { messages: out, reduced, freedChars: freed };
}

/**
 * Post-compact cleanup pass.
 *
 * Runs AFTER the summarizer has produced a synthetic summary message and
 * spliced it into the head of the history. The summary often mentions files
 * by path, but the preserved tail also contains verbatim `tool_result`
 * blocks for those same paths — re-injecting the same content twice is pure
 * waste of context.
 *
 * This pass:
 *   1. Walks the preserved tail and collects (path, slice) keys for every
 *      file-read tool_result.
 *   2. For any DUPLICATE read of the same key in the tail, replaces all but
 *      the most recent with `[duplicate-read elided]` (cheap variant of the
 *      rolling reducer, but applied across the whole tail not just last 6).
 *   3. Returns counts so the caller can log/telemetry.
 *
 * Pure function — does not mutate input. Safe to chain after summarization.
 */
export interface PostCompactResult {
    messages: AgentMessage[];
    /** Number of duplicate read tool_results elided. */
    elidedReads: number;
    /** Approx chars freed. */
    freedChars: number;
}

const POST_COMPACT_READ_TOOLS = new Set<string>([
    'read_file',
    'mcp__read_file',
    'mcp__get_file_skeleton',
    'mcp__get_file_structure',
    'Read',
    'glob',
    'mcp__grep_code',
    'mcp__search',
    'mcp__search_global',
    'web_fetch',
    'WebFetch',
]);

export function postCompactCleanup(messages: AgentMessage[]): PostCompactResult {
    if (messages.length < 4) return { messages, elidedReads: 0, freedChars: 0 };

    // Pass 1: index tool_use → key for any read-style tool, across ALL messages.
    interface UseRef { name: string; key: string; useId: string; msgIdx: number; }
    const refs = new Map<string, UseRef>();
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.role !== 'assistant') continue;
        for (const b of m.content) {
            if (b.type !== 'tool_use') continue;
            const name = (b as { name: string }).name;
            if (!POST_COMPACT_READ_TOOLS.has(name)) continue;
            const inp = (b as { input?: Record<string, unknown> }).input;
            const path = getStringField(inp, 'path', 'file_path', 'url');
            const useId = (b as { id: string }).id;
            const key = path ? buildReadDedupKey(path, inp) : `${name}#${useId}`;
            refs.set(useId, { name, key, useId, msgIdx: i });
        }
    }

    // Pass 2: group refs by key, find duplicates, retire all but the latest.
    const lastByKey = new Map<string, string>(); // key → useId
    const retired = new Set<string>();
    // Walk in order so the last-seen wins.
    for (const ref of refs.values()) {
        const prev = lastByKey.get(ref.key);
        if (prev) retired.add(prev);
        lastByKey.set(ref.key, ref.useId);
    }
    if (retired.size === 0) return { messages, elidedReads: 0, freedChars: 0 };

    // Pass 3: replace tool_result content for retired ids.
    let elided = 0;
    let freed = 0;
    const out = messages.map((m): AgentMessage => {
        if (m.role !== 'tool') return m;
        let touched = false;
        const newContent = m.content.map((b): ContentBlock => {
            if (b.type !== 'tool_result') return b;
            const tid = (b as { tool_use_id?: string }).tool_use_id;
            if (!tid || !retired.has(tid)) return b;
            const original = typeof b.content === 'string' ? b.content : '';
            if (
                original.startsWith('[stale:') ||
                original.startsWith('[compacted:') ||
                original.startsWith('[duplicate-read elided]')
            ) return b;
            elided++;
            freed += original.length;
            touched = true;
            return {
                ...b,
                content: `[duplicate-read elided] Superseded by a later read of the same target. Original ${original.length} chars dropped — refer to the later result.`,
                truncated: true,
                originalSize: (b as { originalSize?: number }).originalSize ?? original.length,
            };
        });
        return touched ? { ...m, content: newContent } : m;
    });

    return { messages: out, elidedReads: elided, freedChars: freed };
}

// ─── Smarter pre-read enforcement helpers ──────────────────────────────────
//
// These helpers back the contexto-aware / mutação-aware variant of the
// pre-read guard in runner.ts. They are kept pure and side-effect free so
// the guard can call them without owning compaction state.

/**
 * Filesystem mutators recognised by the pre-read guard. Distinct from the
 * `mutates: true` flag on CoderTool because the guard only cares about tools
 * that change *file content on a known path* — `apply_patch` changes many,
 * `edit_file`/`write_file`/`create_file`/`multi_edit` change one, and other
 * mutators (git, shell, etc.) are out of scope here.
 */
export const MUTATING_FS_TOOLS = new Set<string>([
    'write_file',
    'create_file',
    'edit_file',
    'multi_edit',
    'apply_patch',
]);

export function isMutatingFsTool(name: string): boolean {
    return MUTATING_FS_TOOLS.has(name);
}

/**
 * Markers that postCompactCleanup / push-time truncation / staleness checks
 * stamp on `tool_result.content`. Anything matching these means the original
 * payload is NO LONGER in context — the model cannot quote it. Used to decide
 * whether a pre-read refusal is honest or based on phantom state.
 */
const ELIDED_CONTENT_PREFIXES = [
    '[duplicate-read elided]',
    '[compacted:',
    '[stale:',
] as const;

export function isElidedReadContent(content: string): boolean {
    return ELIDED_CONTENT_PREFIXES.some((p) => content.startsWith(p));
}

/**
 * Locate the tool_result that matches a tool_use id. Returns the block plus
 * its enclosing message index so callers can reason about position. null if
 * not found in the visible history (caller should treat as elided).
 */
export function findToolResultByUseId(
    useId: string,
    messages: AgentMessage[],
): { content: string; isElided: boolean; msgIdx: number } | null {
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.role !== 'tool') continue;
        for (const b of m.content) {
            if (b.type !== 'tool_result') continue;
            const tid = (b as { tool_use_id?: string }).tool_use_id;
            if (tid !== useId) continue;
            const content = typeof b.content === 'string' ? b.content : '';
            return { content, isElided: isElidedReadContent(content), msgIdx: i };
        }
    }
    return null;
}

/**
 * Returns true iff every prior read in this list now points to an elided/
 * compacted/stale tool_result (or the tool_result is missing entirely). When
 * true, the model has lost the content — a fresh read is legitimate, not a
 * doom loop.
 *
 * Conservative on ambiguity: if ANY prior is still readable, returns false
 * (the model has at least one usable copy in context — refuse).
 */
export function allPriorReadsElided(
    prior: Array<{ useId: string }>,
    messages: AgentMessage[],
): boolean {
    if (prior.length === 0) return false;
    for (const p of prior) {
        const r = findToolResultByUseId(p.useId, messages);
        // Missing tool_result is treated as elided (the pair was dropped by
        // pair-preserving cutoff). Readable & non-elided → still in context.
        if (r && !r.isElided) return false;
    }
    return true;
}

/**
 * Latest turn (within the window) at which `path` was mutated, or null. The
 * caller filters out turns older than the prior read it's evaluating.
 *
 * Pure lookup — does not modify the input map.
 */
export function lastMutationTurn(
    path: string,
    recentWrites: Map<string, number>,
    sinceTurnExclusive: number,
): number | null {
    const t = recentWrites.get(path);
    if (t == null) return null;
    return t > sinceTurnExclusive ? t : null;
}

/**
 * Best-effort line preview: first `head` and last `tail` lines of a possibly
 * numbered/headered read result. Strips the read_file rich header if present
 * so the preview is just the body. Deterministic.
 */
export function extractReadPreview(
    content: string,
    head = 3,
    tail = 3,
): { headLines: string[]; tailLines: string[]; totalLines: number } {
    // Strip read_file header pattern: "<path> | <N> lines | <ext>\n[lines A-B]...\n"
    let body = content;
    const headerMatch = body.match(/^[^\n]+\|\s*\d+\s+lines\s*\|[^\n]*\n\[lines\s+\d+-\d+\][^\n]*\n/);
    if (headerMatch) body = body.slice(headerMatch[0].length);
    // Drop trailing pagination footer.
    body = body.replace(/\n\.\.\.\s*\[[^\]]*more lines[^\]]*\][\s\S]*$/, '');
    const lines = body.split('\n');
    return {
        headLines: lines.slice(0, head),
        tailLines: lines.length > head + tail ? lines.slice(-tail) : [],
        totalLines: lines.length,
    };
}

/**
 * Minimal unified-diff between two strings, line-based, with `contextLines`
 * of unchanged context around each hunk. No external deps — uses a simple
 * LCS via DP. Caller is expected to keep inputs under a few thousand lines
 * (the read tool already enforces caps).
 *
 * Determinism: identical (before, after, contextLines) → identical output,
 * so safe to embed in tool_result content without busting prompt cache.
 */
export function buildSimpleLineDiff(
    before: string,
    after: string,
    contextLines = 3,
): string {
    const a = before.split('\n');
    const b = after.split('\n');
    // LCS table (rows = a, cols = b).
    const m = a.length;
    const n = b.length;
    // Guard against pathological inputs.
    if (m * n > 4_000_000) {
        return `[diff suppressed: ${m}×${n} too large to compute inline; full content follows]`;
    }
    const dp: Int32Array[] = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j]
                ? dp[i + 1][j + 1] + 1
                : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    // Walk back to produce an edit script.
    type Op = { kind: ' ' | '-' | '+'; aIdx?: number; bIdx?: number };
    const ops: Op[] = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
        if (a[i] === b[j]) {
            ops.push({ kind: ' ', aIdx: i, bIdx: j });
            i++; j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            ops.push({ kind: '-', aIdx: i });
            i++;
        } else {
            ops.push({ kind: '+', bIdx: j });
            j++;
        }
    }
    while (i < m) ops.push({ kind: '-', aIdx: i++ });
    while (j < n) ops.push({ kind: '+', bIdx: j++ });

    if (!ops.some((o) => o.kind !== ' ')) return '(no changes)';

    // Group ops into hunks with `contextLines` of surrounding context.
    interface Hunk { aStart: number; aLen: number; bStart: number; bLen: number; lines: string[]; }
    const hunks: Hunk[] = [];
    let cur: Hunk | null = null;
    let runOfContext = 0;
    for (let k = 0; k < ops.length; k++) {
        const op = ops[k];
        if (op.kind === ' ') {
            if (cur) {
                cur.lines.push(' ' + a[op.aIdx!]);
                cur.aLen++; cur.bLen++;
                runOfContext++;
                if (runOfContext > contextLines * 2) {
                    // Trim trailing context, close hunk.
                    const trim = runOfContext - contextLines;
                    cur.lines.splice(cur.lines.length - trim, trim);
                    cur.aLen -= trim; cur.bLen -= trim;
                    hunks.push(cur);
                    cur = null;
                    runOfContext = 0;
                }
            }
        } else {
            if (!cur) {
                // Open a new hunk with up to contextLines of preceding context.
                const ctxStart = Math.max(0, k - contextLines);
                cur = { aStart: 0, bStart: 0, aLen: 0, bLen: 0, lines: [] };
                // Find absolute a/b indices at ctxStart.
                let aAt = 0, bAt = 0;
                for (let p = 0; p < ctxStart; p++) {
                    if (ops[p].kind !== '+') aAt++;
                    if (ops[p].kind !== '-') bAt++;
                }
                cur.aStart = aAt + 1; // 1-indexed
                cur.bStart = bAt + 1;
                for (let p = ctxStart; p < k; p++) {
                    const o = ops[p];
                    if (o.kind === ' ') {
                        cur.lines.push(' ' + a[o.aIdx!]);
                        cur.aLen++; cur.bLen++;
                    }
                }
            }
            if (op.kind === '-') {
                cur.lines.push('-' + a[op.aIdx!]);
                cur.aLen++;
            } else {
                cur.lines.push('+' + b[op.bIdx!]);
                cur.bLen++;
            }
            runOfContext = 0;
        }
    }
    if (cur) hunks.push(cur);

    if (hunks.length === 0) return '(no changes)';

    const out: string[] = [];
    for (const h of hunks) {
        out.push(`@@ -${h.aStart},${h.aLen} +${h.bStart},${h.bLen} @@`);
        out.push(...h.lines);
    }
    return out.join('\n');
}

export interface RichRefusalArgs {
    toolName: string;
    path: string;
    prior: Array<{ turn: number; useId: string; mtimeMs?: number }>;
    windowTurns: number;
    currentMtimeMs?: number;
    /** Preview of the FIRST prior read, if its tool_result is still in context. */
    contextPreview?: { headLines: string[]; tailLines: string[]; totalLines: number };
    /** Symbols glimpsed earlier (from a skeleton in the same window), if any. */
    knownSymbols?: Array<{ name: string; line: number; kind: string }>;
}

/**
 * Build the compact refusal payload for the pre-dispatch read-dedup cap.
 *
 * Deterministic over the input args (no Date.now / randomness) because
 * it becomes part of the tool_result that feeds back into the provider
 * prompt — non-determinism would break prefix caching.
 *
 * Design note (token budget): the previous revision of this function
 * emitted ~1500 chars (per-turn `tool_use` ids, mtime line, head/tail
 * preview, 4-line "what to do next" block). For small reads (e.g. lines
 * 173–176 of an HTML file ≈ 250 chars), the refusal was 6× larger than
 * the content it was preventing — the brake cost more tokens than the
 * loop. This version drops the verbose lists and rebuilds the message
 * as 2–3 lines (~250 chars). The agent gets the same actionable info:
 * "you read this N times, content is above, here's the escape".
 *
 * `RichRefusalArgs` keeps optional fields (`currentMtimeMs`,
 * `contextPreview`, `knownSymbols`) for backwards-compat with callers —
 * we just don't render them. Signature didn't change so callers don't
 * need updates.
 */
export function buildRichRefusal(args: RichRefusalArgs): string {
    const { toolName, path, prior, windowTurns } = args;
    // Compact turn list — just the numbers, joined comma-sep. The
    // tool_use ids are useless to the model (it doesn't navigate by
    // them) and were costing ~60 chars per prior read.
    const turns = prior.map((p) => p.turn).join(', ');
    const plural = prior.length === 1 ? '' : 's';

    return (
        `Refused: \`${toolName}\` called ${prior.length} time${plural} for \`${path}\` ` +
        `in last ${windowTurns} turns (turn${plural} ${turns}). ` +
        `Content is already in your context above — quote it and act on it, ` +
        `or pass \`force_reread: true\` if the file genuinely changed since the first read.`
    );
}

/**
 * Opt-in auto-downgrade response: instead of refusing outright, return a
 * skeleton-flavoured pointer to the prior read. Marked clearly so the model
 * understands this is NOT a fresh fetch. Deterministic over inputs.
 */
export function buildAutoDowngradeResponse(
    toolName: string,
    path: string,
    prior: Array<{ turn: number; useId: string }>,
    windowTurns: number,
    messages: AgentMessage[],
): string {
    const lines: string[] = [];
    lines.push(
        `[auto-downgraded from ${toolName}] You already read \`${path}\` in the last ${windowTurns} turns ` +
        `(${prior.length}× — see turn${prior.length === 1 ? '' : 's'} ${prior.map((p) => p.turn).join(', ')}). ` +
        `The runner is returning a pointer instead of re-fetching the content.`,
    );
    // Try to surface the most useful prior read still in context.
    for (const p of prior) {
        const r = findToolResultByUseId(p.useId, messages);
        if (r && !r.isElided) {
            const preview = extractReadPreview(r.content, 4, 2);
            lines.push('');
            lines.push(`Prior read at turn ${p.turn} (tool_use ${p.useId}) — ${preview.totalLines} lines:`);
            for (const l of preview.headLines) lines.push(`  ${l}`);
            if (preview.tailLines.length > 0) {
                lines.push('  ...');
                for (const l of preview.tailLines) lines.push(`  ${l}`);
            }
            break;
        }
    }
    lines.push('');
    lines.push(
        'If you need a region you have not read yet, change `start_line`/`end_line` or pass another `symbol`. ' +
        'If you need an outline, call `mcp__get_file_skeleton`. If you only need callers, call `mcp__find_references`.',
    );
    return lines.join('\n');
}