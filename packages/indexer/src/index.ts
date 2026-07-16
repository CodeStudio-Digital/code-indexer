/**
 * @mcp/indexer — frozen public surface consumed by apps (cli, http-api,
 * mcp-server) and benchmarks. Internal modules live under
 * indexer/, search/, workers/, bootstrap/ and may also be imported via
 * subpaths (e.g. "@mcp/indexer/search/hybrid.js") when callers need a
 * specific class without bloating this barrel.
 */
export { HybridSearch } from './search/hybrid.js';
export type { SearchDiagnostics } from './search/hybrid.js';
export { RecentFilesSource } from './search/recent-files-source.js';
export type {
  RecentFileEntry,
  RecentFilesMatch,
  RecentFilesSourceOptions,
} from './search/recent-files-source.js';

// I5 — multi-action reranker (Sprint 3)
export {
  NullMultiActionReranker,
  SingleActionAdapter,
  weightedActionFusion,
  toRerankResults,
  DEFAULT_ACTION_WEIGHTS,
  type MultiActionRerankerService,
  type MultiActionRerankResult,
  type RerankerAction,
  type ActionWeights,
  type WeightedActionResult,
} from './search/multi-action-reranker.js';
export type {
  EmbeddingService,
} from './search/embeddings.js';
export {
  NullEmbeddingService,
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
