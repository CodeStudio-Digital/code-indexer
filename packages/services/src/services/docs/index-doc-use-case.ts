/**
 * IndexDocumentationUseCase — orchestrates end-to-end ingestion of a single
 * doc source (PDF / URL / folder) into the global doc corpus.
 *
 * Public API. Implementation lives under `./index-doc-use-case/`:
 *   - types.ts          — public input/callback shapes + tunable constants
 *   - utils.ts          — hashing, URL/file normalisation, embedding text builder
 *   - source-helpers.ts — requireCollection / ensureSource / estimateFromPages
 *   - delete.ts         — deleteAndCleanup
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
  deleteCollectionAndCleanup,
  type DeleteResult,
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

export interface DocumentationSemanticMutationFence {
  job_id: number;
  token: string;
}

export interface DocumentationSemanticHooks {
  prepareCollection(collectionId: number): Promise<void>;
  ensureCollection(collectionId: number): Promise<void>;
  beginCollectionMutation?(
    collectionId: number,
    operation: 'upsert' | 'delete',
  ): DocumentationSemanticMutationFence | null | Promise<DocumentationSemanticMutationFence | null>;
  endCollectionMutation?(
    fence: DocumentationSemanticMutationFence | null,
    mutationError?: unknown,
  ): void | Promise<void>;
  runCollectionExclusive?<T>(collectionId: number, operation: () => Promise<T>): Promise<T>;
}

export class IndexDocumentationUseCase {
  private semanticHooks: DocumentationSemanticHooks | null = null;

  constructor(private deps: IndexDocUseCaseDeps) {}

  setSemanticHooks(hooks: DocumentationSemanticHooks | null): void {
    this.semanticHooks = hooks;
  }

  /** Wrap custom ingestion entrypoints (for example Company Docs) in the same
   * durable collection fence as the built-in URL/PDF/folder strategies. */
  runWithSemanticCollection<T>(
    collectionId: number,
    run: () => Promise<T>,
    operation: 'upsert' | 'delete' = 'upsert',
  ): Promise<T> {
    return this.withSemanticNamespace(collectionId, run, operation);
  }

  private async withSemanticNamespace<T>(
    collectionId: number,
    run: () => Promise<T>,
    operation: 'upsert' | 'delete' = 'upsert',
  ): Promise<T> {
    const hooks = this.semanticHooks;
    let fence: DocumentationSemanticMutationFence | null = null;
    let mutationError: unknown = null;
    if (hooks) {
      if (!hooks.beginCollectionMutation || !hooks.endCollectionMutation) {
        throw new Error('Documentation semantic mutation fence hooks are required');
      }
      // With Knowledge embeddings enabled this is the durability boundary,
      // not a best-effort optimization. Continuing after it fails would let
      // relational writes race activation without a persistent watermark.
      fence = await hooks.beginCollectionMutation(collectionId, operation);
    }
    try {
      await hooks?.prepareCollection(collectionId);
    } catch (error) {
      // FTS ingestion is authoritative and must remain available while the
      // semantic worker/provider is down. The embed phase is independently
      // fail-open and the durable backfill will retry later.
      console.warn(`[doc-indexer] semantic namespace prepare paused c${collectionId}: ${
        error instanceof Error ? error.message : String(error)
      }`);
    }
    try {
      return await run();
    } catch (error) {
      mutationError = error;
      throw error;
    } finally {
      // Settle before scheduling catch-up. The durable delta stays pending
      // until an exact logical + physical pass acknowledges its watermark.
      try {
        await hooks?.endCollectionMutation?.(fence, mutationError);
      } catch (error) {
        console.warn(`[doc-indexer] semantic mutation fence settle paused c${collectionId}: ${
          error instanceof Error ? error.message : String(error)
        }`);
      }
      // Always publish the post-ingestion catch-up, including partial corpus
      // failures. Relational writes may have landed before the strategy threw.
      if (hooks) {
        try {
          await hooks.ensureCollection(collectionId);
        } catch (error) {
          console.warn(`[doc-indexer] semantic namespace activation paused c${collectionId}: ${
            error instanceof Error ? error.message : String(error)
          }`);
        }
      }
    }
  }

  // ─── PDF ─────────────────────────────────────────────────────────
  async indexPdf(input: IndexPdfInput, callbacks?: IndexDocStreamCallbacks): Promise<DocIngestResult> {
    return this.withSemanticNamespace(input.collectionId, () => indexPdfFn(this.deps, input, callbacks));
  }
  async dryRunPdf(input: IndexPdfInput): Promise<DocIngestEstimate> {
    return dryRunPdfFn(input);
  }

  // ─── URL ─────────────────────────────────────────────────────────
  async indexUrl(input: IndexUrlInput, callbacks?: IndexDocStreamCallbacks): Promise<DocIngestResult> {
    return this.withSemanticNamespace(input.collectionId, () => indexUrlFn(this.deps, input, callbacks));
  }
  async dryRunUrl(input: IndexUrlInput): Promise<DocIngestEstimate> {
    return dryRunUrlFn(input);
  }

  // ─── Folder (migration 103) ──────────────────────────────────────
  async indexFolder(input: IndexFolderInput, callbacks?: IndexDocStreamCallbacks): Promise<DocIngestResult> {
    return this.withSemanticNamespace(input.collectionId, () => indexFolderFn(this.deps, input, callbacks));
  }

  // ─── Delete + local vector cleanup ───────────────────────────────
  /**
   * Delete a source row, cascade-wipe its chunks and remove deterministic
   * ids from the collection's local semantic namespace.
   */
  async deleteSource(sourceId: number): Promise<DeleteResult> {
    // Resolve the collection before the delete cascades it away.
    const collectionId = this.deps.docStore.getSource(sourceId)?.collection_id;
    const remove = () => deleteAndCleanup(
      this.deps.docStore,
      this.deps.vectorStore,
      () => this.deps.docStore.listVectorIdsForSource(sourceId),
      () => { this.deps.docStore.deleteSource(sourceId); },
      collectionId != null ? docNamespace(collectionId) : undefined,
    );
    return collectionId == null
      ? remove()
      : this.withSemanticNamespace(collectionId, remove, 'delete');
  }

  /** Same as `deleteSource` but for an entire collection (two-hop FK cascade). */
  async deleteCollection(collectionId: number): Promise<DeleteResult> {
    const remove = () => deleteCollectionAndCleanup(
      this.deps.docStore,
      this.deps.vectorStore,
      collectionId,
      () => { this.deps.docStore.deleteCollection(collectionId); },
      docNamespace(collectionId),
    );
    return this.semanticHooks?.runCollectionExclusive
      ? this.semanticHooks.runCollectionExclusive(collectionId, remove)
      : remove();
  }

  // ─── Re-embed missing ────────────────────────────────────────────
  /**
   * Reconcile chunks missing from the current semantic_items generation (or
   * whose content hash changed). Scope is explicit:
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
    const exclusive = this.semanticHooks?.runCollectionExclusive;
    if (this.semanticHooks && !exclusive) {
      throw new Error('Documentation semantic namespace lock hook is required');
    }
    if (!exclusive) return this.retryEmbeddingsUnlocked(scope, callbacks);

    let collectionIds: number[];
    if (scope.sourceId != null) {
      const source = this.deps.docStore.getSource(scope.sourceId);
      if (!source) return { embedded: 0, tokens: 0, total: 0 };
      collectionIds = [source.collection_id];
    } else if (scope.collectionId != null) {
      collectionIds = [scope.collectionId];
    } else {
      collectionIds = this.deps.docStore.listCollections().map((collection) => collection.id);
    }

    const aggregate: RetryEmbeddingsResult = { embedded: 0, tokens: 0, total: 0 };
    for (const collectionId of [...new Set(collectionIds)]) {
      const scoped = scope.sourceId != null
        ? scope
        : { collectionId, ...(scope.force === undefined ? {} : { force: scope.force }) };
      const result = await exclusive(collectionId, async () => {
        // A collection/source can disappear while this retry waits behind a
        // build or delete checkpoint. Revalidate under the namespace lock so
        // no vector upsert can resurrect a removed docs namespace.
        if (!this.deps.docStore.getCollection(collectionId)) {
          return { embedded: 0, tokens: 0, total: 0 };
        }
        if (scope.sourceId != null) {
          const currentSource = this.deps.docStore.getSource(scope.sourceId);
          if (!currentSource || currentSource.collection_id !== collectionId) {
            return { embedded: 0, tokens: 0, total: 0 };
          }
        }
        return this.retryEmbeddingsUnlocked(scoped, callbacks);
      });
      aggregate.embedded += result.embedded;
      aggregate.tokens += result.tokens;
      aggregate.total += result.total;
      if (result.stopped) {
        aggregate.stopped = result.stopped;
        break;
      }
    }
    return aggregate;
  }

  /** Coordinator-only primitive. Its caller already owns the namespace lock;
   * public/manual retries must use `retryEmbeddings` above. */
  retryEmbeddingsUnlocked(
    scope: RetryEmbeddingsScope = {},
    callbacks?: RetryEmbeddingsCallbacks,
  ): Promise<RetryEmbeddingsResult> {
    return retryEmbeddingsFn(this.deps, scope, callbacks);
  }
}
