/**
 * IndexDocumentationUseCase — orchestrates end-to-end ingestion of a single
 * doc source (PDF / URL / folder) into the global doc corpus.
 *
 * Public API. Implementation lives under `./index-doc-use-case/`:
 *   - types.ts          — public input/callback shapes + tunable constants
 *   - utils.ts          — hashing, URL/file normalisation, embedding text builder
 *   - source-helpers.ts — requireCollection / ensureSource / estimateFromPages
 *   - delete.ts         — deleteAndCleanup + sweepTombstones
 *   - embed-upsert.ts   — worker-pool embed+upsert + retryEmbeddings
 *   - run-ingest.ts     — 7-phase pipeline orchestrator (fetch→gate→chunk→…)
 *   - strategies.ts     — PDF / URL / folder entry points
 *
 * Concurrency is enforced at the source level by `DocStore.tryAcquireSource`,
 * which atomically flips `status` to `fetching` only when it wasn't already
 * `fetching|indexing`. A second concurrent call gets `DocError('already_running')`.
 */
import {
  deleteAndCleanup,
  sweepTombstones as sweepTombstonesFn,
  type DeleteResult,
  type SweepResult,
} from './index-doc-use-case/delete.js';
import {
  retryEmbeddings as retryEmbeddingsFn,
  type RetryEmbeddingsCallbacks,
  type RetryEmbeddingsResult,
  type RetryEmbeddingsScope,
} from './index-doc-use-case/embed-upsert.js';
import {
  indexFolder as indexFolderFn,
  indexPdf as indexPdfFn,
  indexUrl as indexUrlFn,
  dryRunPdf as dryRunPdfFn,
  dryRunUrl as dryRunUrlFn,
} from './index-doc-use-case/strategies.js';
import { DEFAULT_DRY_RUN_TOKEN_COST_USD_PER_1K } from './index-doc-use-case/types.js';
import { docNamespace } from '@mcp/shared/vector-namespace.js';
import type {
  DocIngestEstimate,
  DocIngestResult,
  IndexDocStreamCallbacks,
  IndexDocUseCaseDeps,
  IndexFolderInput,
  IndexPdfInput,
  IndexUrlInput,
} from './index-doc-use-case/types.js';

// Re-exports — preserve external API.
export type {
  IndexDocStreamCallbacks,
  IndexDocUseCaseDeps,
  IndexPdfInput,
  IndexUrlInput,
  IndexFolderInput,
  DocIngestScanSummary,
} from './index-doc-use-case/types.js';
export { normalizeSeedUrl } from './index-doc-use-case/utils.js';

/** Exported for tests — they pin the value. */
export const DRY_RUN_TOKEN_COST_USD_PER_1K = DEFAULT_DRY_RUN_TOKEN_COST_USD_PER_1K;

export class IndexDocumentationUseCase {
  constructor(private deps: IndexDocUseCaseDeps) {}

  // ─── PDF ─────────────────────────────────────────────────────────
  async indexPdf(input: IndexPdfInput, callbacks?: IndexDocStreamCallbacks): Promise<DocIngestResult> {
    return indexPdfFn(this.deps, input, callbacks);
  }
  async dryRunPdf(input: IndexPdfInput): Promise<DocIngestEstimate> {
    return dryRunPdfFn(input);
  }

  // ─── URL ─────────────────────────────────────────────────────────
  async indexUrl(input: IndexUrlInput, callbacks?: IndexDocStreamCallbacks): Promise<DocIngestResult> {
    return indexUrlFn(this.deps, input, callbacks);
  }
  async dryRunUrl(input: IndexUrlInput): Promise<DocIngestEstimate> {
    return dryRunUrlFn(input);
  }

  // ─── Folder (migration 103) ──────────────────────────────────────
  async indexFolder(input: IndexFolderInput, callbacks?: IndexDocStreamCallbacks): Promise<DocIngestResult> {
    return indexFolderFn(this.deps, input, callbacks);
  }

  // ─── Delete + remote vector cleanup ──────────────────────────────
  /**
   * Delete a source row, cascade-wipe its chunks + chunk_vectors in SQLite,
   * and try to remove the corresponding embeddings from the remote vector
   * store. If the remote call fails, the leftover ids are written to
   * `doc_vector_tombstones` so a future sweep can retry — user intent
   * (source gone) is always fulfilled even when the remote store is down.
   */
  async deleteSource(sourceId: number): Promise<DeleteResult> {
    // Resolve the collection BEFORE the delete cascades it away — its namespace
    // lets backends with namespace-scoped ids (Pinecone) target the right one.
    const collectionId = this.deps.docStore.getSource(sourceId)?.collection_id;
    return deleteAndCleanup(
      this.deps.docStore,
      this.deps.vectorStore,
      () => this.deps.docStore.listVectorIdsForSource(sourceId),
      () => { this.deps.docStore.deleteSource(sourceId); },
      collectionId != null ? docNamespace(collectionId) : undefined,
    );
  }

  /** Same as `deleteSource` but for an entire collection (two-hop FK cascade). */
  async deleteCollection(collectionId: number): Promise<DeleteResult> {
    return deleteAndCleanup(
      this.deps.docStore,
      this.deps.vectorStore,
      () => this.deps.docStore.listVectorIdsForCollection(collectionId),
      () => { this.deps.docStore.deleteCollection(collectionId); },
      docNamespace(collectionId),
    );
  }

  /**
   * Drain pending tombstones — try `vectorStore.deleteByIds` for the batch,
   * remove succeeding rows, bump retry_count on the rest. Called best-effort
   * at boot from `server.ts` and exposed via `POST /api/docs/vectors/sweep`.
   */
  async sweepTombstones(limit: number = 500): Promise<SweepResult> {
    return sweepTombstonesFn(this.deps.docStore, this.deps.vectorStore, limit);
  }

  // ─── Re-embed missing ────────────────────────────────────────────
  /**
   * Re-embed chunks whose `embedding_hash IS NULL`. Scope is explicit:
   * `sourceId` (preferred for stuck-source recovery), `collectionId`, or
   * nothing (entire corpus — used by `POST /api/docs/embeddings/retry`).
   *
   * Uses the same worker-pool pattern as `embedAndUpsert` so a stuck source
   * with 5000 missing chunks doesn't take 15 minutes sequentially.
   */
  async retryEmbeddings(
    scope: RetryEmbeddingsScope = {},
    callbacks?: RetryEmbeddingsCallbacks,
  ): Promise<RetryEmbeddingsResult> {
    return retryEmbeddingsFn(this.deps, scope, callbacks);
  }
}
