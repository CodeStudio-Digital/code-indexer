/**
 * Coverage for the orphan-cleanup paths added on top of `DELETE` in
 * `IndexDocumentationUseCase` (Addendum 2 of the Documentação plan).
 *
 * Pins the contract surfaced to the dashboard:
 *   - Remote delete succeeds → `{remote_deleted: N, queued_for_retry: 0}`
 *   - Remote delete throws → SQLite still gets cleaned, tombstones queued
 *   - `sweepTombstones` drains successful ones and bumps retry_count on
 *     failures (no infinite-loop blocker).
 *
 * Mocks the `VectorStore` directly — `EmbeddingService` isn't exercised by
 * delete paths so we wire a no-op `EmbeddingService` interface adapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { DocStore } from '@mcp/store/doc-store.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import type { VectorRecord, VectorMatch } from '@mcp/shared/types.js';
import type { PipelineProviderResolver } from '../../../pipelines/index.js';
import { IndexDocumentationUseCase } from '../index-doc-use-case.js';

interface Handle {
  db: CodeIndexDB;
  store: DocStore;
  uc: IndexDocumentationUseCase;
  vectorStore: VectorStore & { deleteByIds: ReturnType<typeof vi.fn> };
  dir: string;
}

function fakeResolver(): PipelineProviderResolver {
  // The delete paths never call into provider resolution — a bare cast
  // keeps the test isolated from the pipelines module.
  return {} as unknown as PipelineProviderResolver;
}

function setup(opts: { withVectorStore?: boolean } = {}): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-doc-delete-test-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  const store = new DocStore(db.raw());
  const deleteByIds = vi.fn<(ids: string[]) => Promise<number>>().mockResolvedValue(0);
  const vectorStore: Handle['vectorStore'] = {
    deleteByIds,
    upsert: vi.fn<(records: VectorRecord[]) => Promise<number>>().mockResolvedValue(0),
    search: vi.fn<() => Promise<VectorMatch[]>>().mockResolvedValue([]),
    isAvailable: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  };
  const uc = new IndexDocumentationUseCase({
    docStore: store,
    embeddingService: null,
    vectorStore: opts.withVectorStore === false ? null : vectorStore,
    pipelineProviderResolver: fakeResolver(),
  });
  return { db, store, uc, vectorStore, dir };
}

/** Make a source with N chunks, each with a registered vector. */
function seed(h: Handle, count: number): { collectionId: number; sourceId: number; vectorIds: string[] } {
  const c = h.store.createCollection({ name: `col-${Date.now()}-${Math.random()}` });
  const s = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://x.example' });
  const inputs = Array.from({ length: count }, (_, i) => ({
    collection_id: c.id,
    source_id: s.id,
    ord: i,
    content: `chunk ${i}`,
    content_hash: `h${i}`,
  }));
  const chunkIds = h.store.insertChunks(inputs);
  const vectorIds: string[] = [];
  for (const chunkId of chunkIds) {
    const vid = `doc_chunk:${chunkId}`;
    h.store.recordChunkVector(chunkId, vid, 'default');
    vectorIds.push(vid);
  }
  return { collectionId: c.id, sourceId: s.id, vectorIds };
}

