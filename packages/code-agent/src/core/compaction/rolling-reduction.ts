import type { AgentMessage, ContentBlock } from '@mcp/code-agent/core/messages.js';

/** Tools whose outputs are cheap to invalidate when superseded. */
export const REDUCIBLE_READ_TOOLS = new Set<string>([
  'read_file',
  'mcp__read_file',
  'mcp__get_file_skeleton',
]);

const REDUCIBLE_SEARCH_TOOLS = new Set<string>([
  'mcp__grep_code',
  'mcp__search',
  'glob',
]);

interface ToolCallIndex {
  msgIdx: number;
  blockIdx: number;
  name: string;
  /**
   * Composite key for "this tool returned the same INFORMATION before". For
   * reads it's `path#<json of slice fields>` so two reads of the same file
   * with DIFFERENT line ranges / symbols are NOT treated as duplicates — only
   * re-fetches of the EXACT same slice are.
   */
  pathKey: string;
  pathLabel: string;
  useId: string;
}

/** A detected retirement, ordered by the SUPERSEDING call's position. */
interface RetirementCandidate {
  useId: string;
  reason: string;
  /** Position of the superseding read/search — append-only as history grows. */
  orderMsgIdx: number;
  orderBlockIdx: number;
  /** Chars the retirement would free (0 for non-string content). */
  freedChars: number;
}

export interface RollingReductionOpts {
  protectTail?: number;
  /**
   * Tranche flush threshold in chars. `0` (default) = legacy behavior: apply
   * every detected retirement immediately. When > 0, retirements are
   * DETECTED every pass but only APPLIED in batches: with `total` = chars
   * across all candidates, the applied prefix covers `floor(total/T)*T`
   * chars. Between flushes the output is byte-identical to the input, so the
   * provider prompt-cache prefix survives; each flush is ONE deep bust
   * instead of a trickle of small ones (one per turn was observed busting
   * ~90k cached tokens to free ~2k chars).
   *
   * `Infinity` = defer-all: candidates are detected and reported as pending
   * but NEVER applied by this pass. Used by the per-turn view so the only
   * place retirements ever land is the durable compaction pass — the one
   * moment the prefix cache is already being rewritten (telemetry: a mid-run
   * flush re-prefilled ~70k uncached tokens to free ~2k chars).
   */
  flushThresholdChars?: number;
}

