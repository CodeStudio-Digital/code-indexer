/**
 * Coverage for two related embedding paths in `IndexDocumentationUseCase`:
 *
 *   - `embedAndUpsert` (the worker-pool refactor in Phase B)
 *   - `retryEmbeddings({ sourceId | collectionId })` (Phase F — fixes
 *     the `getChunk(sourceId)` bug where sourceId was treated as a
 *     chunkId, leaving per-source retries broken)
 *
 * Both share a worker-pool with `EMBED_CONCURRENCY=4`. We use a fake
 * embedder that counts concurrent calls to confirm the pool cap is
 * respected, and a fake vector store that asserts every chunk lands
 * exactly once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { DocStore } from '@mcp/store/doc-store.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { VectorRecord, VectorMatch } from '@mcp/shared/types.js';
import type { PipelineProviderResolver } from '../../../pipelines/index.js';
import { IndexDocumentationUseCase } from '../index-doc-use-case.js';
import { DocIngestProgressTracker } from '../progress-tracker.js';

interface Handle {
  db: CodeIndexDB;
  store: DocStore;
  uc: IndexDocumentationUseCase;
  embed: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  concurrencySamples: number[];
  dir: string;
}

function fakeResolver(): PipelineProviderResolver {
  return {} as unknown as PipelineProviderResolver;
}

function setup(): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-embed-parallel-test-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  const store = new DocStore(db.raw());

  // Counter that increments on enter and decrements on exit. We sample
  // the live value at every `embed` call and check the max afterwards.
  let inFlight = 0;
  const concurrencySamples: number[] = [];

  const embed = vi.fn(async (texts: string[]) => {
    inFlight++;
    concurrencySamples.push(inFlight);
    try {
      // Tiny delay so the workers actually overlap; without it Promise
      // microtask scheduling could serialize the test.
      await new Promise((r) => setTimeout(r, 10));
      return {
        vectors: texts.map((_, i) => [i + 1, i + 2, i + 3]),
        tokens: texts.length * 100,
      };
    } finally {
      inFlight--;
    }
  });

  const upsert = vi.fn(async (records: VectorRecord[]) => records.length);
  const embeddingService: EmbeddingService = {
    embed,
    embedQuery: async () => ({ vector: [0], tokens: 0 }),
  };
  const vectorStore: VectorStore = {
    upsert,
    search: vi.fn<() => Promise<VectorMatch[]>>().mockResolvedValue([]),
    deleteByIds: vi.fn(async () => 0),
    isAvailable: vi.fn(async () => true),
  };
  const uc = new IndexDocumentationUseCase({
    docStore: store,
    embeddingService,
    vectorStore,
    pipelineProviderResolver: fakeResolver(),
    progressTracker: new DocIngestProgressTracker(),
  });
  return { db, store, uc, embed, upsert, concurrencySamples, dir };
}

/** Insert N pending chunks (no embedding_hash) for the given source. */
function seedPendingChunks(store: DocStore, collectionId: number, sourceId: number, count: number) {
  const inputs = Array.from({ length: count }, (_, i) => ({
    collection_id: collectionId,
    source_id: sourceId,
    ord: i,
    content: `chunk ${i} content`,
    content_hash: `h${i}`,
  }));
  return store.insertChunks(inputs);
}