describe('IndexDocumentationUseCase.deleteSource', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('clears SQLite + calls vector store, reports remote_deleted', async () => {
    const { sourceId, vectorIds } = seed(h, 5);
    h.vectorStore.deleteByIds.mockResolvedValueOnce(vectorIds.length);

    const result = await h.uc.deleteSource(sourceId);

    expect(result).toEqual({ remote_deleted: 5, queued_for_retry: 0 });
    expect(h.vectorStore.deleteByIds).toHaveBeenCalledTimes(1);
    expect(h.vectorStore.deleteByIds.mock.calls[0][0].sort()).toEqual(vectorIds.sort());
    expect(h.store.getSource(sourceId)).toBeNull();
    expect(h.store.countPendingTombstones()).toBe(0);
  });

  it('on remote failure: SQLite still cleared, tombstones queued', async () => {
    const { sourceId, vectorIds } = seed(h, 3);
    h.vectorStore.deleteByIds.mockRejectedValueOnce(new Error('vectorize 503'));

    const result = await h.uc.deleteSource(sourceId);

    expect(result).toEqual({ remote_deleted: 0, queued_for_retry: 3 });
    expect(h.store.getSource(sourceId)).toBeNull();
    const tombstones = h.store.listPendingTombstones();
    expect(tombstones.length).toBe(3);
    expect(tombstones.map((t) => t.vector_id).sort()).toEqual(vectorIds.sort());
    expect(tombstones[0].last_error).toContain('vectorize 503');
  });

  it('on partial silent return (removed < requested): queues remainder for retry', async () => {
    // Reproduces the same silent-fail pattern we saw with upsert —
    // remote returns 0 from a request of 5 with no error. Conservative
    // path: SQLite still cleared, all IDs queued for sweep retry. The
    // `partial_delete:N/M` marker in last_error helps debugging.
    const { sourceId, vectorIds } = seed(h, 5);
    h.vectorStore.deleteByIds.mockResolvedValueOnce(0);

    const result = await h.uc.deleteSource(sourceId);

    expect(result).toEqual({ remote_deleted: 0, queued_for_retry: 5 });
    expect(h.store.getSource(sourceId)).toBeNull();
    const tombstones = h.store.listPendingTombstones();
    expect(tombstones.length).toBe(5);
    expect(tombstones.map((t) => t.vector_id).sort()).toEqual(vectorIds.sort());
    expect(tombstones[0].last_error).toContain('partial_delete:0/5');
  });

  it('on partial success (some IDs already gone remotely): reports actual count + queues all for retry safety', async () => {
    const { sourceId } = seed(h, 4);
    h.vectorStore.deleteByIds.mockResolvedValueOnce(2); // 2 of 4 actually removed

    const result = await h.uc.deleteSource(sourceId);

    expect(result.remote_deleted).toBe(2);
    expect(result.queued_for_retry).toBe(4);
    // Tombstones get cleaned up by the retry-cap sweep after a few
    // attempts (the "already gone" IDs will keep returning 0, hitting
    // MAX_TOMBSTONE_RETRIES eventually).
    expect(h.store.countPendingTombstones()).toBe(4);
  });

  it('no vector store wired → no remote call, no tombstones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-no-vs-'));
    const db = new CodeIndexDB(join(dir, 'test.db'));
    const store = new DocStore(db.raw());
    const uc = new IndexDocumentationUseCase({
      docStore: store, embeddingService: null, vectorStore: null,
      pipelineProviderResolver: fakeResolver(),
    });
    const c = store.createCollection({ name: 'no-vs' });
    const s = store.createSource({ collection_id: c.id, type: 'url', uri: 'https://x.example' });
    // No chunks even, but the path should be safe.
    const result = await uc.deleteSource(s.id);
    expect(result).toEqual({ remote_deleted: 0, queued_for_retry: 0 });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('source with zero vectors → no remote call', async () => {
    const c = h.store.createCollection({ name: 'empty' });
    const s = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://x.example' });
    const result = await h.uc.deleteSource(s.id);
    expect(result).toEqual({ remote_deleted: 0, queued_for_retry: 0 });
    expect(h.vectorStore.deleteByIds).not.toHaveBeenCalled();
  });
});

describe('IndexDocumentationUseCase.deleteCollection', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('aggregates vector_ids across all sources of the collection', async () => {
    // Seed two sources in the same collection by hand (seed() makes a new
    // collection each call).
    const c = h.store.createCollection({ name: 'multi' });
    const s1 = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://a.example' });
    const s2 = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://b.example' });
    const allChunks = [
      ...[0, 1].map((i) => ({ collection_id: c.id, source_id: s1.id, ord: i, content: `a${i}`, content_hash: `ah${i}` })),
      ...[0, 1, 2].map((i) => ({ collection_id: c.id, source_id: s2.id, ord: i, content: `b${i}`, content_hash: `bh${i}` })),
    ];
    const chunkIds = h.store.insertChunks(allChunks);
    for (const chunkId of chunkIds) {
      h.store.recordChunkVector(chunkId, `doc_chunk:${chunkId}`, 'default');
    }
    h.vectorStore.deleteByIds.mockResolvedValueOnce(5);

    const result = await h.uc.deleteCollection(c.id);

    expect(result).toEqual({ remote_deleted: 5, queued_for_retry: 0 });
    expect(h.vectorStore.deleteByIds).toHaveBeenCalledTimes(1);
    expect(h.vectorStore.deleteByIds.mock.calls[0][0].length).toBe(5);
    expect(h.store.getCollection(c.id)).toBeNull();
  });
});

