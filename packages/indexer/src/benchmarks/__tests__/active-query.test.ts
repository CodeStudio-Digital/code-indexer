import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingService } from '../../search/embeddings.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import {
  assertActiveBenchmarkGeneration,
  assertDocsSemanticBenchmarkReady,
  assertPhysicalBenchmarkVectors,
  docsBenchmarkNeedsSemanticIndex,
  resolveActiveBenchmarkQueryServices,
  resolveActiveDocsBenchmarkQueryServices,
} from '../active-query.js';

const queryService = {
  embed: vi.fn(),
  embedQuery: vi.fn(),
  embedQueryForNamespace: vi.fn(),
} as unknown as EmbeddingService;
const vectorStore = { search: vi.fn() } as unknown as VectorStore;

describe('benchmark live embedding binding', () => {
  it('preserves explicit FTS-only docs evaluation without semantic storage', () => {
    expect(docsBenchmarkNeedsSemanticIndex(['fts'])).toBe(false);
    expect(docsBenchmarkNeedsSemanticIndex(['fts', 'hybrid'])).toBe(true);
    expect(docsBenchmarkNeedsSemanticIndex(['rerank'])).toBe(true);
  });

  it('uses queryEmbedding and the project active generation, never the desired profile', () => {
    const runtime = {
      queryEmbedding: vi.fn(() => queryService),
      embedding: vi.fn(() => { throw new Error('desired profile must not be read'); }),
      currentEmbeddingTarget: vi.fn(() => { throw new Error('desired profile must not be read'); }),
    };
    const store = {
      getActiveGeneration: vi.fn(() => ({ id: 12, indexed_items: 99 })),
      listItems: vi.fn(() => Array.from({ length: 41 }, () => ({}))),
    };

    const result = resolveActiveBenchmarkQueryServices(store as never, runtime as never, vectorStore, 7);

    expect(store.getActiveGeneration).toHaveBeenCalledWith('code:p7');
    expect(store.listItems).toHaveBeenCalledWith({
      generation_id: 12,
      namespace: 'code:p7',
      status: 'indexed',
    });
    expect(runtime.queryEmbedding).toHaveBeenCalledWith('code');
    expect(runtime.embedding).not.toHaveBeenCalled();
    expect(runtime.currentEmbeddingTarget).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      namespace: 'code:p7',
      embeddingService: queryService,
      vectorStore,
      activeGenerationId: 12,
      indexedItems: 41,
    });
  });

  it('keeps docs vector evaluation enabled for active collections when the desired profile is disabled', () => {
    const runtime = {
      queryEmbedding: vi.fn(() => queryService),
      currentEmbeddingTarget: vi.fn(() => { throw new Error('desired profile must not be read'); }),
    };
    const store = {
      getActiveGeneration: vi.fn((namespace: string) =>
        namespace === 'docs:c2' ? { id: 18, purpose: 'docs' } : null),
      listItems: vi.fn(({ namespace }: { namespace: string }) =>
        namespace === 'docs:c2' ? [{}, {}, {}] : []),
    };

    const result = resolveActiveDocsBenchmarkQueryServices(
      store as never,
      runtime as never,
      vectorStore,
      [1, 2, 3],
    );

    expect(store.getActiveGeneration.mock.calls.map(([namespace]) => namespace))
      .toEqual(['docs:c1', 'docs:c2', 'docs:c3']);
    expect(runtime.queryEmbedding).toHaveBeenCalledWith('docs');
    expect(runtime.currentEmbeddingTarget).not.toHaveBeenCalled();
    expect(result).toEqual({
      embeddingService: queryService,
      vectorStore,
      activeCollectionIds: [2],
      activeCollections: [{
        collectionId: 2,
        namespace: 'docs:c2',
        generationId: 18,
        indexedItems: 3,
      }],
    });
  });

  it('degrades a docs benchmark with no active collection to FTS', () => {
    const result = resolveActiveDocsBenchmarkQueryServices(
      { getActiveGeneration: () => null, listItems: vi.fn() } as never,
      { queryEmbedding: () => queryService } as never,
      vectorStore,
      [4, 5],
    );

    expect(result.embeddingService).toBe(queryService);
    expect(result.vectorStore).toBeNull();
    expect(result.activeCollectionIds).toEqual([]);
    expect(result.activeCollections).toEqual([]);
  });

  it('rejects semantic docs evaluation with no active collections', async () => {
    const result = resolveActiveDocsBenchmarkQueryServices(
      { getActiveGeneration: () => null, listItems: vi.fn() } as never,
      { queryEmbedding: () => queryService } as never,
      vectorStore,
      [4, 5],
    );
    const listPhysicalIds = vi.fn(async () => ['unexpected']);

    await expect(assertDocsSemanticBenchmarkReady(result, listPhysicalIds))
      .rejects.toThrow(/no active documentation generation/);
    expect(listPhysicalIds).not.toHaveBeenCalled();
  });

  it('rejects active docs generations with no semantic_items coverage', async () => {
    const result = resolveActiveDocsBenchmarkQueryServices(
      {
        getActiveGeneration: () => ({ id: 21 }),
        listItems: () => [],
      } as never,
      { queryEmbedding: () => queryService } as never,
      vectorStore,
      [8],
    );
    const listPhysicalIds = vi.fn(async () => ['unexpected']);

    await expect(assertDocsSemanticBenchmarkReady(result, listPhysicalIds))
      .rejects.toThrow(/zero indexed items for docs:c8/);
    expect(listPhysicalIds).not.toHaveBeenCalled();
  });

  it('rejects active docs generations whose physical vectors are empty', async () => {
    const result = resolveActiveDocsBenchmarkQueryServices(
      {
        getActiveGeneration: () => ({ id: 22 }),
        listItems: () => [{}, {}],
      } as never,
      { queryEmbedding: () => queryService } as never,
      vectorStore,
      [9],
    );

    await expect(assertDocsSemanticBenchmarkReady(result, async () => []))
      .rejects.toThrow(/zero physical vectors for docs:c9/);
    await expect(assertDocsSemanticBenchmarkReady(result, async () => ['v1']))
      .resolves.toBeUndefined();
  });

  it('marks the vector cell unavailable until the namespace has an active generation', () => {
    const result = resolveActiveBenchmarkQueryServices(
      { getActiveGeneration: () => null, listItems: vi.fn() } as never,
      { queryEmbedding: () => queryService } as never,
      vectorStore,
      9,
    );

    expect(result.namespace).toBe('code:p9');
    expect(result.vectorStore).toBeNull();
    expect(result.activeGenerationId).toBeNull();
    expect(result.indexedItems).toBe(0);
    expect(() => assertActiveBenchmarkGeneration(result)).toThrow(/no active generation/);
  });

  it('rejects an active generation with zero indexed items', () => {
    const result = resolveActiveBenchmarkQueryServices(
      {
        getActiveGeneration: () => ({ id: 33, indexed_items: 8 }),
        listItems: () => [],
      } as never,
      { queryEmbedding: () => queryService } as never,
      vectorStore,
      9,
    );

    expect(() => assertActiveBenchmarkGeneration(result)).toThrow(/zero indexed items/);
  });

  it('rejects an active logical generation whose physical table is empty', () => {
    const result = resolveActiveBenchmarkQueryServices(
      {
        getActiveGeneration: () => ({ id: 44, indexed_items: 3 }),
        listItems: () => [{}, {}, {}],
      } as never,
      { queryEmbedding: () => queryService } as never,
      vectorStore,
      9,
    );

    assertActiveBenchmarkGeneration(result);
    expect(() => assertPhysicalBenchmarkVectors(result, 0)).toThrow(/zero physical vectors/);
    expect(() => assertPhysicalBenchmarkVectors(result, 3)).not.toThrow();
  });
});
