/**
 * Public surface of the documentation-RAG module.
 *
 * Re-exports the user-facing types + classes so consumers (HTTP routes,
 * agent tool, dashboard API) can import from a single path:
 *
 *   import { IndexDocumentationUseCase, DocHybridSearch } from '@mcp/services/services/docs/index.js';
 */
export {
  DRY_RUN_TOKEN_COST_USD_PER_1K,
  IndexDocumentationUseCase,
  normalizeSeedUrl,
} from './index-doc-use-case.js';
export { buildEmbeddingText, hashEmbeddingInput } from './index-doc-use-case/utils.js';
export type {
  IndexDocUseCaseDeps,
  IndexPdfInput,
  IndexUrlInput,
  IndexFolderInput,
  IndexDocStreamCallbacks,
  DocumentationSemanticHooks,
} from './index-doc-use-case.js';

export {
  readFolder,
  readFolderEntry,
  scanFolderFiles,
  FOLDER_HARD_MAX_FILES,
  FOLDER_DEFAULT_MAX_FILES,
  FOLDER_FILE_SIZE_CAP_BYTES,
  FOLDER_DEFAULT_INCLUDE_GLOB,
  FOLDER_DEFAULT_EXCLUDE_GLOB,
} from './folder-reader.js';
export type {
  ReadFolderOptions,
  ReadFolderResult,
  FolderReaderEvent,
  FolderFileEntry,
} from './folder-reader.js';

export { DocHybridSearch, vectorIdForChunk } from './search.js';
export type {
  DocSearchInput,
  DocSearchResult,
  DocSearchDiagnostics,
  DocSearchEnhancements,
  DocHybridSearchEnhancementDeps,
} from './search.js';

export {
  applyThreshold,
  classifyConfidence,
  DEFAULT_MIN_RELEVANCE,
} from './relevance-policy.js';
export type {
  RelevanceSource,
  Confidence,
  ThresholdableResult,
  ThresholdOutcome,
} from './relevance-policy.js';

export { QueryRewriter } from './query-rewriter.js';
export type {
  QueryRewriterOptions,
  RewriteOpts,
  RewriteResult,
} from './query-rewriter.js';

export { Reranker } from './reranker.js';
export type {
  RerankerOptions,
  RerankOpts,
  RerankCandidate,
  RerankResult,
  DocReranker,
} from './reranker.js';
export { CrossEncoderReranker } from './cross-encoder-reranker.js';

export { AutoDiscoveryService, _resetAutoDiscoveryThrottle } from './auto-discovery.js';
export type {
  AutoDiscoveryServiceOpts,
  DepManifest,
  DepSuggestion,
  PackageManager,
  ScanInput,
  ScanResult,
} from './auto-discovery.js';

export { DocError, docErrorStatus } from './errors.js';
export type { DocErrorKind } from './errors.js';

export type { DocIngestEstimate, DocIngestProgress, DocIngestResult, RawPage } from './types.js';

export { PDF_MAX_BYTES, parsePdf } from './pdf-parser.js';
export { UrlFetcher } from './url-fetcher.js';
export { crawlUrl } from './crawler.js';
export { chunkMarkdown, MAX_CHUNK_CHARS, TARGET_CHUNK_CHARS, MIN_CHUNK_CHARS, estimateTokens } from './section-chunker.js';
export { gatePages, heuristicAccepts } from './relevance-gate.js';
export { enrichChunks, enrichChunksBatched } from './enricher.js';
export { extractLinksWithLLM } from './link-extractor.js';
export type { ExtractedLink, LinkExtractorOptions } from './link-extractor.js';

// Progress tracker — read-side for `GET /api/docs/sources/:id/progress`.
export { DocIngestProgressTracker } from './progress-tracker.js';
export type { ProgressSnapshot } from './progress-tracker.js';

// Render backends + bot detection (Tier 1+2 escalation pipeline).
export {
  BrowserBackend,
  EscalatingFetcher,
  PlainFetchBackend,
} from './render-backend.js';
export type {
  BrowserConnector,
  BrowserContextHandle,
  BrowserHandle,
  BrowserPageHandle,
  BrowserResponseHandle,
  RenderBackend,
  RenderResult,
} from './render-backend.js';
export { detectBlocked } from './bot-detection.js';
export { availableDocExtractionWorkers, resolveDocWorkerCount } from './index-doc-use-case/extraction-pool.js';
