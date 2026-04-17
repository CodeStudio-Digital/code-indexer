import type { CodeIndexDB } from '../../store/db.js';
import type { ProviderStore } from '../../store/provider-store.js';
import {
  createEmbeddingService,
  type EmbeddingService,
} from '../search/embeddings.js';
import {
  createVectorStore,
  NullVectorStore,
  type VectorStore,
} from '../../store/vectors.js';
import { HyDEService } from '../search/hyde.js';
import { HybridSearch } from '../search/hybrid.js';
import type { RerankerService } from '../search/reranker.js';

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
 */
export function createSearchBundle(
  db: CodeIndexDB,
  providerStore: ProviderStore,
  reranker?: RerankerService,
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