describe('IndexDocumentationUseCase.sweepTombstones', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('drains rows when the remote call succeeds', async () => {
    h.store.recordTombstones([
      { vector_id: 'a', provider: 'default' },
      { vector_id: 'b', provider: 'default' },
    ]);
    h.vectorStore.deleteByIds.mockResolvedValueOnce(2);

    const result = await h.uc.sweepTombstones();

    expect(result).toEqual({ drained: 2, still_pending: 0, dropped_exhausted: 0 });
    expect(h.store.countPendingTombstones()).toBe(0);
  });

  it('bumps retry_count on failure without removing the row', async () => {
    h.store.recordTombstones([{ vector_id: 'a', provider: 'default' }]);
    h.vectorStore.deleteByIds.mockRejectedValueOnce(new Error('still down'));

    const result = await h.uc.sweepTombstones();

    expect(result).toEqual({ drained: 0, still_pending: 1, dropped_exhausted: 0 });
    const [row] = h.store.listPendingTombstones();
    expect(row.retry_count).toBe(1);
    expect(row.last_error).toContain('still down');
  });

  it('groups by provider — failure in one provider does not poison the other', async () => {
    h.store.recordTombstones([
      { vector_id: 'a', provider: 'default' },
      { vector_id: 'b', provider: 'legacy' },
    ]);
    h.vectorStore.deleteByIds
      // First call (whichever provider's group runs first) succeeds.
      .mockResolvedValueOnce(1)
      // Second call fails.
      .mockRejectedValueOnce(new Error('legacy down'));

    const result = await h.uc.sweepTombstones();

    expect(result.drained).toBe(1);
    expect(result.still_pending).toBe(1);
  });

  it('empty queue → no remote call', async () => {
    const result = await h.uc.sweepTombstones();
    expect(result).toEqual({ drained: 0, still_pending: 0, dropped_exhausted: 0 });
    expect(h.vectorStore.deleteByIds).not.toHaveBeenCalled();
  });

  it('on partial remote return, bumps retry_count instead of dropping all tombstones', async () => {
    h.store.recordTombstones([
      { vector_id: 'a', provider: 'default' },
      { vector_id: 'b', provider: 'default' },
      { vector_id: 'c', provider: 'default' },
    ]);
    // Remote claims it removed only 1 — we can't tell WHICH one, so the
    // safe path is to retry the whole batch next sweep instead of
    // dropping random rows. Each row gets its retry_count bumped.
    h.vectorStore.deleteByIds.mockResolvedValueOnce(1);

    const result = await h.uc.sweepTombstones();

    expect(result).toEqual({ drained: 0, still_pending: 3, dropped_exhausted: 0 });
    const tombstones = h.store.listPendingTombstones();
    expect(tombstones.length).toBe(3);
    expect(tombstones.every((t) => t.retry_count === 1)).toBe(true);
    expect(tombstones[0].last_error).toContain('partial_delete:1/3');
  });

  it('drops tombstones that hit the retry cap (prevents infinite loops on legacy / already-gone IDs)', async () => {
    h.store.recordTombstones([{ vector_id: 'old-id', provider: 'legacy' }]);
    // Manually push retry_count past the cap (5) by calling
    // markTombstoneRetried 5x. The next sweep should drop it.
    const [row] = h.store.listPendingTombstones();
    for (let i = 0; i < 5; i++) h.store.markTombstoneRetried(row.id, `attempt ${i}`);
    expect(h.store.listPendingTombstones()[0].retry_count).toBe(5);

    const result = await h.uc.sweepTombstones();

    expect(result.dropped_exhausted).toBe(1);
    expect(h.store.countPendingTombstones()).toBe(0);
  });
});
