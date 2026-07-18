/** Local documentation-vector cleanup. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { DocStore } from '@mcp/store/doc-store.js';
import { SemanticStore } from '@mcp/store/semantic-store.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import type { VectorRecord, VectorMatch } from '@mcp/shared/types.js';
import type { PipelineProviderResolver } from '../../../pipelines/index.js';
import { IndexDocumentationUseCase } from '../index-doc-use-case.js';

interface Handle {
  db: CodeIndexDB;
  store: DocStore;
  uc: IndexDocumentationUseCase;
  deleteByIds: ReturnType<typeof vi.fn<(ids: string[], namespace?: string) => Promise<number>>>;
  deleteNamespace: ReturnType<typeof vi.fn<(namespace: string) => Promise<number>>>;
  dir: string;
}

function fakeResolver(): PipelineProviderResolver {
  return {} as unknown as PipelineProviderResolver;
}

function setup(opts: { withVectorStore?: boolean } = {}): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-doc-delete-test-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  const store = new DocStore(db.raw());
  const deleteByIds = vi.fn<(ids: string[], namespace?: string) => Promise<number>>()
    .mockResolvedValue(0);
  const deleteNamespace = vi.fn<(namespace: string) => Promise<number>>()
    .mockResolvedValue(0);
  const vectorStore: VectorStore = {
    deleteByIds,
    deleteNamespace,
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
  return { db, store, uc, deleteByIds, deleteNamespace, dir };
}

function seed(h: Handle, count: number): { collectionId: number; sourceId: number; vectorIds: string[]; generationId: number } {
  const c = h.store.createCollection({ name: `col-${Date.now()}-${Math.random()}` });
  const s = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://x.example' });
  const chunkIds = h.store.insertChunks(Array.from({ length: count }, (_, i) => ({
    collection_id: c.id,
    source_id: s.id,
    ord: i,
    content: `chunk ${i}`,
    content_hash: `h${i}`,
  })));
  for (const chunkId of chunkIds) {
    h.store.updateChunkEmbeddingState(chunkId, `hash-${chunkId}`, 'docs:v1');
  }
  const semanticStore = new SemanticStore(h.db.raw());
  const generation = semanticStore.createGeneration({
    purpose: 'docs',
    fingerprint: 'docs:v1',
    embedding_target: { kind: 'disabled' },
    dimension: 3,
  });
  for (const chunkId of chunkIds) {
    semanticStore.upsertItem({
      generation_id: generation.id,
      namespace: `docs:c${c.id}`,
      item_key: `doc_chunk:${chunkId}`,
      source_hash: `hash-${chunkId}`,
      vector_id: `doc_chunk:${chunkId}`,
      chunk_index: 0,
      status: 'indexed',
      attempts: 1,
      error: null,
    });
  }
  return {
    collectionId: c.id,
    sourceId: s.id,
    vectorIds: chunkIds.map((id) => `doc_chunk:${id}`),
    generationId: generation.id,
  };
}

describe('IndexDocumentationUseCase local vector cleanup', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('deletes source vectors from its docs collection namespace', async () => {
    const { collectionId, sourceId, vectorIds, generationId } = seed(h, 5);
    const semanticStore = new SemanticStore(h.db.raw());
    h.deleteByIds.mockResolvedValueOnce(vectorIds.length);

    const result = await h.uc.deleteSource(sourceId);

    expect(result).toEqual({ vectors_deleted: 5 });
    expect(h.deleteByIds).toHaveBeenCalledOnce();
    expect(h.deleteByIds.mock.calls[0]?.[0].sort()).toEqual(vectorIds.sort());
    expect(h.deleteByIds.mock.calls[0]?.[1]).toBe(`docs:c${collectionId}`);
    expect(h.store.getSource(sourceId)).toBeNull();
    expect(semanticStore.listItems({ generation_id: generationId })).toEqual([]);
  });

  it('keeps corpus deletion durable when local vector cleanup fails or is partial', async () => {
    const first = seed(h, 3);
    h.deleteByIds.mockRejectedValueOnce(new Error('local database busy'));
    expect(await h.uc.deleteSource(first.sourceId)).toEqual({ vectors_deleted: 0 });
    expect(h.store.getSource(first.sourceId)).toBeNull();

    const second = seed(h, 4);
    h.deleteByIds.mockResolvedValueOnce(2);
    expect(await h.uc.deleteSource(second.sourceId)).toEqual({ vectors_deleted: 2 });
  });

  it('aggregates a collection and keeps deletion namespace-scoped', async () => {
    const c = h.store.createCollection({ name: 'multi' });
    const s1 = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://a.example' });
    const s2 = h.store.createSource({ collection_id: c.id, type: 'url', uri: 'https://b.example' });
    const chunkIds = h.store.insertChunks([
      ...[0, 1].map((i) => ({ collection_id: c.id, source_id: s1.id, ord: i, content: `a${i}`, content_hash: `ah${i}` })),
      ...[0, 1, 2].map((i) => ({ collection_id: c.id, source_id: s2.id, ord: i, content: `b${i}`, content_hash: `bh${i}` })),
    ]);
    for (const id of chunkIds) h.store.updateChunkEmbeddingState(id, `hash-${id}`, 'docs:v1');
    const semanticStore = new SemanticStore(h.db.raw());
    const generation = semanticStore.createGeneration({
      purpose: 'docs', fingerprint: 'docs:v1',
      embedding_target: { kind: 'disabled' }, dimension: 3,
    });
    for (const id of chunkIds) {
      semanticStore.upsertItem({
        generation_id: generation.id, namespace: `docs:c${c.id}`,
        item_key: `doc_chunk:${id}`, source_hash: `hash-${id}`,
        vector_id: `doc_chunk:${id}`, chunk_index: 0,
        status: 'indexed', attempts: 1, error: null,
      });
    }
    h.deleteNamespace.mockResolvedValueOnce(chunkIds.length);

    expect(await h.uc.deleteCollection(c.id)).toEqual({ vectors_deleted: 5 });
    expect(h.deleteNamespace).toHaveBeenCalledWith(`docs:c${c.id}`);
    expect(h.deleteByIds).not.toHaveBeenCalled();
    expect(h.store.getCollection(c.id)).toBeNull();
  });

  it('keeps the collection addressable when whole-namespace cleanup fails', async () => {
    const seeded = seed(h, 2);
    h.deleteNamespace.mockRejectedValueOnce(new Error('checkpoint busy'));

    await expect(h.uc.deleteCollection(seeded.collectionId)).rejects.toThrow('checkpoint busy');
    expect(h.store.getCollection(seeded.collectionId)).not.toBeNull();
    expect(h.store.listChunksByCollection(seeded.collectionId)).toHaveLength(2);
  });

  it('is safe when vectors are disabled or no accepted hashes exist', async () => {
    const empty = h.store.createCollection({ name: 'empty' });
    const source = h.store.createSource({ collection_id: empty.id, type: 'url', uri: 'https://empty.example' });
    expect(await h.uc.deleteSource(source.id)).toEqual({ vectors_deleted: 0 });
    expect(h.deleteByIds).not.toHaveBeenCalled();

    const disabled = setup({ withVectorStore: false });
    try {
      const seeded = seed(disabled, 1);
      expect(await disabled.uc.deleteSource(seeded.sourceId)).toEqual({ vectors_deleted: 0 });
    } finally {
      disabled.db.close();
      rmSync(disabled.dir, { recursive: true, force: true });
    }
  });
});
