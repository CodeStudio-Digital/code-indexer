import {
  embedDocumentsForNamespace,
  type EmbeddingService,
} from '@mcp/indexer/search/embeddings.js';
import type { VectorStore, VectorWriteTarget } from '@mcp/store/vectors.js';
import type { DocChunk, DocCollection, DocStore } from '@mcp/store/doc-store.js';
import type { VectorRecord } from '@mcp/shared/types.js';
import { docNamespace } from '@mcp/shared/vector-namespace.js';
import { vectorIdForChunk } from '../search.js';
import { buildEmbeddingText, hashEmbeddingInput } from './utils.js';
import { EMBED_BATCH_SIZE, EMBED_CONCURRENCY, type IndexDocStreamCallbacks, type IndexDocUseCaseDeps } from './types.js';

const UPSERT_RETRIES = 3;

export interface EmbedAndUpsertDeps {
  docStore: DocStore;
  embeddingService: EmbeddingService;
  vectorStore: VectorStore;
}

export type RetryEmbeddingsScope = { sourceId?: number; collectionId?: number; force?: boolean };
export interface RetryEmbeddingsResult {
  embedded: number;
  tokens: number;
  total: number;
  stopped?: 'paused' | 'cancelled';
}
export interface RetryEmbeddingsCallbacks {
  onProgress?: (p: { current: number; total: number; phase: 'embedding' }) => void | Promise<void>;
  shouldStop?: () => 'paused' | 'cancelled' | null;
}

/** Legacy URL/PDF entrypoint; incremental folders use retryEmbeddings directly. */
export async function embedAndUpsert(
  deps: EmbedAndUpsertDeps,
  _collection: DocCollection,
  sourceId: number,
  callbacks?: IndexDocStreamCallbacks,
): Promise<number> {
  const result = await embedPending(deps, { sourceId }, async (current, total) => {
    await callbacks?.onProgress?.({ phase: 'embedding', current, total, chunks_indexed: total });
  }, undefined);
  return result.tokens;
}

/**
 * Embed only missing/stale chunks. Work is paged so a 50k-chunk corpus never
 * needs to hydrate all chunk bodies into memory at once.
 */
export async function retryEmbeddings(
  deps: IndexDocUseCaseDeps,
  scope: RetryEmbeddingsScope = {},
  callbacks?: RetryEmbeddingsCallbacks,
): Promise<RetryEmbeddingsResult> {
  const { docStore, embeddingService, vectorStore, progressTracker } = deps;
  if (!embeddingService || !vectorStore || embeddingService.fingerprint?.() === 'null') {
    return { embedded: 0, tokens: 0, total: 0 };
  }
  return embedPending({ docStore, embeddingService, vectorStore }, scope, async (current, total) => {
    await callbacks?.onProgress?.({ phase: 'embedding', current, total });
    if (scope.sourceId != null) {
      progressTracker?.put(scope.sourceId, {
        phase: 'embedding', current, total, chunks_indexed: total,
        embeddings_completed: current, embeddings_pending: Math.max(0, total - current),
        searchable: docStore.countChunksBySource(scope.sourceId) > 0,
      });
    }
  }, callbacks?.shouldStop);
}

async function embedPending(
  deps: EmbedAndUpsertDeps,
  scope: RetryEmbeddingsScope,
  onProgress: (current: number, total: number) => Promise<void>,
  shouldStop?: () => 'paused' | 'cancelled' | null,
): Promise<RetryEmbeddingsResult> {
  const { docStore, embeddingService, vectorStore } = deps;
  const fingerprint = embeddingService.fingerprint?.() ?? 'embedding:unknown';
  // semantic_items for the generation currently receiving writes is the only
  // authority for accepted hashes/retries. doc_chunks.embedding_* remains a
  // compatibility mirror and deliberately does not participate in selection.
  const pending = await selectPendingChunks(deps, scope, fingerprint);
  const total = pending.length;
  if (total === 0) return { embedded: 0, tokens: 0, total: 0 };
  const concurrency = Math.max(1, Math.min(
    EMBED_CONCURRENCY,
    embeddingService.maxConcurrency?.() ?? 1,
  ));
  let embedded = 0;
  let tokens = 0;
  let stopped: 'paused' | 'cancelled' | undefined;

  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const requestedStop = shouldStop?.() ?? undefined;
      if (requestedStop) {
        stopped = requestedStop;
        return;
      }
      const start = cursor;
      cursor += EMBED_BATCH_SIZE;
      const batch = pending.slice(start, start + EMBED_BATCH_SIZE);
      const result = await embedBatch(deps, batch, fingerprint);
      tokens += result.tokens;
      embedded += result.confirmed;
      await onProgress(Math.min(embedded, total), total);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(concurrency, Math.ceil(pending.length / EMBED_BATCH_SIZE)) },
    () => worker(),
  ));
  return { embedded, tokens, total, ...(stopped ? { stopped } : {}) };
}

