import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import { visibleSpanOf } from '@mcp/code-agent/core/runner/guards/read-coverage.js';

// ─── Smarter pre-read enforcement helpers ──────────────────────────────────
// These helpers back the context-aware / mutation-aware variant of the
// pre-read guard in runner.ts. They are kept pure and side-effect free so the
// guard can call them without owning compaction state.

/**
 * Filesystem mutators recognised by the pre-read guard. Distinct from the
 * `mutates: true` flag on CoderTool because the guard only cares about tools
 * that change *file content on a known path* — `apply_patch` changes many,
 * `edit_file`/`write_file`/`create_file`/`multi_edit` change one.
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
 * Markers stamped by push-time truncation, staleness checks and the retired
 * char compaction (still present in older transcripts). Anything matching these means the original payload is NO LONGER in
 * context — the model cannot quote it.
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
 * Returns true iff every prior read in this list now points to an elided /
 * compacted / stale tool_result (or the tool_result is missing entirely).
 * When true, the model has lost the content — a fresh read is legitimate,
 * not a doom loop.
 *
 * `requiredSpan` (ranged reads only): a prior whose live content no longer
 * SHOWS every requested line — reducer/finalize-cap truncation cuts the tail
 * while the result stays present — counts as elided too. Without this, the
 * refusal/downgrade claims "content is in your context" for lines the model
 * never saw (observed 2026-07-09 on a `[lines 550-1000]` read cut at ~761).
 *
 * Conservative on ambiguity: if ANY prior is still readable (and covering,
 * when a span is required), returns false.
 */
export function allPriorReadsElided(
  prior: Array<{ useId: string }>,
  messages: AgentMessage[],
  requiredSpan?: { start: number; end: number },
): boolean {
  if (prior.length === 0) return false;
  for (const p of prior) {
    const r = findToolResultByUseId(p.useId, messages);
    // Missing tool_result is treated as elided (the pair was dropped by
    // pair-preserving cutoff). Readable & non-elided → still in context.
    if (!r || r.isElided) continue;
    if (requiredSpan) {
      const span = visibleSpanOf(r.content);
      if (!span || span.start > requiredSpan.start || span.end < requiredSpan.end) continue;
    }
    return false;
  }
  return true;
}

/**
 * Latest turn (within the window) at which `path` was mutated, or null. The
 * caller filters out turns older than the prior read it's evaluating.
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
  let body = content;
  // Strip read_file header pattern: "<path> | <N> lines | <ext>\n[lines A-B]...\n"
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
