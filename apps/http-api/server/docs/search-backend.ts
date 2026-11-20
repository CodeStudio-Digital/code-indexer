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
 * the catalog confirms that the project has no links.
 * `scope: 'all'` opts out per call.
 */
import type { DocHybridSearch, DocSearchInput } from '@mcp/services/services/docs/index.js';
import { DEFAULT_MIN_RELEVANCE } from '@mcp/services/services/docs/index.js';
import { resolveDocSearchScope } from '@mcp/services/services/docs/search-scope.js';
import type { DocStore } from '@mcp/store/doc-store.js';
import type { DocsHintCollection, DocsHintProvider } from '@mcp/code-agent/core/docs-hint.js';
import { buildDocNavVerbs } from './doc-nav-backend.js';
import { createHash } from 'node:crypto';

/** What the `rag_search_docs` tool sends — superset of DocSearchInput. */
interface BackendSearchInput {
  query: string;
  collection?: string;
  limit?: number;
  /** 'project' (default) = filter to project-linked collections; 'all' = global. */
  scope?: 'project' | 'all';
  /** Session's project id — supplied by the tool from ToolContext. */
  project_id?: number;
}

interface BackendReadChunkInput {
  chunk_id: number;
  /** Neighbor window by `ord` (same source). Default 1, clamped to [0, 3]. */
  window?: number;
}

interface DocChunkNeighbor {
  chunk_id: number;
  ord: number;
  heading_path: string | null;
  content: string;
  token_count: number;
  source_uri: string | null;
}

interface DocChunkRead {
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

interface DocSearchBackendDeps {
  docHybridSearch: DocHybridSearch;
  docStore: DocStore;
}

export function buildDocSearchBackend({ docHybridSearch, docStore }: DocSearchBackendDeps) {
  // The held-out document passages lost Recall@5 with the optional cross-encoder.
  // Operators can enable it for a collection workload they have evaluated.
  const docsRagRewrite = process.env.DOCS_RAG_REWRITE !== '0';
  const docsRagRerank = process.env.DOCS_RAG_RERANK === '1';

  return {
    search: async (input: BackendSearchInput, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const { scope, project_id, ...rest } = input;

      const { scope: resolvedScope, collections: scoped } = resolveDocSearchScope(docStore, input);

      const forward: DocSearchInput = {
        // Threshold weak hits so the tool can report "nothing relevant"
        // instead of citing junk. Only bites when rerank produced
        // calibrated scores; a caller-supplied value still wins.
        min_relevance: DEFAULT_MIN_RELEVANCE,
        ...rest,
        signal,
        enhancements: { rewrite: docsRagRewrite && shouldRewrite(input.query), rerank: docsRagRerank },
      };
      if (scoped.length > 0) forward.collection_ids = scoped.map((c) => c.id);

      const started = Date.now();
      const out = await docHybridSearch.search(forward);
      signal?.throwIfAborted();
      out.diag.scope = resolvedScope;
      if (scoped.length > 0) out.diag.scoped_collections = scoped.map((c) => c.name);
      const explicitCollectionId = input.collection ? docStore.getCollectionByName(input.collection)?.id : undefined;
      try {
        // Host-side callers must never park Electron-main behind a telemetry
        // row. Agent workers batch/retry these events; this fallback simply
        // drops a contested best-effort sample.
        docStore.withBusyTimeout(0, () =>
          docStore.recordDocSearchEvent({
            project_id: project_id,
            query_hash: createHash('sha256').update(input.query).digest('hex'),
            scope: resolvedScope,
            collection_ids: explicitCollectionId != null ? [explicitCollectionId] : scoped.map((c) => c.id),
            mode: out.diag.mode,
            duration_ms: Date.now() - started,
            fts_hits: out.diag.fts_hits,
            vector_hits: out.diag.vector_hits,
            stale_vector_hits: out.diag.stale_vector_hits,
            vector_coverage: out.diag.vector_coverage,
            top_relevance: out.diag.top_relevance,
            no_good_match: out.diag.no_good_match,
            result_count: out.results.length,
          }));
      } catch { /* telemetry must never break retrieval */ }
      return out;
    },

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
          const health = sources.map((source) => docStore.getSourceHealth(source.id)).filter((h) => h != null);
          const persisted = health.reduce((sum, h) => sum + h.chunks_persisted, 0);
          const embedded = health.reduce((sum, h) => sum + h.chunks_embedded, 0);
          return {
            name: c.name,
            description: c.description,
            chunk_count: c.chunk_count,
            last_indexed_at: lastIndexed,
            doc_types: docTypes,
            lexical_ready: persisted > 0,
            vector_coverage: persisted > 0 ? embedded / persisted : 0,
            enrichment_ready: health.length > 0 && health.every((h) => h.enrichment_ready),
            updating: sources.some((source) => source.status === 'fetching' || source.status === 'indexing'),
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

function shouldRewrite(query: string): boolean {
  const q = query.trim();
  if (!q) return false;
  // Exact API/symbol lookups already have excellent FTS recall; rewriting
  // adds latency and can dilute literal identifiers/version strings.
  if (/\b[A-Za-z_$][\w$]*(?:[.#:][\w$]+)+(?:\([^)]*\))?\b/.test(q)) return false;
  if (/\b[A-Za-z_$][\w$]*\([^)]*\)/.test(q)) return false;
  if (/^[A-Za-z_$][\w$]{2,}$/.test(q)) return false;
  return q.split(/\s+/).length >= 4 || /\b(como|por que|quando|diferença|padrão|how|why|when|difference|pattern)\b/i.test(q);
}
