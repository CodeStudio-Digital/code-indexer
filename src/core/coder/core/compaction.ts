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

import type { AgentMessage, ContentBlock } from './messages.js';

/**
 * Below this char total, auto-compaction is a no-op. Default 60k — fallback
 * for models without a known context_window. Use deriveCompactionLimits() to
 * get model-aware thresholds when context_window is available.
 */
export const PRUNE_MINIMUM = Number(process.env.CODER_PRUNE_MINIMUM ?? 60_000);

/**
 * How many chars of the most-recent history are guaranteed to survive
 * compaction verbatim when using the fixed fallback. Use deriveCompactionLimits()
 * for model-aware protection budgets.
 */
export const PRUNE_PROTECT = Number(process.env.CODER_PRUNE_PROTECT ?? 80_000);

/** Fraction of context window (in chars) at which compaction triggers. */
const TRIGGER_RATIO = 0.90;
/** Fraction of context window (in chars) kept verbatim after compaction. */
const PROTECT_RATIO = 0.55;
/** chars-per-token heuristic, matching token-budget.ts. */
const CHARS_PER_TOKEN = 4;

export interface CompactionLimits {
    /** Char total above which compaction is triggered (char-based fallback). */
    minimum: number;
    /** How many recent chars to keep verbatim during compaction. */
    protect: number;
    /** Input-token count above which compaction is triggered (null = no known context_window). */
    triggerTokens: number | null;
}

/**
 * Derive context-aware compaction limits from the model's known context window.
 * When contextWindowTokens is null/undefined, falls back to the hardcoded env
 * defaults so behaviour is unchanged for models without registered capacity.
 */
export function deriveCompactionLimits(contextWindowTokens: number | null | undefined): CompactionLimits {
    if (!contextWindowTokens) {
        return { minimum: PRUNE_MINIMUM, protect: PRUNE_PROTECT, triggerTokens: null };
    }
    const contextChars = contextWindowTokens * CHARS_PER_TOKEN;
    return {
        minimum: Math.floor(contextChars * TRIGGER_RATIO),
        protect: Math.floor(contextChars * PROTECT_RATIO),
        triggerTokens: Math.floor(contextWindowTokens * TRIGGER_RATIO),
    };
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
 * Adjust cutoff so it never falls between an assistant message (with tool_use
 * blocks) and its paired tool message (with tool_result blocks). If the
 * message at `cutoff` is role='tool', advance past it — those tool_results
 * reference tool_uses in the preceding assistant message, which would be
 * spliced away by the summarizer, causing a 400 "No tool call found" error
 * from the provider.
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
 */
export function compactMessages(
    messages: AgentMessage[],
    opts: { minimum?: number; protect?: number } = {},
): CompactionResult {
    const minimum = opts.minimum ?? PRUNE_MINIMUM;
    const protect = opts.protect ?? PRUNE_PROTECT;

    const total = totalChars(messages);
    if (total <= minimum) {
        return { messages, prunedBlocks: 0, prunedChars: 0, applied: false };
    }

    const cutoff = computeCutoffIndex(messages, protect);
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