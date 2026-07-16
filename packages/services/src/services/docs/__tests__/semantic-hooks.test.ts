import { beforeEach, describe, expect, it, vi } from 'vitest';

const strategies = vi.hoisted(() => ({
  indexUrl: vi.fn(),
}));
const retryEmbeddingsMock = vi.hoisted(() => vi.fn());

vi.mock('../index-doc-use-case/strategies.js', () => ({
  indexUrl: strategies.indexUrl,
  indexPdf: vi.fn(),
  indexFolder: vi.fn(),
  dryRunPdf: vi.fn(),
  dryRunUrl: vi.fn(),
}));
vi.mock('../index-doc-use-case/embed-upsert.js', () => ({
  retryEmbeddings: retryEmbeddingsMock,
}));

import {
  IndexDocumentationUseCase,
  type DocumentationSemanticHooks,
} from '../index-doc-use-case.js';

describe('IndexDocumentationUseCase semantic hooks', () => {
  beforeEach(() => {
    strategies.indexUrl.mockReset();
    retryEmbeddingsMock.mockReset();
    retryEmbeddingsMock.mockResolvedValue({ embedded: 0, tokens: 0, total: 0 });
  });

  it('keeps corpus ingestion successful and still publishes ensure after prepare fails', async () => {
    const result = { source_id: 9, chunks_indexed: 1, searchable: true };
    strategies.indexUrl.mockResolvedValueOnce(result);
    const indexer = new IndexDocumentationUseCase({} as never);
    const prepareCollection = vi.fn(async () => { throw new Error('worker offline'); });
    const ensureCollection = vi.fn(async () => { throw new Error('queued for retry'); });
    const endCollectionMutation = vi.fn(async () => undefined);
    indexer.setSemanticHooks({
      prepareCollection,
      ensureCollection,
      beginCollectionMutation: vi.fn(() => ({ job_id: 7, token: 'source-7' })),
      endCollectionMutation,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(indexer.indexUrl({ collectionId: 7 } as never)).resolves.toBe(result);
      expect(prepareCollection).toHaveBeenCalledWith(7);
      expect(strategies.indexUrl).toHaveBeenCalledTimes(1);
      expect(endCollectionMutation).toHaveBeenCalledWith({ job_id: 7, token: 'source-7' }, null);
      expect(ensureCollection).toHaveBeenCalledWith(7);
    } finally {
      warn.mockRestore();
    }
  });

  it('settles the durable fence and schedules catch-up when ingestion fails partway', async () => {
    const failure = new Error('chunk persistence failed');
    strategies.indexUrl.mockRejectedValueOnce(failure);
    const indexer = new IndexDocumentationUseCase({} as never);
    const calls: string[] = [];
    const fence = { job_id: 41, token: 'source-41' };
    indexer.setSemanticHooks({
      beginCollectionMutation: vi.fn(() => { calls.push('begin'); return fence; }),
      prepareCollection: vi.fn(async () => { calls.push('prepare'); }),
      endCollectionMutation: vi.fn(async (received, error) => {
        expect(received).toEqual(fence);
        expect(error).toBe(failure);
        calls.push('end');
      }),
      ensureCollection: vi.fn(async () => { calls.push('ensure'); }),
    });

    await expect(indexer.indexUrl({ collectionId: 7 } as never)).rejects.toBe(failure);
    expect(calls).toEqual(['begin', 'prepare', 'end', 'ensure']);
  });

  it('holds one independent fence for each concurrent source in a collection', async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const second = new Promise<void>((resolve) => { releaseSecond = resolve; });
    strategies.indexUrl
      .mockImplementationOnce(async () => { await first; return { source_id: 1 }; })
      .mockImplementationOnce(async () => { await second; return { source_id: 2 }; });
    const indexer = new IndexDocumentationUseCase({} as never);
    let nextFence = 1;
    const settled: number[] = [];
    indexer.setSemanticHooks({
      beginCollectionMutation: vi.fn(() => ({
        job_id: nextFence,
        token: `source-${nextFence++}`,
      })),
      prepareCollection: vi.fn(async () => undefined),
      endCollectionMutation: vi.fn(async (fence) => {
        if (fence) settled.push(fence.job_id);
      }),
      ensureCollection: vi.fn(async () => undefined),
    });

    const firstRun = indexer.indexUrl({ collectionId: 7, url: 'https://a.test' } as never);
    const secondRun = indexer.indexUrl({ collectionId: 7, url: 'https://b.test' } as never);
    await vi.waitFor(() => expect(nextFence).toBe(3));
    expect(settled).toEqual([]);

    releaseSecond();
    await secondRun;
    expect(settled).toEqual([2]);
    releaseFirst();
    await firstRun;
    expect(settled).toEqual([2, 1]);
  });

  it('does not perform relational ingestion when the durable fence cannot be created', async () => {
    const indexer = new IndexDocumentationUseCase({} as never);
    const failure = new Error('semantic job database busy');
    const prepareCollection = vi.fn(async () => undefined);
    const ensureCollection = vi.fn(async () => undefined);
    const endCollectionMutation = vi.fn(async () => undefined);
    indexer.setSemanticHooks({
      beginCollectionMutation: vi.fn(async () => { throw failure; }),
      prepareCollection,
      ensureCollection,
      endCollectionMutation,
    });

    await expect(indexer.indexUrl({ collectionId: 7 } as never)).rejects.toBe(failure);
    expect(strategies.indexUrl).not.toHaveBeenCalled();
    expect(prepareCollection).not.toHaveBeenCalled();
    expect(endCollectionMutation).not.toHaveBeenCalled();
    expect(ensureCollection).not.toHaveBeenCalled();
  });

  it('routes source retries through the source collection namespace lock', async () => {
    retryEmbeddingsMock.mockResolvedValueOnce({ embedded: 2, tokens: 8, total: 2 });
    const docStore = {
      getSource: vi.fn(() => ({ id: 11, collection_id: 7 })),
      getCollection: vi.fn(() => ({ id: 7 })),
      listCollections: vi.fn(() => [{ id: 7 }]),
    };
    const indexer = new IndexDocumentationUseCase({ docStore } as never);
    const exclusiveEntered = vi.fn();
    const runCollectionExclusive: NonNullable<DocumentationSemanticHooks['runCollectionExclusive']> =
      async <T>(collectionId: number, run: () => Promise<T>): Promise<T> => {
        exclusiveEntered(collectionId);
        return run();
      };
    indexer.setSemanticHooks({
      prepareCollection: vi.fn(async () => undefined),
      ensureCollection: vi.fn(async () => undefined),
      runCollectionExclusive,
    });

    await expect(indexer.retryEmbeddings({ sourceId: 11 })).resolves.toEqual({
      embedded: 2, tokens: 8, total: 2,
    });
    expect(exclusiveEntered).toHaveBeenCalledWith(7);
    expect(retryEmbeddingsMock).toHaveBeenCalledWith(
      expect.objectContaining({ docStore }),
      { sourceId: 11 },
      undefined,
    );
  });

  it('does not upsert a queued retry after collection deletion wins the namespace lock', async () => {
    let collectionExists = true;
    let releaseDelete!: (value: number) => void;
    const deleteCheckpoint = new Promise<number>((resolve) => { releaseDelete = resolve; });
    const docStore = {
      getCollection: vi.fn(() => collectionExists ? { id: 7 } : null),
      listCollections: vi.fn(() => collectionExists ? [{ id: 7 }] : []),
      listVectorIdsForCollection: vi.fn(() => []),
      deleteCollection: vi.fn(() => { collectionExists = false; }),
    };
    const vectorStore = {
      deleteNamespace: vi.fn(() => deleteCheckpoint),
    };
    const indexer = new IndexDocumentationUseCase({ docStore, vectorStore } as never);
    let tail: Promise<void> = Promise.resolve();
    const runCollectionExclusive: NonNullable<DocumentationSemanticHooks['runCollectionExclusive']> =
      <T>(_collectionId: number, run: () => Promise<T>): Promise<T> => {
        const current = tail.catch(() => undefined).then(run);
        tail = current.then(() => undefined, () => undefined);
        return current;
      };
    indexer.setSemanticHooks({
      prepareCollection: vi.fn(async () => undefined),
      ensureCollection: vi.fn(async () => undefined),
      runCollectionExclusive,
    });

    const deletion = indexer.deleteCollection(7);
    await vi.waitFor(() => expect(vectorStore.deleteNamespace).toHaveBeenCalledWith('docs:c7'));
    const retry = indexer.retryEmbeddings({ collectionId: 7 });
    await Promise.resolve();
    expect(retryEmbeddingsMock).not.toHaveBeenCalled();

    releaseDelete(0);
    await expect(deletion).resolves.toEqual({ vectors_deleted: 0 });
    await expect(retry).resolves.toEqual({ embedded: 0, tokens: 0, total: 0 });
    expect(docStore.deleteCollection).toHaveBeenCalledOnce();
    expect(retryEmbeddingsMock).not.toHaveBeenCalled();
  });
});
