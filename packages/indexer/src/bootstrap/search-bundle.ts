import type { CodeIndexDB } from '@mcp/store/db.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import { NullVectorStore, type VectorStore } from '@mcp/store/vectors.js';
import { HyDEService } from '@mcp/indexer/search/hyde.js';
import { HybridSearch } from '@mcp/indexer/search/hybrid.js';
import type { RerankerService } from '@mcp/indexer/search/reranker.js';
import type { RecentFilesSource } from '@mcp/indexer/search/recent-files-source.js';
import type { TelemetrySink } from '@mcp/candidate-pipeline';
import type { PipelineProviderResolver } from '@mcp/services/pipelines/index.js';

export interface SearchBundle {
  embeddingService: EmbeddingService;
  vectorStore: VectorStore;
  /** Non-null variant; null when the configured store is `NullVectorStore`. */
  searchableVectorStore: VectorStore | null;
  hybridSearch: HybridSearch;
}

/**
 * Composes the full search stack from explicitly supplied worker-owned
 * embeddings, vectors and reranking services.
 *
 * `recentFilesSource` may be absent; the remaining canonical sources keep
 * the same RRF pipeline.
 */
export function createSearchBundle(
  db: CodeIndexDB,
  reranker: RerankerService,
  recentFilesSource: RecentFilesSource | undefined,
  pipelineTelemetry: TelemetrySink | undefined,
  /**
   * Embedding service resolved from the active semantic profile/generation.
   * The http-api layer passes a worker-backed wrapper here (so local ONNX
   * inference runs off the main thread). This is the desired-profile service
   * used by indexing; query overrides below are intentionally separate and
   * resolve active-generation snapshots. There is no in-process fallback.
   */
  embeddingOverride: EmbeddingService,
  /** Local distributed semantic router. When supplied, provider-configured
   * remote vector stores are not constructed or consulted. */
  vectorOverride: VectorStore,
  /** Query-only Code service bound to each namespace's active generation. */
  queryEmbeddingOverride: EmbeddingService,
  /** Query-only Knowledge service used by snapshot retrieval. */
  knowledgeQueryEmbeddingOverride: EmbeddingService,
  /** Optional HyDE pipeline binding resolver. No resolver (or no
   * `indexer_search/hyde` binding) means query expansion is disabled. */
  hydeResolver?: PipelineProviderResolver | null,
): SearchBundle {
  // Ownership is explicit: this compositor is incapable of constructing an
  // ONNX session or opening sqlite-vec. The desktop passes worker proxies; if
  // the worker is unavailable it passes Null services and search stays FTS.
  const embeddingService = embeddingOverride;
  const queryEmbeddingService = queryEmbeddingOverride;
  const knowledgeQueryEmbeddingService = knowledgeQueryEmbeddingOverride;
  const rawVectorStore = vectorOverride;
  const searchableRaw = rawVectorStore instanceof NullVectorStore ? null : rawVectorStore;
  const vectorStore = rawVectorStore;
  const searchableVectorStore = searchableRaw;

  const hydeService = new HyDEService(hydeResolver ?? null);
  const hybridSearch = new HybridSearch(
    db,
    searchableVectorStore,
    queryEmbeddingService,
    hydeService,
    // HybridSearch is the fail-open boundary; strict propagation preserves
    // the reason in SearchDiagnostics while still returning the RRF order.
    reranker,
    recentFilesSource,
    pipelineTelemetry,
    knowledgeQueryEmbeddingService,
  );

  return {
    embeddingService,
    vectorStore,
    searchableVectorStore,
    hybridSearch,
  };
}

/**
 * Derive short diagnostic kind labels (e.g. "cloudflare", "bedrock-titan")
 * from a service's class name. Used by the admin/debug panel.
 */
export function deriveKindLabel(
  instance: { constructor: { name: string } },
  suffix: 'EmbeddingService' | 'VectorStore',
): string {
  const real = instance;
  return (
    real.constructor.name
      .replace(suffix, '')
      .replace(/([A-Z])/g, (_, c: string, i: number) => (i ? '-' : '') + c.toLowerCase())
      .replace(/^-/, '') || 'unknown'
  );
}
