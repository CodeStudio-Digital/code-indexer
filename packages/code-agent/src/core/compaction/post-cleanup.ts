import type { AgentMessage, ContentBlock } from '@mcp/code-agent/core/messages.js';
import { buildReadDedupKey, getStringField } from './rolling-reduction.js';

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

export interface PostCompactResult {
  messages: AgentMessage[];
  /** Number of duplicate read tool_results elided. */
  elidedReads: number;
  /** Approx chars freed. */
  freedChars: number;
}

/**
 * Post-compact cleanup pass.
 *
 * Runs AFTER the summarizer has produced a synthetic summary message and
 * spliced it into the head of the history. The summary often mentions files
 * by path, but the preserved tail also contains verbatim `tool_result` blocks
 * for those same paths — re-injecting the same content twice is pure waste.
 *
 * Pure function — does not mutate input. Safe to chain after summarization.
 */
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
