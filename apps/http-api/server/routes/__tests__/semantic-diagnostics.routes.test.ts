import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { ServerDeps } from '../../deps.js';
import { mountStatsRoutes } from '../stats.js';
import { mountDocsRoutes } from '../docs/index.js';

function queryService(
  embedQueryForNamespace: EmbeddingService['embedQueryForNamespace'],
): EmbeddingService {
  return {
    embed: vi.fn(async () => { throw new Error('diagnostics must use a namespace query'); }),
    embedQuery: vi.fn(async () => { throw new Error('diagnostics must not use the desired profile'); }),
    embedQueryForNamespace,
  };
}

describe('semantic diagnostic routes', () => {
  it('reports fingerprint drift from the active semantic generation, not the legacy project column', async () => {
    const db = {
      getProject: (id: number) => id === 7 ? { id, name: 'demo' } : null,
      getEmbeddingCoverage: vi.fn(() => ({
        files_total: 1,
        files_embedded: 1,
        symbols_total: 0,
        symbols_embedded: 0,
        symbol_bodies_total: 0,
        symbol_bodies_embedded: 0,
      })),
      getVectorIdStats: vi.fn(() => ({ total: 1, byType: { file: 1 } })),
      getProjectEmbeddingFingerprint: vi.fn(() => 'legacy-fingerprint'),
    };
    const app = new Hono();
    mountStatsRoutes(app, {
      db,
      semanticStore: {
        getActiveGeneration: vi.fn(() => ({ fingerprint: 'active-generation-fingerprint' })),
        getProfile: vi.fn(() => ({ embedding_target: { kind: 'onnx' } })),
      },
      semanticProfileRuntime: {
        embedding: vi.fn(() => ({ fingerprint: () => 'desired-profile-fingerprint' })),
      },
      embeddingService: { fingerprint: () => 'legacy-service-fingerprint' },
      vectorStore: { isAvailable: vi.fn(async () => true) },
      embeddingKind: 'onnx',
      vectorStoreKind: 'sqlite-vec',
    } as unknown as ServerDeps);

    const response = await app.request('/api/projects/7/embeddings/stats');
    const payload = await response.json() as {
      fingerprint: { stored: string | null; live: string | null; mismatch: boolean };
    };

    expect(response.status).toBe(200);
    expect(payload.fingerprint).toEqual({
      stored: 'active-generation-fingerprint',
      live: 'desired-profile-fingerprint',
      mismatch: true,
    });
    expect(db.getProjectEmbeddingFingerprint).not.toHaveBeenCalled();
  });

  it('pins the project test query to its code namespace generation', async () => {
    const embed = vi.fn(async () => ({ vector: [1, 0, 0], tokens: 4, generationId: 12 }));
    const search = vi.fn(async (
      _vector: number[],
      _options: { namespace: string; generationId: number; filter?: Record<string, string> },
    ) => [{
      id: 'file:4',
      score: 0.91,
      metadata: { type: 'file', ref_id: '4', project_name: 'old-demo' },
    }]);
    const semanticProfileRuntime = {
      queryEmbedding: vi.fn(() => queryService(embed)),
    };
    const db = {
      getProject: (id: number) => id === 7 ? { id, name: 'renamed-demo' } : null,
      getFileById: (id: number, projectId: number) =>
        id === 4 && projectId === 7 ? { id, path: 'src/demo.ts' } : null,
      getSymbolById: () => null,
    };
    const app = new Hono();
    mountStatsRoutes(app, {
      db,
      embeddingService: { fingerprint: () => 'desired-profile' },
      semanticProfileRuntime,
      vectorStore: { search, isAvailable: vi.fn(async () => true) },
      embeddingKind: 'onnx',
      vectorStoreKind: 'sqlite-vec',
    } as unknown as ServerDeps);

    const response = await app.request('/api/projects/7/embeddings/test-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'where is demo' }),
    });
    const payload = await response.json() as {
      namespace: string;
      generationId: number;
      matches: Array<{ path?: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      namespace: 'code:p7',
      generationId: 12,
      matches: [{ path: 'src/demo.ts' }],
    });
    expect(semanticProfileRuntime.queryEmbedding).toHaveBeenCalledWith('code');
    expect(embed).toHaveBeenCalledWith('code:p7', 'where is demo');
    expect(search).toHaveBeenCalledTimes(2);
    for (const [, options] of search.mock.calls) {
      expect(options).toMatchObject({ namespace: 'code:p7', generationId: 12 });
      expect(options).not.toHaveProperty('filter');
    }
  });

  it('fans docs diagnostics out by collection and pins each namespace generation', async () => {
    const collections = [
      { id: 2, name: 'Unity' },
      { id: 9, name: 'TypeScript' },
    ];
    const embed = vi.fn(async (namespace: string) => namespace === 'docs:c2'
      ? { vector: [2, 0], tokens: 2, generationId: 21 }
      : { vector: [9, 0, 0], tokens: 3, generationId: 34 });
    const search = vi.fn(async (
      _vector: number[],
      _options: { namespace: string; generationId: number; filter?: Record<string, string> },
    ) => []);
    const semanticProfileRuntime = {
      queryEmbedding: vi.fn(() => queryService(embed)),
    };
    const docStore = {
      listCollections: () => collections,
      getCollection: (id: number) => collections.find((collection) => collection.id === id) ?? null,
      getCollectionByName: (name: string) => collections.find((collection) => collection.name === name) ?? null,
      countIndexedVectorsByCollection: (id: number) => id === 2 ? 7 : 11,
    };
    const app = new Hono();
    mountDocsRoutes(app, {
      db: {},
      docStore,
      indexDocsUseCase: {},
      docHybridSearch: {},
      docProgressTracker: {},
      semanticProfileRuntime,
      vectorStore: { search, isAvailable: vi.fn(async () => true) },
      embeddingKind: 'onnx',
      vectorStoreKind: 'sqlite-vec',
    } as unknown as ServerDeps);

    const response = await app.request('/api/docs/vectors/diagnose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'physics types' }),
    });
    const payload = await response.json() as {
      namespaces: Array<{
        namespace: string;
        generationId: number;
        steps: Array<{ name: string; detail?: { count?: number } }>;
      }>;
    };

    expect(response.status).toBe(200);
    expect(payload.namespaces).toEqual([
      expect.objectContaining({
        namespace: 'docs:c2',
        generationId: 21,
        steps: expect.arrayContaining([
          expect.objectContaining({ name: 'semantic_items_active', detail: { count: 7 } }),
        ]),
      }),
      expect.objectContaining({
        namespace: 'docs:c9',
        generationId: 34,
        steps: expect.arrayContaining([
          expect.objectContaining({ name: 'semantic_items_active', detail: { count: 11 } }),
        ]),
      }),
    ]);
    expect(semanticProfileRuntime.queryEmbedding).toHaveBeenCalledWith('knowledge');
    expect(embed.mock.calls.map(([namespace]) => namespace)).toEqual(['docs:c2', 'docs:c9']);
    expect(search).toHaveBeenCalledTimes(8);
    for (const [, options] of search.mock.calls) {
      expect(options.namespace).toMatch(/^docs:c(?:2|9)$/);
      expect(options.generationId).toBe(options.namespace === 'docs:c2' ? 21 : 34);
    }
    expect(search.mock.calls.filter(([, options]) => options.filter === undefined)).toHaveLength(2);
  });

  it.each([
    ['numeric id', 9],
    ['numeric string', '9'],
    ['name', 'TypeScript'],
  ])('resolves a docs collection by %s', async (_label, collection) => {
    const collections = [{ id: 9, name: 'TypeScript' }];
    const embed = vi.fn(async () => ({ vector: [1], tokens: 1, generationId: 5 }));
    const search = vi.fn(async (
      _vector: number[],
      _options: { namespace: string; generationId: number; filter?: Record<string, string> },
    ) => []);
    const app = new Hono();
    mountDocsRoutes(app, {
      db: {},
      docStore: {
        listCollections: () => collections,
        getCollection: (id: number) => collections.find((row) => row.id === id) ?? null,
        getCollectionByName: (name: string) => collections.find((row) => row.name === name) ?? null,
        countIndexedVectorsByCollection: () => 1,
      },
      indexDocsUseCase: {},
      docHybridSearch: {},
      docProgressTracker: {},
      semanticProfileRuntime: { queryEmbedding: () => queryService(embed) },
      vectorStore: { search, isAvailable: vi.fn(async () => true) },
      embeddingKind: 'onnx',
      vectorStoreKind: 'sqlite-vec',
    } as unknown as ServerDeps);

    const response = await app.request('/api/docs/vectors/diagnose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collection }),
    });
    const payload = await response.json() as { namespaces: Array<{ namespace: string }> };

    expect(response.status).toBe(200);
    expect(payload.namespaces.map((row) => row.namespace)).toEqual(['docs:c9']);
    expect(search).toHaveBeenCalledTimes(4);
    expect(search.mock.calls.every(([, options]) =>
      options.namespace === 'docs:c9' && options.generationId === 5)).toBe(true);
  });
});
