import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { EmbeddingService } from '../embeddings.js';
import type { RerankCandidate, RerankerService } from '../reranker.js';
import { HybridSearch } from '../hybrid.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('HybridSearch global owner path', () => {
  it('retrieves per project without reranking and performs one global rerank before topK', async () => {
    vi.stubEnv('MCP_FTS_CONTENT_STREAM', '0');
    vi.stubEnv('MCP_PIPELINES_GRAPH_EXPANSION', '0');
    const db = {
      searchFiles: (projectId: number) => [{
        id: projectId * 10,
        project_id: projectId,
        path: `src/project-${projectId}.ts`,
        language: 'typescript',
        line_count: 5,
      }],
      searchSymbols: () => [],
      getSymbolsByFile: () => [],
      getProject: (projectId: number) => ({
        id: projectId,
        name: `p${projectId}`,
        root_path: '',
      }),
    } as unknown as CodeIndexDB;
    const embedding: EmbeddingService = {
      embed: async (texts) => ({ vectors: texts.map(() => [1]), tokens: 0 }),
      embedQuery: async () => ({ vector: [1], tokens: 0 }),
    };
    const rerank = vi.fn(async (_query: string, candidates: RerankCandidate[], topK = 10) =>
      candidates.map((candidate) => ({
        id: candidate.id,
        score: candidate.id.startsWith('2:') ? 0.99 : 0.1,
        originalScore: candidate.originalScore,
      })).sort((left, right) => right.score - left.score).slice(0, topK));
    const reranker: RerankerService = { name: 'global-test', rerank };
    const search = new HybridSearch(db, null, embedding, null, reranker);

    const results = await search.searchGlobal([
      { id: 1, name: 'one' },
      { id: 2, name: 'two' },
      { id: 3, name: 'three' },
    ], 'where is the cache implemented', { mode: 'hybrid', type: 'files', limit: 2 });

    expect(rerank).toHaveBeenCalledOnce();
    expect(rerank.mock.calls[0][2]).toBe(2);
    expect(rerank.mock.calls[0][1].map((candidate) => candidate.id).sort()).toEqual([
      '1:file:10', '2:file:20', '3:file:30',
    ]);
    expect(results).toHaveLength(2);
    expect(results[0].projectId).toBe(2);
    expect(results[0].result.score).toBe(0.99);
    expect(results.every((result, index) =>
      index === 0 || results[index - 1].result.score >= result.result.score)).toBe(true);
  });
});
