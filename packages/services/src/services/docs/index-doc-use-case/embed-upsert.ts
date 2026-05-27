import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import type { DocCollection, DocStore } from '@mcp/store/doc-store.js';
import type { VectorRecord } from '@mcp/shared/types.js';
import { vectorIdForChunk } from '../search.js';
import { buildEmbeddingText, hashEmbeddingInput } from './utils.js';
import {
  EMBED_BATCH_SIZE,
  EMBED_CONCURRENCY,
  type IndexDocStreamCallbacks,
  type IndexDocUseCaseDeps,
} from './types.js';

export interface EmbedAndUpsertDeps {
  docStore: DocStore;
  embeddingService: EmbeddingService;
  vectorStore: VectorStore;
}

/**
 * Worker-pool embed+upsert for a single source. Sequential I/O wins when one
 * round-trip dominates wall-clock; here each batch is embed-then-upsert-then-
 * SQLite which the network dominates. Sequential was ~5-7 chunks/s; 4 workers
 * give ~4× throughput while staying well inside Cloudflare free-tier rate
 * limits (~8 req/s vs the 50/s cap).
 *
 * SQLite writes inside `recordChunkVector` / `updateChunkEmbedding` are
 * synchronous (better-sqlite3) — the engine serializes them for us.
 */
export async function embedAndUpsert(
  deps: EmbedAndUpsertDeps,
  collection: DocCollection,
  sourceId: number,
  callbacks?: IndexDocStreamCallbacks,
): Promise<number> {
  const { docStore, embeddingService, vectorStore } = deps;
  const allChunks = docStore.listChunksBySource(sourceId);
  if (allChunks.length === 0) return 0;

  const total = allChunks.length;
  let totalTokens = 0;
  let done = 0;
  let cursor = 0;

  const runWorker = async (): Promise<void> => {
    while (true) {
      const start = cursor;
      if (start >= allChunks.length) return;
      cursor = start + EMBED_BATCH_SIZE;
      const batch = allChunks.slice(start, start + EMBED_BATCH_SIZE);
      const texts = batch.map((c) => buildEmbeddingText(c.heading_path, c.summary, c.content));
      const { vectors, tokens } = await embeddingService.embed(texts);
      totalTokens += tokens;
      const records: VectorRecord[] = batch.map((chunk, j) => ({
        id: vectorIdForChunk(chunk.id),
        values: vectors[j] ?? [],
        metadata: {
          corpus: 'docs',
          type: 'doc_chunk',
          collection: collection.name,
          chunk_id: String(chunk.id),
          source_id: String(chunk.source_id),
          heading_path: chunk.heading_path ?? '',
        },
      })).filter((r) => r.values.length > 0);
      // Validate that the remote store actually accepted the vectors. If it
      // returns 0 (silent rejection — invalid metadata schema, quota, etc.),
      // we MUST NOT register the mapping in `doc_chunk_vectors` — otherwise
      // the badge says "✓ embedded" while remote search returns 0 forever.
      // Leaving `embedding_hash=NULL` lets `retryEmbeddings` pick these up.
      let upserted = 0;
      if (records.length > 0) upserted = await vectorStore.upsert(records);
      if (upserted < records.length) {
        console.warn(
          `[doc-indexer] vector upsert returned ${upserted}/${records.length} — leaving these chunks pending for retry`,
        );
      }
      if (upserted > 0) {
        for (let j = 0; j < batch.length; j++) {
          const chunk = batch[j]!;
          if (!vectors[j]) continue;
          docStore.recordChunkVector(chunk.id, vectorIdForChunk(chunk.id), 'default');
          docStore.updateChunkEmbedding(chunk.id, hashEmbeddingInput(texts[j]!), 'default');
        }
      }
      done += batch.length;
      await callbacks?.onProgress?.({
        phase: 'embedding',
        current: Math.min(done, total),
        total,
        chunks_indexed: total,
      });
    }
  };

  const workerCount = Math.min(EMBED_CONCURRENCY, Math.max(1, Math.ceil(allChunks.length / EMBED_BATCH_SIZE)));
  const workers = Array.from({ length: workerCount }, () => runWorker());
  await Promise.all(workers);
  return totalTokens;
}

export type RetryEmbeddingsScope = { sourceId?: number; collectionId?: number; force?: boolean };
export interface RetryEmbeddingsResult { embedded: number; tokens: number; total: number; }

