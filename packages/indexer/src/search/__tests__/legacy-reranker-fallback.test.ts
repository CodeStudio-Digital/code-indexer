import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { EmbeddingService } from '../embeddings.js';
import type { RerankerService } from '../reranker.js';
import { HybridSearch } from '../hybrid.js';

function embedding(): EmbeddingService {
  return {
    embed: vi.fn(async (texts: string[]) => ({ vectors: texts.map(() => [1]), tokens: 0 })),
    embedQuery: vi.fn(async () => ({ vector: [1], tokens: 0 })),
  };
}

function database(): CodeIndexDB {
  const files = [1, 2, 3].map((id) => ({
    id,
    project_id: 7,
    path: `src/file-${id}.ts`,
    summary: `file ${id}`,
    concepts: '[]',
  }));
  return {
    searchFiles: vi.fn(() => files),
    searchSymbols: vi.fn(() => []),
    searchFileContents: vi.fn(() => []),
  } as unknown as CodeIndexDB;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('HybridSearch reranker fallback', () => {
  it.each([
    ['rejects', async () => { throw new Error('reranker offline'); }],
    ['returns an invalid result set', async () => [
      { id: 'file:1', score: Number.NaN, originalScore: 0 },
      { id: 'file:1', score: 1, originalScore: 0 },
    ]],
  ])('preserves descending RRF order when reranking %s', async (_label, rerank) => {
    vi.stubEnv('MCP_FTS_CONTENT_STREAM', '0');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reranker: RerankerService = { name: 'broken', rerank };
    const hybrid = new HybridSearch(database(), null, embedding(), null, reranker);

    const results = await hybrid.search(7, 'renamed-project', 'stable query', {
      mode: 'hybrid', type: 'files', limit: 2,
    });

    expect(results.map((result) => result.id)).toEqual([1, 2]);
    expect(results[0].score).toBeCloseTo(1 / 61);
    expect(results[1].score).toBeCloseTo(1 / 62);
    expect(results.every((result, index) =>
      index === 0 || results[index - 1].score >= result.score)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('preserving RRF order'));
  });
});
