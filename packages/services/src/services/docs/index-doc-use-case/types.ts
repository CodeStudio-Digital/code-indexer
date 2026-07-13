import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import type { DocCrawlConfig, DocStore, DocType } from '@mcp/store/doc-store.js';
import type { DocEnrichmentMode } from '@mcp/store/doc-store.js';
import type { DocIngestPerformanceProfile } from '@mcp/store/doc-store.js';
import type { PipelineProviderResolver } from '../../../pipelines/index.js';
import type {
  DocIngestEstimate,
  DocIngestProgress,
  DocIngestResult,
} from '../types.js';

/** Approximate token-cost knob for the dry-run preview. */
export const DEFAULT_DRY_RUN_TOKEN_COST_USD_PER_1K = 0.00002;
/** Cap on chunks per source — protects FTS5 explosion on giant PDFs. */
export const HARD_MAX_CHUNKS_PER_SOURCE = 50_000;
/** Embedding batch size — most providers tolerate 100; our embedder rebatches. */
export const EMBED_BATCH_SIZE = 64;
/**
 * Parallel workers in `embedAndUpsert`. Each pulls EMBED_BATCH_SIZE chunks off
 * a shared cursor and runs embed→upsert→SQLite back-to-back. 4 workers × ~1-2
 * req/s per worker = ~8 req/s peak, comfortably under Cloudflare's free-tier
 * 50/s ceiling.
 */
export const EMBED_CONCURRENCY = 4;
/**
 * Cap on how many times the sweeper retries a single tombstone before giving
 * up. Keeps the queue from growing unbounded when an ID never existed
 * remotely or when the remote keeps rejecting forever.
 */
export const MAX_TOMBSTONE_RETRIES = 5;

/**
 * Pre-flight summary do `folder-reader`: quantos arquivos o glob encontrou
 * (`totalMatches`), quantos serão de fato processados (`willProcess`, após
 * cap), e qual o cap em vigor. Só `indexFolder` emite — `indexUrl`/`indexPdf`
 * não chamam onScan.
 */
export interface DocIngestScanSummary {
  totalMatches: number;
  willProcess: number;
  cap: number;
}

export interface IndexDocStreamCallbacks {
  onStart?: (p: { source_id: number; collection_id: number; started_at: string }) => void | Promise<void>;
  /**
   * Folder pre-flight: glob() encontrou X arquivos, vai processar Y (cap Z).
   * Emite UMA vez, antes do primeiro `progress`. Em URL/PDF nunca dispara.
   */
  onScan?: (p: DocIngestScanSummary) => void | Promise<void>;
  onProgress?: (p: DocIngestProgress) => void | Promise<void>;
  onDone?: (r: DocIngestResult) => void | Promise<void>;
  onError?: (message: string) => void | Promise<void>;
}

export interface IndexDocUseCaseDeps {
  docStore: DocStore;
  embeddingService: EmbeddingService | null;
  vectorStore: VectorStore | null;
  pipelineProviderResolver: PipelineProviderResolver;
  /**
   * Optional render backend for URL ingestion. When provided the crawler
   * routes page fetches through it (typically an `EscalatingFetcher`).
   * When omitted the crawler instantiates a `PlainFetchBackend` (test path).
   */
  renderBackend?: import('../render-backend.js').RenderBackend;
  /**
   * Optional in-memory progress tracker. Wraps `onProgress` so the latest
   * frame per source is cached and queryable via `GET /api/docs/sources/:id/progress`.
   */
  progressTracker?: import('../progress-tracker.js').DocIngestProgressTracker;
  /** Optional context for hierarchical provider resolution. */
  resolveContext?: { sessionId?: number; companySessionId?: number; templateId?: number };
}

export interface IndexPdfInput {
  collectionId: number;
  fileName: string;
  bytes: Uint8Array;
  contentType?: string;
  title?: string;
  /** Kind of documentation (migration 149). Defaults to 'mixed' downstream. */
  docType?: DocType;
}

export interface IndexUrlInput {
  collectionId: number;
  url: string;
  crawl?: DocCrawlConfig;
  title?: string;
  /** Kind of documentation (migration 149). Defaults to 'mixed' downstream. */
  docType?: DocType;
}

/**
 * Input para indexação por pasta (migration 103). `rootPath` é absoluto; a
 * validação síncrona (existe + é dir + readable) vive no route HTTP.
 */
export interface IndexFolderInput {
  collectionId: number;
  rootPath: string;
  title?: string;
  /** Kind of documentation (migration 149). Defaults to 'mixed' downstream. */
  docType?: DocType;
  enrichmentMode?: DocEnrichmentMode;
  folder?: {
    include_glob?: string | null;
    exclude_glob?: string | null;
    max_files?: number | null;
    /** Default true: pula o LLM gate (docs locais geralmente curados). */
    bypass_relevance_gate?: boolean;
    performance_profile?: DocIngestPerformanceProfile;
    worker_count?: number | null;
  };
  /** Internal: continue a paused/limit-paused persisted run. */
  resumeRunId?: number;
}

export type { DocIngestEstimate, DocIngestProgress, DocIngestResult } from '../types.js';
