/**
 * `<indexed-docs>` — per-turn awareness block listing the doc collections
 * linked to the session's project (migration 134).
 *
 * Why: `rag_search_docs` existed for months and agents barely called it —
 * the tool description is static, so the model never learns WHICH stacks
 * have indexed docs. This block closes that gap with one or two lines per
 * linked collection, injected next to `<active-context>` on the trailing
 * user message (NOT the system prompt — prefix cache stays intact). Zero
 * tokens when the project has no links.
 *
 * Wiring mirrors `rag-search-docs.ts`: a process-global provider set at
 * boot by `server.ts` (main) and by each worker boot over its local DB —
 * module globals do NOT cross worker_threads.
 */

export interface DocsHintCollection {
  name: string;
  description: string | null;
  chunk_count: number;
  /** Most recent `last_indexed_at` across the collection's sources (freshness). */
  last_indexed_at?: string | null;
  /** Distinct non-`mixed` documentation types present in the collection. */
  doc_types?: string[];
}

export interface DocsHintProvider {
  /** Synchronous on purpose — backed by better-sqlite3 reads. */
  listForProject(projectId: number): DocsHintCollection[];
}

let globalProvider: DocsHintProvider | null = null;

/** Pass `null` to detach (tests). Clears the block cache either way. */
export function setGlobalDocsHintProvider(provider: DocsHintProvider | null): void {
  globalProvider = provider;
  cache.clear();
}

export function getGlobalDocsHintProvider(): DocsHintProvider | null {
  return globalProvider;
}

/** Rendered-block cache — the hint is rebuilt at most every 30s per project. */
const TTL_MS = 30_000;
const MAX_COLLECTIONS = 10;
const cache = new Map<number, { at: number; block: string | null }>();

/**
 * Build the `<indexed-docs>` block for a project, or null when there is
 * nothing to say (no provider wired, no projectId, no linked collections,
 * provider error). Null means the caller skips the block entirely.
 */
export function buildIndexedDocsBlock(projectId?: number): string | null {
  if (!globalProvider || projectId == null) return null;
  const hit = cache.get(projectId);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.block;

  let block: string | null = null;
  try {
    block = render(globalProvider.listForProject(projectId));
  } catch {
    block = null;
  }
  cache.set(projectId, { at: now, block });
  return block;
}

function render(collections: DocsHintCollection[]): string | null {
  if (collections.length === 0) return null;
  const shown = collections.slice(0, MAX_COLLECTIONS);
  const lines = shown.map((c) => {
    const desc = c.description ? ` — ${truncate(c.description, 100)}` : '';
    // Surface the doc TYPE(s) so the agent knows what to expect (API
    // signatures vs prose) and FRESHNESS so it can flag stale-version risk.
    const types = c.doc_types && c.doc_types.length > 0 ? `, ${c.doc_types.join('/')}` : '';
    const fresh = c.last_indexed_at ? `, updated ${relativeAge(c.last_indexed_at)}` : '';
    return `- ${c.name}${desc} (${c.chunk_count} sections${types}${fresh})`;
  });
  const overflow =
    collections.length > shown.length
      ? `\n…and ${collections.length - shown.length} more (rag_search_docs covers all of them).`
      : '';
  return [
    '<indexed-docs>',
    'This project has indexed documentation collections (fresher than your training data):',
    ...lines,
    // Compact usage protocol — distilled from the DocsAgent's contract so the
    // coder handles the corpus the same way: search-first, trust calibrated
    // relevance, read full before answering, cite the source, be honest about gaps.
    'How to use them: search with rag_search_docs BEFORE answering from memory about these ' +
      'libraries; trust the calibrated Relevance (0-1) over snippet order; read any promising hit ' +
      'in FULL with rag_read_doc({chunk_id}) before you rely on it, and cite the Source it prints. ' +
      "If the search reports no good match, tell the user it isn't covered — don't guess. For broad " +
      "multi-section questions, docs_deep_research (unlock via expand_toolset('navigate')) runs a cited pass." +
      overflow,
    '</indexed-docs>',
  ].join('\n');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Coarse "updated 3d ago" label. SQLite `datetime('now')` is UTC w/o zone. */
function relativeAge(stamp: string): string {
  const t = parseUtc(stamp);
  if (!Number.isFinite(t)) return 'recently';
  const ms = Date.now() - t;
  if (ms < 0) return 'just now';
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(ms / 3_600_000);
  return hours >= 1 ? `${hours}h ago` : 'today';
}

function parseUtc(stamp: string): number {
  // Normalize "YYYY-MM-DD HH:MM:SS" (no zone) → ISO UTC before parsing.
  const norm = /[zZ]|[+-]\d\d:?\d\d$/.test(stamp) ? stamp : stamp.replace(' ', 'T') + 'Z';
  return Date.parse(norm);
}