export interface RollingReductionResult {
  messages: AgentMessage[];
  /** How many tool_result contents were replaced (applied in this view). */
  reduced: number;
  /** Approximate chars freed by the applied retirements. */
  freedChars: number;
  /** Retirements detected but deferred by the tranche threshold. */
  pendingRetired: number;
  /** Chars the deferred retirements would free once flushed. */
  pendingChars: number;
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
 * fields so the rolling reducer doesn't collapse distinct chunks of the same
 * file into one (the bug that caused session 609 to loop on
 * itens-receita.component.ts: 5 ranges rotated 18–21× each).
 *
 * Stable JSON ordering is preserved by spelling out every field explicitly —
 * protects prompt-cache stability across runs of the reducer.
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

const ELIDED_PREFIXES = ['[stale:', '[compacted:', '[duplicate-read elided]'];

function isAlreadyElided(content: string): boolean {
  return ELIDED_PREFIXES.some((p) => content.startsWith(p));
}

/**
 * Rolling reduction (Camada 5 — AgentDiet pattern).
 *
 * Run on every turn (cheap, pure — `ctx.messages` is never mutated; this is
 * the per-turn LLM view). Replaces tool_result content for stale repeats so
 * sessions grow sublinearly. Two heuristics:
 *
 *   1. **Same-file re-reads.** Identical slice of the same path keeps only
 *      the most recent; others get `[duplicate-read elided]`.
 *   2. **Stale searches.** A search is superseded by any later search.
 *
 * PROMPT-CACHE CONTRACT (`flushThresholdChars`): retiring a result rewrites
 * an OLD message in place, which busts the provider prefix cache from that
 * point on. With a threshold T, candidates are ordered by their superseding
 * call's position — a sequence that only ever APPENDS as the conversation
 * grows, with fixed per-candidate sizes (the raw array is immutable between
 * durable compactions). Applying the prefix of candidates covered by
 * `floor(total/T)*T` is therefore MONOTONIC: the same input always reduces
 * to the same output (resume-safe, no hidden state), output bytes change
 * only when a new tranche completes, and durable compaction rewrites the
 * raw array anyway (cold prefix → candidates reset for free).
 *
 * The deferred `[duplicate-read elided]` marker is not a re-read brake, and
 * nothing behind it refuses a re-read: `enforcePreReadForBridge` runs in
 * shadow (it records `pre-read-shadow-allowed` and lets the call through) and
 * the dispatch tuple-hash dedup never refuses stable reads across turns.
 * Deferral only keeps a verbatim prior visible until its tranche completes.
 */
export function applyRollingReduction(
  messages: AgentMessage[],
  opts: RollingReductionOpts = {},
): RollingReductionResult {
  const protectTail = opts.protectTail ?? 6; // last 6 messages stay verbatim
  const flushThreshold = opts.flushThresholdChars ?? 0;
  if (messages.length <= protectTail + 2) {
    return { messages, reduced: 0, freedChars: 0, pendingRetired: 0, pendingChars: 0 };
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

  // Decide which tool_use_ids COULD be retired. A read is retired ONLY when a
  // later read of the same SLICE (path + range/symbol) exists — distinct
  // chunks of the same file are kept verbatim because they carry independent
  // information. A search is retired if a LATER search exists. Each candidate
  // is stamped with its superseder's position for the tranche ordering.
  const proposed = new Map<string, RetirementCandidate>(); // useId → candidate
  const lastBySlice = new Map<string, ToolCallIndex>();
  for (const r of readCalls) {
    const prev = lastBySlice.get(r.pathKey);
    if (prev) {
      // Imperative marker (Fix H — session 609 regression). The earlier
      // version said "superseded by later identical read" which models
      // sometimes interpreted as "stale → re-read it". The current version
      // is a direct instruction NOT to re-call.
      proposed.set(prev.useId, {
        useId: prev.useId,
        reason: `${r.pathLabel} — DO NOT re-call this tool with these args`,
        orderMsgIdx: r.msgIdx,
        orderBlockIdx: r.blockIdx,
        freedChars: 0,
      });
    }
    lastBySlice.set(r.pathKey, r);
  }
  for (let i = 0; i < searchCalls.length - 1; i++) {
    const r = searchCalls[i];
    const next = searchCalls[i + 1];
    proposed.set(r.useId, {
      useId: r.useId,
      reason: `superseded by later ${next.name} query`,
      orderMsgIdx: next.msgIdx,
      orderBlockIdx: next.blockIdx,
      freedChars: 0,
    });
  }
  if (proposed.size === 0) {
    return { messages, reduced: 0, freedChars: 0, pendingRetired: 0, pendingChars: 0 };
  }

  // Resolve each candidate's tool_result size. Blocks already elided by a
  // previous durable pass are dropped entirely — nothing to free, nothing to
  // rewrite, and excluding them keeps the candidate sequence stable.
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue;
      const tid = (b as { tool_use_id?: string }).tool_use_id;
      if (!tid) continue;
      const cand = proposed.get(tid);
      if (!cand) continue;
      const original = typeof b.content === 'string' ? b.content : '';
      if (isAlreadyElided(original)) {
        proposed.delete(tid);
      } else {
        cand.freedChars = original.length;
      }
    }
  }
  if (proposed.size === 0) {
    return { messages, reduced: 0, freedChars: 0, pendingRetired: 0, pendingChars: 0 };
  }

  // Tranche math: order candidates by superseder position (append-only as
  // the conversation grows), apply the prefix covered by completed tranches.
  const candidates = Array.from(proposed.values()).sort((a, b) =>
    a.orderMsgIdx - b.orderMsgIdx || a.orderBlockIdx - b.orderBlockIdx || (a.useId < b.useId ? -1 : a.useId > b.useId ? 1 : 0),
  );
  const total = candidates.reduce((s, c) => s + c.freedChars, 0);
  let applyCount = candidates.length;
  if (flushThreshold > 0 && !Number.isFinite(flushThreshold)) {
    // Defer-all: pure detection pass, byte-identical output.
    applyCount = 0;
  } else if (flushThreshold > 0) {
    const completed = Math.floor(total / flushThreshold) * flushThreshold;
    let cum = 0;
    applyCount = 0;
    for (const c of candidates) {
      if (cum + c.freedChars > completed) break;
      cum += c.freedChars;
      applyCount++;
    }
  }
  const applied = candidates.slice(0, applyCount);
  const pending = candidates.slice(applyCount);
  const pendingChars = pending.reduce((s, c) => s + c.freedChars, 0);
  if (applied.length === 0) {
    return { messages, reduced: 0, freedChars: 0, pendingRetired: pending.length, pendingChars };
  }
  const retiredIds = new Map<string, string>(); // useId → reason
  for (const c of applied) retiredIds.set(c.useId, c.reason);

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
      // Idempotent: skip blocks that were already retired/compacted by a
      // previous reducer pass.
      if (isAlreadyElided(original)) return b;
      reduced++;
      freed += original.length;
      touched = true;
      return {
        ...b,
        content: `[duplicate-read elided] You already have the latest content of ${retiredIds.get(tid)} (original ${original.length} chars). Use the later read of it in this conversation; read it again only if the content you need is no longer visible.`,
        truncated: true,
        originalSize: (b as { originalSize?: number }).originalSize ?? original.length,
      };
    });
    return touched ? { ...m, content: newContent } : m;
  });

  return { messages: out, reduced, freedChars: freed, pendingRetired: pending.length, pendingChars };
}
