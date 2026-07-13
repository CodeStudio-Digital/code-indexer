import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import type { DocChunk, DocCollection, DocStore } from '@mcp/store/doc-store.js';
import type { VectorRecord } from '@mcp/shared/types.js';
import { docNamespace } from '@mcp/shared/vector-namespace.js';
import { vectorIdForChunk } from '../search.js';
import { buildEmbeddingText, hashEmbeddingInput } from './utils.js';
import { EMBED_BATCH_SIZE, EMBED_CONCURRENCY, type IndexDocStreamCallbacks, type IndexDocUseCaseDeps } from './types.js';

const PAGE_SIZE = 2_048;
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
  if (scope.force && scope.sourceId != null) docStore.clearEmbeddingsForSource(scope.sourceId);
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
  const pendingScope = { ...scope, fingerprint };
  const total = docStore.countChunksMissingEmbedding(pendingScope);
  if (total === 0) return { embedded: 0, tokens: 0, total: 0 };
  const concurrency = Math.max(1, Math.min(
    EMBED_CONCURRENCY,
    embeddingService.maxConcurrency?.() ?? 1,
  ));
  let embedded = 0;
  let tokens = 0;
  let stopped: 'paused' | 'cancelled' | undefined;

  while (embedded < total) {
    stopped = shouldStop?.() ?? undefined;
    if (stopped) break;
    const pending = docStore.listChunksMissingEmbedding({ ...pendingScope, limit: PAGE_SIZE });
    if (pending.length === 0) break;
    let cursor = 0;
    let pageConfirmed = 0;
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
        pageConfirmed += result.confirmed;
        await onProgress(Math.min(embedded, total), total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.ceil(pending.length / EMBED_BATCH_SIZE)) }, () => worker()));
    // A backend that repeatedly acknowledges zero records must leave chunks
    // pending for a later retry, not spin forever in this run.
    if (pageConfirmed === 0) break;
  }
  return { embedded, tokens, total, ...(stopped ? { stopped } : {}) };
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
  const { vectors, tokens } = await deps.embeddingService.embed(texts);
  const byCollection = new Map<number, Array<{
    chunk: DocChunk;
    text: string;
    record: VectorRecord;
  }>>();
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const vector = vectors[i];
    if (!vector?.length) continue;
    const inputHash = hashEmbeddingInput(texts[i]!);
    const list = byCollection.get(chunk.collection_id) ?? [];
    list.push({
      chunk,
      text: texts[i]!,
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
          embedding_fingerprint: fingerprint,
        },
      },
    });
    byCollection.set(chunk.collection_id, list);
  }

  let confirmed = 0;
  for (const [collectionId, entries] of byCollection) {
    const accepted = await upsertExactly(deps.vectorStore, entries.map((e) => e.record), docNamespace(collectionId));
    for (const entry of entries) {
      if (!accepted.has(entry.record.id)) continue;
      const hash = hashEmbeddingInput(entry.text);
      deps.docStore.recordChunkVector(entry.chunk.id, entry.record.id, fingerprint);
      deps.docStore.updateChunkEmbeddingState(entry.chunk.id, hash, fingerprint);
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
): Promise<Set<string>> {
  if (records.length === 0) return new Set();
  const count = await withRetry(() => store.upsert(records, namespace));
  if (count >= records.length) return new Set(records.map((r) => r.id));
  if (records.length === 1) return count === 1 ? new Set([records[0]!.id]) : new Set();
  const middle = Math.floor(records.length / 2);
  const [left, right] = await Promise.all([
    upsertExactly(store, records.slice(0, middle), namespace),
    upsertExactly(store, records.slice(middle), namespace),
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
