/**
 * @mcp/indexer — frozen public surface consumed by apps (cli, http-api,
 * mcp-server) and benchmarks. Internal modules live under
 * indexer/, search/, workers/, bootstrap/ and may also be imported via
 * subpaths (e.g. "@mcp/indexer/search/hybrid.js") when callers need a
 * specific class without bloating this barrel.
 */
export { IndexAgent } from './indexer/indexer.js';
export { HybridSearch } from './search/hybrid.js';
export type { SearchDiagnostics } from './search/hybrid.js';
export { createReranker } from './search/reranker.js';
export type {
  EmbeddingService,
} from './search/embeddings.js';
export {
  NullEmbeddingService,
  createEmbeddingService,
} from './search/embeddings.js';
export type { VectorStore } from '@mcp/store/vectors.js';
export { ModelDiscovery } from './indexer/providers/model-discovery.js';
export { refreshAllProviderModels } from './indexer/providers/scheduled-refresh.js';
export {
  createAndSeedProviderStore,
  createSearchBundle,
  deriveKindLabel,
} from './bootstrap/index.js';
export type { SearchBundle } from './bootstrap/search-bundle.js';
