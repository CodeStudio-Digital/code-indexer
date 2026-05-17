import type { CodeIndexDB } from '@mcp/store/db.js';
import type { DBFile, DBSymbol, HybridSearchResult } from '@mcp/shared/types.js';

/**
 * Bundle a set of search results into a fixed-token-budget context
 * payload that callers (the coder agent, the MCP `search_context` tool)
 * can drop straight into a prompt. Two goals:
 *
 *   1. Cap context so a wide search doesn't quietly blow up token cost.
 *   2. Dedup overlapping hits — a file summary + every symbol from that
 *      file would otherwise repeat the same path/concepts three times.
 *
 * The function does not query the LLM, doesn't call the vector store —
 * it just shapes results the caller already fetched. That keeps the
 * helper cheap (sync) and easy to test.
 */

export type BundleItemKind = 'file_summary' | 'symbol_signature' | 'symbol_body' | 'snapshot';

export interface BundleItem {
  kind: BundleItemKind;
  path?: string;
  line?: number | null;
  text: string;
  tokens: number;
  score: number;
}

export interface ContextBundle {
  query: string;
  items: BundleItem[];
  tokensUsed: number;
  tokensBudget: number;
  truncated: boolean;
}

export interface ContextBundleOptions {
  /** Hard cap on total tokens emitted across all items. Default 8000. */
  tokensBudget?: number;
  /** Cap per individual item — keeps a single huge body from crowding out everything else. Default 1500. */
  perItemMax?: number;
  /** Include snapshots from the project (queried via `db.searchSnapshots`). Default true. */
  includeSnapshots?: boolean;
}

/** Rough char→token ratio matching `embeddings.ts` and Anthropic's heuristic. */
const CHARS_PER_TOKEN = 4;

function estTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1) + '…';
}

/**
 * Build a bundle from search hits. Callers pass already-ranked
 * `HybridSearchResult[]` (e.g. from `HybridSearch.search`) and the bundle
 * picks the cheapest representation for each: file → summary, symbol →
 * signature + comment.
 *
 * Order of operations matters because we stop adding items once the
 * budget is hit:
 *   1. Snapshots first — they're short and high-signal.
 *   2. File summaries — one line of context per file.
 *   3. Symbol signatures — what the file exposes.
 *   4. Symbol bodies (only for the top-scoring hits) if budget remains.
 *
 * Dedup runs across kinds: if a file's summary and one of its symbols
 * both rank highly, we keep both because they answer different
 * questions, but we drop a *second* symbol from the same file unless
 * its score is materially higher.
 */
export function buildContextBundle(
  query: string,
  hits: HybridSearchResult[],
  db: CodeIndexDB,
  projectId: number,
  options?: ContextBundleOptions,
): ContextBundle {
  const tokensBudget = options?.tokensBudget ?? 8000;
  const perItemMax = options?.perItemMax ?? 1500;
  const includeSnapshots = options?.includeSnapshots ?? true;

  const items: BundleItem[] = [];
  let tokensUsed = 0;
  let truncated = false;

  const seenPaths = new Set<string>();
  const symbolsPerPath = new Map<string, number>();
  const MAX_SYMBOLS_PER_FILE = 2;

  function tryPush(item: BundleItem): boolean {
    const remaining = tokensBudget - tokensUsed;
    if (remaining <= 0) {
      truncated = true;
      return false;
    }
    if (item.tokens > remaining) {
      // Try to shrink the item to fit; if not feasible, drop it.
      const allowedChars = remaining * CHARS_PER_TOKEN;
      if (allowedChars < 80) {
        truncated = true;
        return false;
      }
      item.text = clip(item.text, allowedChars);
      item.tokens = estTokens(item.text);
    }
    items.push(item);
    tokensUsed += item.tokens;
    return true;
  }

  // ── 1. Snapshots ───────────────────────────────────────────────
  if (includeSnapshots && tokensUsed < tokensBudget) {
    try {
      const snaps = db.searchSnapshots(projectId, query).slice(0, 3);
      for (const snap of snaps) {
        const text = `[${snap.category}] ${snap.title}\n${snap.content}`;
        const clipped = clip(text, perItemMax * CHARS_PER_TOKEN);
        if (!tryPush({ kind: 'snapshot', text: clipped, tokens: estTokens(clipped), score: 1 })) break;
      }
    } catch {
      /* snapshots are best-effort — never fail the bundle */
    }
  }

  // ── 2. File summaries ──────────────────────────────────────────
  for (const r of hits) {
    if (r.type !== 'file') continue;
    const f = r.data as DBFile;
    if (seenPaths.has(f.path)) continue;
    seenPaths.add(f.path);

    const concepts = (() => {
      try {
        return JSON.parse(f.concepts || '[]') as string[];
      } catch {
        return [];
      }
    })();
    const text = `## ${f.path}\n${f.summary}${concepts.length ? `\nConcepts: ${concepts.join(', ')}` : ''}`;
    const clipped = clip(text, perItemMax * CHARS_PER_TOKEN);
    if (!tryPush({ kind: 'file_summary', path: f.path, text: clipped, tokens: estTokens(clipped), score: r.score })) {
      break;
    }
  }

  // ── 3. Symbol signatures ───────────────────────────────────────
  for (const r of hits) {
    if (r.type !== 'symbol') continue;
    const s = r.data as DBSymbol;
    const path = s.file_path;
    const used = symbolsPerPath.get(path) ?? 0;
    if (used >= MAX_SYMBOLS_PER_FILE) continue;

    const text = [
      `${s.kind} ${s.name}`,
      s.signature ? `  ${s.signature}` : '',
      s.comment ? `  // ${s.comment}` : '',
      `  in ${s.file_path}${s.line ? `:${s.line}` : ''}`,
    ]
      .filter(Boolean)
      .join('\n');
    const clipped = clip(text, perItemMax * CHARS_PER_TOKEN);
    if (
      !tryPush({
        kind: 'symbol_signature',
        path,
        line: s.line,
        text: clipped,
        tokens: estTokens(clipped),
        score: r.score,
      })
    ) {
      break;
    }
    symbolsPerPath.set(path, used + 1);
  }

  return { query, items, tokensUsed, tokensBudget, truncated };
}
