import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { VectorSearchOptions, VectorStore } from '@mcp/store/vectors.js';
import type { EmbeddingService } from '../embeddings.js';
import { HybridSearch } from '../hybrid.js';

function queryEmbedding(
  embedQueryForNamespace: EmbeddingService['embedQueryForNamespace'],
): EmbeddingService {
  return {
    embed: vi.fn(async (texts: string[]) => ({ vectors: texts.map(() => [1]), tokens: 0 })),
    embedQuery: vi.fn(async () => { throw new Error('namespace snapshot required'); }),
    embedQueryForNamespace,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('HybridSearch active-generation embedding', () => {
  it('uses code and snapshot namespace-aware query services', async () => {
    const codeQuery = vi.fn(async (_namespace: string, _text: string) => ({
      vector: [7], tokens: 1, generationId: 17,
    }));
    const knowledgeQuery = vi.fn(async (_namespace: string, _text: string) => ({
      vector: [9], tokens: 1, generationId: 19,
    }));
    const search = vi.fn(async (_vector: number[], _options: VectorSearchOptions) => []);
    const db = {
      searchSnapshots: vi.fn(() => []),
    } as unknown as CodeIndexDB;
    const hybrid = new HybridSearch(
      db,
      { search } as unknown as VectorStore,
      queryEmbedding(codeQuery),
      null,
      null,
      null,
      null,
      queryEmbedding(knowledgeQuery),
    );

    await hybrid.search(7, 'project-seven', 'where is indexing', {
      mode: 'vector', type: 'files', limit: 5,
    });
    await hybrid.searchSnapshotsHybrid(7, 'project-seven', 'why snapshot', 5);

    expect(codeQuery).toHaveBeenCalled();
    expect(codeQuery.mock.calls.every(([namespace]) => namespace === 'code:p7')).toBe(true);
    expect(knowledgeQuery).toHaveBeenCalledWith('snapshot:p7', 'why snapshot');
    expect(search.mock.calls.map(([, options]) => options.namespace)).toContain('snapshot:p7');
    expect(search.mock.calls.find(([, options]) => options.namespace === 'snapshot:p7')?.[1].generationId)
      .toBe(19);
  });

  it('recalls snapshots after rename when stored metadata has the previous project name', async () => {
    const snapshot = {
      id: 44,
      project_id: 7,
      title: 'before rename',
      category: 'decision',
      content: 'stable namespace',
      tags: '[]',
      created_at: '2026-07-15 00:00:00',
      updated_at: '2026-07-15 00:00:00',
      created_by: 'test',
      embedding_hash: 'hash',
      source: 'manual',
      importance: 1,
      last_accessed_at: null,
      access_count: 0,
      archived_at: null,
    } as const;
    const db = {
      searchSnapshots: vi.fn(() => []),
      getSnapshotById: vi.fn((id: number) => id === snapshot.id ? snapshot : undefined),
    } as unknown as CodeIndexDB;
    const search = vi.fn(async (_vector: number[], options: VectorSearchOptions) => {
      if (options.filter?.project_name) return [];
      return [{
        id: 'snapshot:44:0',
        score: 0.9,
        metadata: { type: 'snapshot', ref_id: '44', project_name: 'old-project-name' },
      }];
    });
    const knowledgeQuery = queryEmbedding(vi.fn(async () => ({
      vector: [9], tokens: 1, generationId: 19,
    })));
    const hybrid = new HybridSearch(
      db,
      { search } as unknown as VectorStore,
      queryEmbedding(vi.fn(async () => ({ vector: [7], tokens: 1, generationId: 17 }))),
      null,
      null,
      null,
      null,
      knowledgeQuery,
    );

    const results = await hybrid.searchSnapshotsHybrid(7, 'renamed-project', 'stable namespace', 5);

    expect(results).toEqual([snapshot]);
    expect(search).toHaveBeenCalledWith([9], expect.objectContaining({
      namespace: 'snapshot:p7',
      generationId: 19,
      filter: { type: 'snapshot' },
    }));
  });

  it('keeps the embedded generation pinned when activation happens before vector search', async () => {
    let activeGeneration = 11;
    const query = queryEmbedding(vi.fn(async () => {
      const generationId = activeGeneration;
      activeGeneration = 12; // deterministic activation between embed and search
      return { vector: [11], tokens: 1, generationId };
    }));
    const vectorSearch = vi.fn(async (_vector: number[], options: { generationId?: number }) => {
      expect(activeGeneration).toBe(12);
      return options.generationId === 11 ? [] : Promise.reject(new Error('mixed generation'));
    });
    const hybrid = new HybridSearch(
      {} as CodeIndexDB,
      { search: vectorSearch } as unknown as VectorStore,
      query,
    );

    await hybrid.search(7, 'project-seven', 'processEmbeddings', {
      mode: 'vector', type: 'files', limit: 5,
    });

    expect(vectorSearch).toHaveBeenCalledWith([11], expect.objectContaining({
      namespace: 'code:p7', generationId: 11,
    }));
  });

  it('propagates the generation pin through the hybrid pipeline', async () => {
    const vectorSearch = vi.fn(async () => []);
    const hybrid = new HybridSearch(
      { searchFiles: () => [], searchSymbols: () => [] } as unknown as CodeIndexDB,
      { search: vectorSearch } as unknown as VectorStore,
      queryEmbedding(vi.fn(async () => ({ vector: [31], tokens: 1, generationId: 31 }))),
    );

    await hybrid.search(7, 'project-seven', 'processEmbeddings', {
      mode: 'hybrid', type: 'files', limit: 5,
    });

    expect(vectorSearch).toHaveBeenCalledWith([31], expect.objectContaining({
      namespace: 'code:p7', generationId: 31,
    }));
  });

  it('preserves FTS when the project has no active generation', async () => {
    const file = { id: 4, project_id: 7, path: 'src/active.ts' };
    const db = {
      searchFiles: vi.fn(() => [file]),
      searchSymbols: vi.fn(() => []),
      searchFileContents: vi.fn(() => []),
    } as unknown as CodeIndexDB;
    const noActive = queryEmbedding(vi.fn(async (_namespace: string, _text: string) => {
      throw new Error('No active semantic generation for code:p7');
    }));
    const vectorSearch = vi.fn(async (_vector: number[], _options: { namespace?: string }) => []);
    const hybrid = new HybridSearch(
      db,
      { search: vectorSearch } as unknown as VectorStore,
      noActive,
    );

    const { results, diagnostics } = await hybrid.searchWithDiag(
      7,
      'project-seven',
      'active generation',
      { mode: 'vector', type: 'files', limit: 5 },
    );

    expect(results.map((result) => result.id)).toEqual([4]);
    expect(diagnostics.vectorError).toMatch(/No active semantic generation/);
    expect(vectorSearch).not.toHaveBeenCalled();
  });

  it('skips HyDE, query embedding and vector search for explicit stale wildcards', async () => {
    const file = { id: 4, project_id: 7, path: 'src/stale.ts' };
    const backendQuery = vi.fn(async () => ({ vector: [7], tokens: 1, generationId: 17 }));
    const embedding: EmbeddingService = {
      embed: vi.fn(async () => ({ vectors: [[7]], tokens: 1 })),
      embedQuery: vi.fn(async () => ({ vector: [7], tokens: 1 })),
      embedQueryForNamespace: backendQuery,
      cacheRevisionForNamespace: () => 'explicit-stale',
      queryBlockReasonForNamespace: () =>
        'Semantic namespace code:p7 is stale; explicit reindex required',
    };
    const vectorSearch = vi.fn(async () => []);
    const hyde = { generate: vi.fn(async () => 'hypothetical code') };
    const db = {
      searchFiles: vi.fn(() => [file]),
      searchSymbols: vi.fn(() => []),
      searchFileContents: vi.fn(() => []),
    } as unknown as CodeIndexDB;
    const hybrid = new HybridSearch(
      db,
      { search: vectorSearch } as unknown as VectorStore,
      embedding,
      hyde as never,
    );

    const { results, diagnostics } = await hybrid.searchWithDiag(
      7,
      'project-seven',
      'where is stale indexing handled',
      { mode: 'hybrid', type: 'files', limit: 5 },
    );

    expect(results.map((result) => result.id)).toContain(4);
    expect(diagnostics.vectorError).toMatch(/explicit reindex required/);
    expect(hyde.generate).not.toHaveBeenCalled();
    expect(backendQuery).not.toHaveBeenCalled();
    expect(vectorSearch).not.toHaveBeenCalled();
  });
});