async function selectPendingChunks(
  deps: EmbedAndUpsertDeps,
  scope: RetryEmbeddingsScope,
  fingerprint: string,
): Promise<DocChunk[]> {
  const candidates = scope.sourceId != null
    ? deps.docStore.listChunksBySource(scope.sourceId)
    : scope.collectionId != null
      ? deps.docStore.listChunksByCollection(scope.collectionId)
      : deps.docStore.listCollections().flatMap((collection) =>
        deps.docStore.listChunksByCollection(collection.id));
  if (scope.force || candidates.length === 0) return candidates;
  if (!deps.vectorStore.listItems) {
    // Compatibility only for third-party/test stores that have not adopted the
    // ledger projection. The built-in local store always exposes listItems.
    return candidates.filter((chunk) =>
      !chunk.embedding_hash || chunk.embedding_fingerprint !== fingerprint);
  }

  const pending: DocChunk[] = [];
  const byCollection = new Map<number, DocChunk[]>();
  for (const chunk of candidates) {
    const rows = byCollection.get(chunk.collection_id) ?? [];
    rows.push(chunk);
    byCollection.set(chunk.collection_id, rows);
  }
  for (const [collectionId, chunks] of byCollection) {
    const itemKeys = chunks.map((chunk) => vectorIdForChunk(chunk.id));
    const states = await deps.vectorStore.listItems(docNamespace(collectionId), itemKeys);
    const accepted = new Map(states
      .filter((state) => state.status === 'indexed' && state.vectorId)
      .map((state) => [state.itemKey, state.sourceHash]));
    for (const chunk of chunks) {
      const text = buildEmbeddingText(chunk.heading_path, null, chunk.content, chunk.api_signature);
      const hash = hashEmbeddingInput(text);
      if (accepted.get(vectorIdForChunk(chunk.id)) !== hash) pending.push(chunk);
    }
  }
  return pending;
}

async function embedBatch(
  deps: EmbedAndUpsertDeps,
  chunks: DocChunk[],
  fingerprint: string,
): Promise<{ confirmed: number; tokens: number }> {
  if (chunks.length === 0) return { confirmed: 0, tokens: 0 };
  const texts = chunks.map((chunk) => buildEmbeddingText(
    chunk.heading_path,
    null,
    chunk.content,
    chunk.api_signature,
  ));
  // One batch can span collections. Embed each collection separately so its
  // vectors carry the exact generation pin used by that namespace.
  const chunksByCollection = new Map<number, Array<{ chunk: DocChunk; text: string }>>();
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const list = chunksByCollection.get(chunk.collection_id) ?? [];
    list.push({ chunk, text: texts[i]! });
    chunksByCollection.set(chunk.collection_id, list);
  }

  let confirmed = 0;
  let tokens = 0;
  for (const [collectionId, pendingEntries] of chunksByCollection) {
    const namespace = docNamespace(collectionId);
    const embedded = await embedDocumentsForNamespace(
      deps.embeddingService,
      namespace,
      pendingEntries.map((entry) => entry.text),
    );
    tokens += embedded.tokens;
    const batchFingerprint = embedded.writeTarget?.embeddingFingerprint ?? fingerprint;
    const entries: Array<{ chunk: DocChunk; text: string; record: VectorRecord }> =
      pendingEntries.flatMap(({ chunk, text }, index) => {
      const vector = embedded.vectors[index];
      if (!vector?.length) return [];
      const inputHash = hashEmbeddingInput(text);
      return [{
        chunk,
        text,
        record: {
          id: vectorIdForChunk(chunk.id),
          values: vector,
          metadata: {
            corpus: 'docs',
            type: 'doc_chunk',
            chunk_id: String(chunk.id),
            source_id: String(chunk.source_id),
            heading_path: chunk.heading_path ?? '',
            embedding_hash: inputHash,
            embedding_fingerprint: batchFingerprint,
          },
        },
      }];
      });
    const accepted = await upsertExactly(
      deps.vectorStore,
      entries.map((e) => e.record),
      namespace,
      embedded.writeTarget,
    );
    for (const entry of entries) {
      if (!accepted.has(entry.record.id)) continue;
      const hash = hashEmbeddingInput(entry.text);
      deps.docStore.updateChunkEmbeddingState(entry.chunk.id, hash, batchFingerprint);
      confirmed++;
    }
  }
  return { confirmed, tokens };
}

/** Resolve count-only partial acknowledgements down to exact record ids. */
async function upsertExactly(
  store: VectorStore,
  records: VectorRecord[],
  namespace: string,
  writeTarget?: VectorWriteTarget,
): Promise<Set<string>> {
  if (records.length === 0) return new Set();
  const count = await withRetry(() => writeTarget
    ? store.upsert(records, namespace, writeTarget)
    : store.upsert(records, namespace));
  if (count >= records.length) return new Set(records.map((r) => r.id));
  if (records.length === 1) return count === 1 ? new Set([records[0]!.id]) : new Set();
  const middle = Math.floor(records.length / 2);
  const [left, right] = await Promise.all([
    upsertExactly(store, records.slice(0, middle), namespace, writeTarget),
    upsertExactly(store, records.slice(middle), namespace, writeTarget),
  ]);
  return new Set([...left, ...right]);
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= UPSERT_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (attempt === UPSERT_RETRIES) break;
      const delay = Math.min(500 * 2 ** attempt, 4_000) + Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw last;
}
