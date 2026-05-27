import type { AgentMessage, ContentBlock } from '@mcp/code-agent/core/messages.js';

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
   * Composite key for "this tool returned the same INFORMATION before". For
   * reads it's `path#<json of slice fields>` so two reads of the same file
   * with DIFFERENT line ranges / symbols are NOT treated as duplicates — only
   * re-fetches of the EXACT same slice are.
   */
  pathKey: string;
  pathLabel: string;
  useId: string;
}

export interface RollingReductionResult {
  messages: AgentMessage[];
  /** How many tool_result contents were replaced. */
  reduced: number;
  /** Approximate chars freed by the reduction. */
  freedChars: number;
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

/**
 * Rolling reduction (Camada 5 — AgentDiet pattern).
 *
 * Run on every turn (cheap). Replaces tool_result content for stale repeats
 * BEFORE the size-based compactMessages even runs — so sessions grow more
 * slowly and the heavy compaction kicks in less often. Two heuristics:
 *
 *   1. **Same-file re-reads.** Identical slice of the same path keeps only
 *      the most recent; others get `[duplicate-read elided]`.
 *   2. **Stale searches.** Two consecutive `grep_code`/`search` results in
 *      the protected window: replace earlier with the elided marker.
 *
 * Determinism: pure function over the input array. The same sequence of
 * messages always reduces to the same output — prefix cache stable.
 */
export function applyRollingReduction(
  messages: AgentMessage[],
  opts: { protectTail?: number } = {},
): RollingReductionResult {
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

  // Decide which tool_use_ids to retire. A read is retired ONLY when a later
  // read of the same SLICE (path + range/symbol) exists — distinct chunks of
  // the same file are kept verbatim because they carry independent
  // information. A search is retired if a LATER search exists.
  const retiredIds = new Map<string, string>(); // useId → reason
  const lastBySlice = new Map<string, ToolCallIndex>();
  for (const r of readCalls) {
    const prev = lastBySlice.get(r.pathKey);
    if (prev) {
      // Imperative marker (Fix H — session 609 regression). The earlier
      // version said "superseded by later identical read" which models
      // sometimes interpreted as "stale → re-read it". The current version
      // is a direct instruction NOT to re-call.
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
      // Idempotent: skip blocks that were already retired/compacted by a
      // previous reducer pass.
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
