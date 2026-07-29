import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import type { EmbeddingService } from '../embeddings.js';
import type { RerankCandidate, RerankerService } from '../reranker.js';
import { HybridSearch } from '../hybrid.js';

function database(): CodeIndexDB {
  return {
    searchFiles: vi.fn(() => [{
      id: 1,
      project_id: 7,
      path: 'src/cache.ts',
      summary: 'semantic cache',
      concepts: '[]',
    }]),
    searchSymbols: vi.fn(() => []),
    searchFileContents: vi.fn(() => []),
  } as unknown as CodeIndexDB;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('HybridSearch semantic cache revisions', () => {
  it('enforces one public top-K after merging file and symbol FTS rows', async () => {
    const files = Array.from({ length: 4 }, (_, index) => ({
      id: index + 1,
      project_id: 7,
      path: `src/file-${index + 1}.ts`,
    }));
    const symbols = Array.from({ length: 4 }, (_, index) => ({
      id: index + 10,
      project_id: 7,
      file_path: `src/file-${index + 1}.ts`,
      name: `symbol${index + 1}`,
      kind: 'function',
    }));
    const db = {
      searchFiles: vi.fn((_projectId: number, _query: string, limit: number) =>
        files.slice(0, limit)),
      searchSymbols: vi.fn((_projectId: number, _query: string, limit: number) =>
        symbols.slice(0, limit)),
      searchFileContents: vi.fn(() => []),
    } as unknown as CodeIndexDB;
    const hybrid = new HybridSearch(db, null, {
      embed: vi.fn(async () => ({ vectors: [], tokens: 0 })),
      embedQuery: vi.fn(async () => ({ vector: [], tokens: 0 })),
    });

    const results = await hybrid.search(7, 'project-seven', 'cache', {
      mode: 'fts',
      type: 'all',
      limit: 3,
    });

    expect(results).toHaveLength(3);
    expect(db.searchFiles).toHaveBeenCalledWith(7, expect.any(String), 3);
    expect(db.searchSymbols).toHaveBeenCalledWith(7, expect.any(String), 3);
  });

  it('caches within one active generation and misses after generation activation', async () => {
    let generationRevision = 'g17';
    const embedQueryForNamespace = vi.fn(async () => ({
      vector: [1],
      tokens: 0,
      generationId: Number(generationRevision.slice(1)),
    }));
    const embedding: EmbeddingService = {
      embed: vi.fn(async (texts) => ({ vectors: texts.map(() => [1]), tokens: 0 })),
      embedQuery: vi.fn(async () => ({ vector: [1], tokens: 0 })),
      embedQueryForNamespace,
      cacheRevisionForNamespace: (namespace) => `${namespace}:${generationRevision}`,
    };
    const vectorSearch = vi.fn(async () => []);
    const hybrid = new HybridSearch(
      database(),
      { search: vectorSearch } as unknown as VectorStore,
      embedding,
    );
    const options = { mode: 'vector' as const, type: 'files' as const, limit: 5 };

    await hybrid.search(7, 'project-seven', 'processEmbeddings', options);
    await hybrid.search(7, 'project-seven', 'processEmbeddings', options);
    expect(embedQueryForNamespace).toHaveBeenCalledTimes(1);
    expect(vectorSearch).toHaveBeenCalledTimes(1);

    generationRevision = 'g18';
    await hybrid.search(7, 'project-seven', 'processEmbeddings', options);
    expect(embedQueryForNamespace).toHaveBeenCalledTimes(2);
    expect(vectorSearch).toHaveBeenCalledTimes(2);
  });

  it('bypasses a valid cache entry for an explicit diagnostic run', async () => {
    const embedQueryForNamespace = vi.fn(async () => ({
      vector: [1],
      tokens: 0,
      generationId: 17,
    }));
    const embedding: EmbeddingService = {
      embed: vi.fn(async (texts) => ({ vectors: texts.map(() => [1]), tokens: 0 })),
      embedQuery: vi.fn(async () => ({ vector: [1], tokens: 0 })),
      embedQueryForNamespace,
      cacheRevisionForNamespace: () => 'code:p7:g17',
    };
    const hybrid = new HybridSearch(
      database(),
      { search: vi.fn(async () => []) } as unknown as VectorStore,
      embedding,
    );
    const options = { mode: 'vector' as const, type: 'files' as const, limit: 5 };

    const first = await hybrid.searchWithDiag(7, 'project-seven', 'processEmbeddings', options);
    const cached = await hybrid.searchWithDiag(7, 'project-seven', 'processEmbeddings', options);
    const fresh = await hybrid.searchWithDiag(7, 'project-seven', 'processEmbeddings', {
      ...options,
      bypassCache: true,
    });

    expect(first.diagnostics.cacheHit).toBe(false);
    expect(cached.diagnostics.cacheHit).toBe(true);
    expect(fresh.diagnostics.cacheHit).toBe(false);
    expect(fresh.diagnostics.totalTimeMs).toBeTypeOf('number');
    expect(embedQueryForNamespace).toHaveBeenCalledTimes(2);
  });

  it('caches within one reranker target and misses after the target changes', async () => {
    vi.stubEnv('MCP_FTS_CONTENT_STREAM', '0');
    let rerankerRevision = 'reranker-a';
    const rerank = vi.fn(async (_query: string, candidates: RerankCandidate[], topK = 10) => candidates
      .slice(0, topK)
      .map((candidate, index) => ({
        id: candidate.id,
        score: 1 - index / 10,
        originalScore: candidate.originalScore,
      })));
    const reranker: RerankerService = {
      name: 'test-reranker',
      cacheRevision: () => rerankerRevision,
      rerank,
    };
    const embedding: EmbeddingService = {
      embed: vi.fn(async (texts) => ({ vectors: texts.map(() => [1]), tokens: 0 })),
      embedQuery: vi.fn(async () => ({ vector: [1], tokens: 0 })),
    };
    const hybrid = new HybridSearch(
      database(),
      { search: vi.fn(async () => []) } as unknown as VectorStore,
      embedding,
      null,
      reranker,
    );
    const options = { mode: 'hybrid' as const, type: 'files' as const, limit: 1 };

    await hybrid.search(7, 'project-seven', 'semantic cache', options);
    await hybrid.search(7, 'project-seven', 'semantic cache', options);
    expect(rerank).toHaveBeenCalledTimes(1);

    rerankerRevision = 'reranker-b';
    await hybrid.search(7, 'project-seven', 'semantic cache', options);
    expect(rerank).toHaveBeenCalledTimes(2);
  });

  it('does not cache a vector fallback produced by a transient error', async () => {
    const embedQueryForNamespace = vi.fn()
      .mockRejectedValueOnce(new Error('embedding provider offline'))
      .mockResolvedValue({ vector: [1], tokens: 0, generationId: 17 });
    const embedding: EmbeddingService = {
      embed: vi.fn(async (texts) => ({ vectors: texts.map(() => [1]), tokens: 0 })),
      embedQuery: vi.fn(async () => ({ vector: [1], tokens: 0 })),
      embedQueryForNamespace,
      cacheRevisionForNamespace: () => 'g17',
    };
    const vectorSearch = vi.fn(async () => []);
    const hybrid = new HybridSearch(
      database(),
      { search: vectorSearch } as unknown as VectorStore,
      embedding,
    );
    const options = { mode: 'vector' as const, type: 'files' as const, limit: 5 };

    const first = await hybrid.searchWithDiag(7, 'project-seven', 'processEmbeddings', options);
    expect(first.diagnostics.vectorError).toMatch(/provider offline/);
    await hybrid.search(7, 'project-seven', 'processEmbeddings', options);

    expect(embedQueryForNamespace).toHaveBeenCalledTimes(2);
    expect(vectorSearch).toHaveBeenCalledTimes(1);
  });

  it('does not cache a degraded hybrid result', async () => {
    vi.stubEnv('MCP_FTS_CONTENT_STREAM', '0');
    const embedQueryForNamespace = vi.fn()
      .mockRejectedValueOnce(new Error('embedding provider offline'))
      .mockResolvedValue({ vector: [1], tokens: 0, generationId: 17 });
    const embedding: EmbeddingService = {
      embed: vi.fn(async (texts) => ({ vectors: texts.map(() => [1]), tokens: 0 })),
      embedQuery: vi.fn(async () => ({ vector: [1], tokens: 0 })),
      embedQueryForNamespace,
      cacheRevisionForNamespace: () => 'g17',
    };
    const vectorSearch = vi.fn(async () => []);
    const hybrid = new HybridSearch(
      database(),
      { search: vectorSearch } as unknown as VectorStore,
      embedding,
    );
    const options = { mode: 'hybrid' as const, type: 'files' as const, limit: 5 };

    const first = await hybrid.searchWithDiag(7, 'project-seven', 'processEmbeddings', options);
    expect(first.diagnostics.vectorError).toMatch(/provider offline/);
    await hybrid.search(7, 'project-seven', 'processEmbeddings', options);

    expect(embedQueryForNamespace).toHaveBeenCalledTimes(2);
    expect(vectorSearch).toHaveBeenCalledTimes(1);
  });
});