export interface RetryEmbeddingsCallbacks {
  onProgress?: (p: { current: number; total: number; phase: 'embedding' }) => void | Promise<void>;
}

/**
 * Re-embed chunks whose `embedding_hash IS NULL`. Scope is explicit:
 * `sourceId` (preferred for "source got stuck halfway" recovery),
 * `collectionId`, or nothing (entire corpus). `force` wipes existing
 * embedding state before re-running — source-scoped only to avoid foot-gun.
 */
export async function retryEmbeddings(
  deps: IndexDocUseCaseDeps,
  scope: RetryEmbeddingsScope = {},
  callbacks?: RetryEmbeddingsCallbacks,
): Promise<RetryEmbeddingsResult> {
  const { docStore, embeddingService, vectorStore, progressTracker } = deps;
  if (!embeddingService || !vectorStore) return { embedded: 0, tokens: 0, total: 0 };

  if (scope.force && scope.sourceId != null) {
    const { cleared } = docStore.clearEmbeddingsForSource(scope.sourceId);
    console.log(`[doc-indexer] force re-embed source=${scope.sourceId} → cleared ${cleared} chunk(s)`);
  }
  // Snapshot the missing set up-front. Doing this incrementally would race
  // with the writes we make as we go.
  const allPending = docStore.listChunksMissingEmbedding({ ...scope, limit: 100_000 });
  const total = allPending.length;
  if (total === 0) return { embedded: 0, tokens: 0, total: 0 };

  // Resolve collection objects once — used for vector metadata.
  const collectionsById = new Map<number, DocCollection | null>();
  const getCollection = (id: number): DocCollection | null => {
    let c = collectionsById.get(id);
    if (c === undefined) {
      c = docStore.getCollection(id);
      collectionsById.set(id, c);
    }
    return c;
  };

  let embedded = 0;
  let totalTokens = 0;
  let cursor = 0;

  const runWorker = async (): Promise<void> => {
    while (true) {
      const start = cursor;
      if (start >= allPending.length) return;
      cursor = start + EMBED_BATCH_SIZE;
      const batch = allPending.slice(start, start + EMBED_BATCH_SIZE);
      const texts = batch.map((c) => buildEmbeddingText(c.heading_path, c.summary, c.content));
      const { vectors, tokens } = await embeddingService.embed(texts);
      totalTokens += tokens;
      const records: VectorRecord[] = [];
      for (let i = 0; i < batch.length; i++) {
        const chunk = batch[i]!;
        const collection = getCollection(chunk.collection_id);
        if (!collection) continue;
        const vec = vectors[i];
        if (!vec) continue;
        records.push({
          id: vectorIdForChunk(chunk.id),
          values: vec,
          metadata: {
            corpus: 'docs',
            type: 'doc_chunk',
            collection: collection.name,
            chunk_id: String(chunk.id),
            source_id: String(chunk.source_id),
            heading_path: chunk.heading_path ?? '',
          },
        });
      }
      // Same rule as embedAndUpsert: only register mapping when remote
      // actually accepted.
      let upserted = 0;
      if (records.length > 0) upserted = await vectorStore.upsert(records);
      if (upserted < records.length) {
        console.warn(
          `[doc-indexer] retry vector upsert returned ${upserted}/${records.length} — leaving these chunks pending`,
        );
      }
      if (upserted > 0) {
        for (let i = 0; i < batch.length; i++) {
          const chunk = batch[i]!;
          if (!vectors[i]) continue;
          docStore.recordChunkVector(chunk.id, vectorIdForChunk(chunk.id), 'default');
          docStore.updateChunkEmbedding(chunk.id, hashEmbeddingInput(texts[i]!), 'default');
        }
      }
      embedded += batch.length;
      await callbacks?.onProgress?.({ phase: 'embedding', current: Math.min(embedded, total), total });
      // Push into the progress tracker for THIS source too, so the source-list
      // live bar lights up during retry. Only meaningful when scope.sourceId set.
      if (scope.sourceId != null) {
        progressTracker?.put(scope.sourceId, {
          phase: 'embedding',
          current: Math.min(embedded, total),
          total,
          chunks_indexed: total,
        });
      }
    }
  };

  const workerCount = Math.min(EMBED_CONCURRENCY, Math.max(1, Math.ceil(allPending.length / EMBED_BATCH_SIZE)));
  const workers = Array.from({ length: workerCount }, () => runWorker());
  await Promise.all(workers);
  return { embedded, tokens: totalTokens, total };
}
