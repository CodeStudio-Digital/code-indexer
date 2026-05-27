import type { CodeIndexDB } from '@mcp/store/db.js';
import type { ProviderStore } from '@mcp/store/provider-store.js';
import {
  createEmbeddingService,
  type EmbeddingService,
} from '@mcp/indexer/search/embeddings.js';
import {
  createVectorStore,
  NullVectorStore,
  type VectorStore,
} from '@mcp/store/vectors.js';
import { HyDEService } from '@mcp/indexer/search/hyde.js';
import { HybridSearch } from '@mcp/indexer/search/hybrid.js';
import type { RerankerService } from '@mcp/indexer/search/reranker.js';
import type { RecentFilesSource } from '@mcp/indexer/search/recent-files-source.js';
import type { TelemetrySink } from '@mcp/candidate-pipeline';

export interface SearchBundle {
  embeddingService: EmbeddingService;
  vectorStore: VectorStore;
  /** Non-null variant; null when the configured store is `NullVectorStore`. */
  searchableVectorStore: VectorStore | null;
  hybridSearch: HybridSearch;
}

/**
 * Composes the full search stack (embeddings + vector store + HybridSearch)
 * from a ProviderStore. Consolidates the 3-way duplication that existed in
 * http-api/deps.ts, mcp-server/context.ts, and cli/helpers.ts.
 *
 * `reranker` is optional — only the MCP server currently wires it.
 * `recentFilesSource` is optional (I2 — Sprint 1) — only consulted when
 * `MCP_PIPELINES_RECENT_FILES_SOURCE=1`; absence leaves the legacy
 * 2-stream (FTS + Vector) RRF merge bit-identical.
 */
export function createSearchBundle(
  db: CodeIndexDB,
  providerStore: ProviderStore,
  reranker?: RerankerService,
  recentFilesSource?: RecentFilesSource,
  pipelineTelemetry?: TelemetrySink,
): SearchBundle {
  const embeddingService = createEmbeddingService(providerStore);
  const vectorStore = createVectorStore(providerStore);
  const searchableVectorStore =
    vectorStore instanceof NullVectorStore ? null : vectorStore;

  const hydeService = new HyDEService(providerStore);
  const hybridSearch = new HybridSearch(
    db,
    searchableVectorStore,
    embeddingService,
    hydeService,
    reranker,
    recentFilesSource,
    pipelineTelemetry,
  );

  return { embeddingService, vectorStore, searchableVectorStore, hybridSearch };
}

/**
 * Derive short diagnostic kind labels (e.g. "cloudflare", "bedrock-titan")
 * from a service's class name. Used by the admin/debug panel.
 */
export function deriveKindLabel(
  instance: { constructor: { name: string } },
  suffix: 'EmbeddingService' | 'VectorStore',
): string {
  return (
    instance.constructor.name
      .replace(suffix, '')
      .replace(/([A-Z])/g, (_, c: string, i: number) => (i ? '-' : '') + c.toLowerCase())
      .replace(/^-/, '') || 'unknown'
  );
}
