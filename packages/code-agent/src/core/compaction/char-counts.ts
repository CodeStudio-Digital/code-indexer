import type { AgentMessage, ContentBlock } from '@mcp/code-agent/core/messages.js';

/**
 * Content marker written in place of a pruned tool_result. Deterministic:
 * depends only on the original size, not on surrounding context, so repeated
 * compactions produce identical output and cache prefixes stay stable.
 */
export function compactedMarker(originalSize: number): string {
  return `[compacted: original_size=${originalSize} chars elided at auto-compaction]`;
}

/**
 * Approximate per-block char count. Mirrors the estimator in
 * `runner.approxChars` so the two agree across compaction decisions.
 */
export function blockChars(block: ContentBlock): number {
  let n = 32; // per-block overhead
  const asStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const content = asStr((block as { content?: unknown }).content);
  if (content) n += content.length;
  const text = asStr((block as { text?: unknown }).text);
  if (text) n += text.length;
  const input = (block as { input?: unknown }).input;
  if (input && typeof input === 'object') {
    try { n += JSON.stringify(input).length; }
    catch { /* ignore */ }
  }
  return n;
}

export function messageChars(m: AgentMessage): number {
  let n = 0;
  for (const b of m.content) n += blockChars(b);
  return n;
}

export function totalChars(messages: AgentMessage[]): number {
  let n = 0;
  for (const m of messages) n += messageChars(m);
  return n;
}
