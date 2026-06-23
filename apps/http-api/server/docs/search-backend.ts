/**
 * Host-side doc-search backend — the object installed via
 * `setGlobalDocSearch` (main process) and mirrored into the worker pools'
 * doc-deps boxes. Extracted from the inline wrapper that used to live in
 * `server.ts` so the project-scoping policy, the `readChunk` verb and the
 * `<indexed-docs>` hint provider share one home.
 *
 * Scoping policy (migration 134): when the tool call carries a
 * `project_id` and no explicit `collection`, the search is filtered to the
 * project's linked collections — falling back to the global corpus when
 * the project has no links (or the links table predates the migration).
 * `scope: 'all'` opts out per call.
 */
import type { DocHybridSearch, DocSearchInput } from '@mcp/services/services/docs/index.js';
import { DEFAULT_MIN_RELEVANCE } from '@mcp/services/services/docs/index.js';
import type { DocChunk, DocStore } from '@mcp/store/doc-store.js';
import type { DocsHintCollection, DocsHintProvider } from '@mcp/code-agent/core/docs-hint.js';
import { buildDocNavVerbs } from './doc-nav-backend.js';

/** What the `rag_search_docs` tool sends — superset of DocSearchInput. */
export interface BackendSearchInput {
  query: string;
  collection?: string;
  limit?: number;
  /** 'project' (default) = filter to project-linked collections; 'all' = global. */
  scope?: 'project' | 'all';
  /** Session's project id — supplied by the tool from ToolContext. */
  project_id?: number;
}

export interface BackendReadChunkInput {
  chunk_id: number;
  /** Neighbor window by `ord` (same source). Default 1, clamped to [0, 3]. */
  window?: number;
}

export interface DocChunkNeighbor {
  chunk_id: number;
  ord: number;
  heading_path: string | null;
  content: string;
  token_count: number;
  source_uri: string | null;
}

export interface DocChunkRead {
  chunk: {
    chunk_id: number;
    collection: string;
    source_id: number;
    source_uri: string | null;
    heading_path: string | null;
    anchor: string | null;
    api_symbol: string | null;
    api_signature: string | null;
    content: string;
    token_count: number;
    summary: string | null;
    concepts: string[];
  };
  prev: DocChunkNeighbor[];
  next: DocChunkNeighbor[];
}

export interface DocSearchBackendDeps {
  docHybridSearch: DocHybridSearch;
  docStore: DocStore;
}

export function buildDocSearchBackend({ docHybridSearch, docStore }: DocSearchBackendDeps) {
  // Env-flag-aware enhancements — they default ON so the first-line
  // `rag_search_docs` every agent reaches for gets calibrated relevance and
  // an honest "no good match" without opting in. Set to '0' to disable.
  //   DOCS_RAG_REWRITE=0  → query rewriter OFF
  //   DOCS_RAG_RERANK=0   → reranker OFF (also disables calibrated scores)
  // Both still degrade to no-op when the corresponding binding is
  // unconfigured in the admin panel — flags only control the OPT-IN.
  const docsRagRewrite = process.env.DOCS_RAG_REWRITE !== '0';
  const docsRagRerank = process.env.DOCS_RAG_RERANK !== '0';

  return {
    search: async (input: BackendSearchInput) => {
      const { scope, project_id, ...rest } = input;

      // Resolve the project's linked collections. Defensive try/catch: a
      // dev DB that predates migration 134 must degrade to global search,
      // not break every doc search in the process.
      let scoped: Array<{ id: number; name: string }> = [];
      if (!input.collection && scope !== 'all' && project_id != null) {
        try {
          scoped = docStore.listCollectionsForProject(project_id);
        } catch {
          scoped = [];
        }
      }

      const forward: DocSearchInput = {
        // Threshold weak hits so the tool can report "nothing relevant"
        // instead of citing junk. Only bites when rerank produced
        // calibrated scores; a caller-supplied value still wins.
        min_relevance: DEFAULT_MIN_RELEVANCE,
        ...rest,
        enhancements: { rewrite: docsRagRewrite, rerank: docsRagRerank },
      };
      if (scoped.length > 0) forward.collection_ids = scoped.map((c) => c.id);

      const out = await docHybridSearch.search(forward);
      out.diag.scope = scoped.length > 0 ? 'project' : 'all';
      if (scoped.length > 0) out.diag.scoped_collections = scoped.map((c) => c.name);
      return out;
    },

    /**
     * Full-content read of one chunk + its `ord` neighbors (same source).
     * Returns null when the chunk doesn't exist (deleted / bad id) — the
     * tool turns that into a clear "stale chunk_id, search again" message.
     */
    readChunk: async (input: BackendReadChunkInput): Promise<DocChunkRead | null> => {
      const window = clamp(Math.trunc(input.window ?? 1), 0, 3);
      const neighbors = docStore.getChunkNeighbors(input.chunk_id, window);
      const seed = neighbors.find((c) => c.id === input.chunk_id);
      if (!seed) return null;
      const collection = docStore.getCollection(seed.collection_id);
      const toNeighbor = (c: DocChunk): DocChunkNeighbor => ({
        chunk_id: c.id,
        ord: c.ord,
        heading_path: c.heading_path,
        content: c.content,
        token_count: c.token_count,
        source_uri: c.source_uri,
      });
      return {
        chunk: {
          chunk_id: seed.id,
          collection: collection?.name ?? '(unknown)',
          source_id: seed.source_id,
          source_uri: seed.source_uri,
          heading_path: seed.heading_path,
          anchor: seed.anchor,
          api_symbol: seed.api_symbol,
          api_signature: seed.api_signature,
          content: seed.content,
          token_count: seed.token_count,
          summary: seed.summary,
          concepts: seed.concepts,
        },
        prev: neighbors.filter((c) => c.ord < seed.ord).map(toNeighbor),
        next: neighbors.filter((c) => c.ord > seed.ord).map(toNeighbor),
      };
    },

    // Structural navigation (rag_read_doc mode:'section' + rag_doc_outline) —
    // implemented in doc-nav-backend.ts to keep this file under the LOC cap.
    ...buildDocNavVerbs(docStore),
  };
}

/**
 * Synchronous provider behind the per-turn `<indexed-docs>` block. Kept
 * here (not in code-agent) because it owns a DocStore handle; the worker
 * boots build their own instance over the worker-local DB.
 */
export function buildDocsHintProvider(docStore: DocStore): DocsHintProvider {
  return {
    listForProject(projectId: number): DocsHintCollection[] {
      try {
        return docStore.listCollectionsForProject(projectId).map((c) => {
          // Aggregate freshness + types from the collection's sources so the
          // per-turn hint can flag staleness and signal what kind of docs
          // these are. Cheap — the hint block is cached for 30s per project.
          const sources = docStore.listSourcesByCollection(c.id);
          // SQLite timestamps are fixed-width UTC → lexicographic max == latest.
          const lastIndexed = sources.reduce<string | null>(
            (max, s) =>
              s.last_indexed_at && (max == null || s.last_indexed_at > max)
                ? s.last_indexed_at
                : max,
            null,
          );
          const docTypes = Array.from(
            new Set(sources.map((s) => s.doc_type).filter((t) => t && t !== 'mixed')),
          );
          return {
            name: c.name,
            description: c.description,
            chunk_count: c.chunk_count,
            last_indexed_at: lastIndexed,
            doc_types: docTypes,
          };
        });
      } catch {
        return [];
      }
    },
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