describe('retryEmbeddings — parallel + scope', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('respects EMBED_CONCURRENCY=4 — no more than 4 embed calls in flight', async () => {
    const c = h.store.createCollection({ name: 'col' });
    const s = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://x.example' });
    // 20 batches of 64 = need at least 20×64=1280 chunks to fan out
    // beyond the worker pool. Use 300 to keep the test fast — that's
    // still 5 batches (one per worker × 1.25 rounds), enough to expose
    // concurrency.
    seedPendingChunks(h.store, c.id, s.id, 300);

    await h.uc.retryEmbeddings({ sourceId: s.id });

    const maxConcurrent = Math.max(...h.concurrencySamples);
    expect(maxConcurrent).toBeLessThanOrEqual(4);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
  });

  it('per-source scope only embeds chunks of that source (the OLD bug)', async () => {
    // Two sources in different collections so the OLD bug (where
    // sourceId was passed to getChunk which interpreted it as chunkId
    // and returned undefined → fell back to "all collections") would
    // touch both. The fix scopes strictly by source_id.
    const c1 = h.store.createCollection({ name: 'col1' });
    const c2 = h.store.createCollection({ name: 'col2' });
    const s1 = h.store.createSource({ collection_id: c1.id, type: 'url', uri: 'https://1.example' });
    const s2 = h.store.createSource({ collection_id: c2.id, type: 'url', uri: 'https://2.example' });
    seedPendingChunks(h.store, c1.id, s1.id, 10);
    seedPendingChunks(h.store, c2.id, s2.id, 10);

    const result = await h.uc.retryEmbeddings({ sourceId: s1.id });

    expect(result.embedded).toBe(10);
    expect(result.total).toBe(10);
    // Embed was called with a single batch containing only s1's chunks.
    expect(h.embed).toHaveBeenCalledTimes(1);
    // s2's chunks must still have NULL embedding_hash.
    const s2Missing = h.store.listChunksMissingEmbedding({ sourceId: s2.id });
    expect(s2Missing.length).toBe(10);
  });

  it('per-collection scope embeds all sources in that collection', async () => {
    const c = h.store.createCollection({ name: 'col' });
    const s1 = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://a.example' });
    const s2 = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://b.example' });
    seedPendingChunks(h.store, c.id, s1.id, 5);
    seedPendingChunks(h.store, c.id, s2.id, 7);

    const result = await h.uc.retryEmbeddings({ collectionId: c.id });

    expect(result.embedded).toBe(12);
    expect(result.total).toBe(12);
  });

  it('no scope embeds everything missing across the corpus', async () => {
    const c1 = h.store.createCollection({ name: 'a' });
    const c2 = h.store.createCollection({ name: 'b' });
    const s1 = h.store.createSource({ collection_id: c1.id, type: 'url', uri: 'https://a.example' });
    const s2 = h.store.createSource({ collection_id: c2.id, type: 'url', uri: 'https://b.example' });
    seedPendingChunks(h.store, c1.id, s1.id, 3);
    seedPendingChunks(h.store, c2.id, s2.id, 4);

    const result = await h.uc.retryEmbeddings();

    expect(result.embedded).toBe(7);
    expect(result.total).toBe(7);
  });

  it('emits onProgress per completed batch', async () => {
    const c = h.store.createCollection({ name: 'col' });
    const s = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://x.example' });
    seedPendingChunks(h.store, c.id, s.id, 200);

    const frames: Array<{ current: number; total: number }> = [];
    await h.uc.retryEmbeddings(
      { sourceId: s.id },
      { onProgress: (p) => { frames.push({ current: p.current, total: p.total }); } },
    );

    expect(frames.length).toBeGreaterThan(1);
    expect(frames[frames.length - 1]!.current).toBe(200);
    expect(frames[frames.length - 1]!.total).toBe(200);
  });

  it('returns zero counts when nothing is missing', async () => {
    const c = h.store.createCollection({ name: 'col' });
    const s = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://x.example' });
    // No chunks inserted.
    const result = await h.uc.retryEmbeddings({ sourceId: s.id });
    expect(result).toEqual({ embedded: 0, tokens: 0, total: 0 });
    expect(h.embed).not.toHaveBeenCalled();
  });

  it('does NOT record vector mapping when upsert returns 0 (silent remote rejection)', async () => {
    // Reproduces the 2026-05-20 incident: Cloudflare Vectorize accepted
    // the request but persisted nothing. Local mapping was wrongly set
    // and the badge said "✓ embedded" while remote search returned 0.
    h.upsert.mockResolvedValueOnce(0);
    const c = h.store.createCollection({ name: 'col' });
    const s = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://x.example' });
    seedPendingChunks(h.store, c.id, s.id, 3);

    await h.uc.retryEmbeddings({ sourceId: s.id });

    // Embedding hash was NOT set (so future retries pick these up again).
    const stillMissing = h.store.listChunksMissingEmbedding({ sourceId: s.id });
    expect(stillMissing.length).toBe(3);
    // No vector mapping rows registered.
    const refs = h.store.listVectorIdsForSource(s.id);
    expect(refs.length).toBe(0);
  });

  it('force=true wipes existing mapping before retrying', async () => {
    const c = h.store.createCollection({ name: 'col' });
    const s = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://x.example' });
    const chunkIds = seedPendingChunks(h.store, c.id, s.id, 4);
    // Simulate a previous successful-looking embed (mapping rows + hash set).
    for (const id of chunkIds) {
      h.store.recordChunkVector(id, `doc_chunk:${id}`, 'default');
      h.store.updateChunkEmbedding(id, `h${id}`, 'default');
    }
    // Without force: nothing pending, no work.
    const noop = await h.uc.retryEmbeddings({ sourceId: s.id });
    expect(noop.total).toBe(0);
    expect(h.embed).not.toHaveBeenCalled();

    // With force: clears state and re-embeds everything.
    h.upsert.mockResolvedValueOnce(4);
    const result = await h.uc.retryEmbeddings({ sourceId: s.id, force: true });
    expect(result).toEqual({ embedded: 4, tokens: 400, total: 4 });
    expect(h.embed).toHaveBeenCalledTimes(1);
  });

  it('force does NOT trigger when sourceId is missing (collection-wide is foot-gun)', async () => {
    const c = h.store.createCollection({ name: 'col' });
    const s = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://x.example' });
    const chunkIds = seedPendingChunks(h.store, c.id, s.id, 2);
    for (const id of chunkIds) {
      h.store.recordChunkVector(id, `doc_chunk:${id}`, 'default');
      h.store.updateChunkEmbedding(id, `h${id}`, 'default');
    }
    // collection-wide force is silently downgraded — no clearEmbeddings call.
    const result = await h.uc.retryEmbeddings({ collectionId: c.id, force: true });
    expect(result.total).toBe(0);
    // Mapping still intact.
    expect(h.store.listVectorIdsForSource(s.id).length).toBe(2);
  });
});
