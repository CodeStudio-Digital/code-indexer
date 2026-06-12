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
    return `- ${c.name}${desc} (${c.chunk_count} sections)`;
  });
  const overflow =
    collections.length > shown.length
      ? `\n…and ${collections.length - shown.length} more (rag_search_docs covers all of them).`
      : '';
  return [
    '<indexed-docs>',
    'This project has indexed documentation collections (fresher than your training data):',
    ...lines,
    'Search them with rag_search_docs BEFORE answering from memory about these libraries; ' +
      'read any hit in full with rag_read_doc({chunk_id}). For multi-section questions, ' +
      "docs_deep_research (unlock via expand_toolset('navigate')) runs a cited research pass." +
      overflow,
    '</indexed-docs>',
  ].join('\n');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
