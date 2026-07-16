/**
 * Coverage for the benchmark metric math (isRelevant / nDCG@10) and the
 * auto query generation from the symbol index. These are the pure pieces;
 * runBenchmark itself needs a live HybridSearch + DB and is exercised by the
 * CLI run in the verification step.
 */
import { describe, it, expect } from 'vitest';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { DBSymbol, HybridSearchResult } from '@mcp/shared/types.js';
import { isRelevant, percentile, ndcgAt, runBenchmark, type EvalQuery } from '../engine.js';
import { generateQueriesFromIndex } from '../query-gen.js';

function sym(name: string, filePath: string): HybridSearchResult {
  return { type: 'symbol', data: { name, file_path: filePath } } as unknown as HybridSearchResult;
}
function file(path: string): HybridSearchResult {
  return { type: 'file', data: { path } } as unknown as HybridSearchResult;
}

describe('isRelevant', () => {
  it('matches a file by suffix', () => {
    const q: EvalQuery = { query: 'q', relevant_files: ['src/core/indexer.ts'] };
    expect(isRelevant(file('packages/x/src/core/indexer.ts'), q)).toBe(true);
    expect(isRelevant(file('src/core/other.ts'), q)).toBe(false);
  });

  it('matches a symbol by exact name or by its file', () => {
    expect(isRelevant(sym('processEmbeddings', 'a.ts'), { query: 'q', relevant_symbols: ['processEmbeddings'] })).toBe(true);
    expect(isRelevant(sym('other', 'a.ts'), { query: 'q', relevant_symbols: ['processEmbeddings'] })).toBe(false);
    expect(isRelevant(sym('other', 'a.ts'), { query: 'q', relevant_files: ['a.ts'] })).toBe(true);
  });
});

describe('percentile', () => {
  it('returns 0 for empty and the right index otherwise', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30); // floor(.5*4)=2
    expect(percentile([10, 20, 30, 40, 50], 95)).toBe(40); // floor(.95*4)=3
    expect(percentile([10, 20, 30, 40, 50], 100)).toBe(50);
  });
});

describe('ndcgAt', () => {
  const q: EvalQuery = { query: 'q', relevant_symbols: ['target'] };

  it('is 1.0 when the only relevant result is at rank 0', () => {
    const results = [sym('target', 'a.ts'), sym('x', 'b.ts')];
    expect(ndcgAt(results, q, 10)).toBeCloseTo(1, 6);
  });

  it('discounts by rank', () => {
    const results = [sym('x', 'b.ts'), sym('target', 'a.ts')]; // hit at rank 1
    // dcg = 1/log2(3), idcg = 1 → ~0.6309
    expect(ndcgAt(results, q, 10)).toBeCloseTo(1 / Math.log2(3), 6);
  });

  it('is 0 with no relevant hit and 0 with no declared targets', () => {
    expect(ndcgAt([sym('x', 'b.ts')], q, 10)).toBe(0);
    expect(ndcgAt([sym('target', 'a.ts')], { query: 'q' }, 10)).toBe(0);
  });

  it('never exceeds 1 even when one target is matched by several rows', () => {
    // file-target query: every symbol in the file counts relevant, but R=1
    const fq: EvalQuery = { query: 'q', relevant_files: ['a.ts'] };
    const results = [sym('a', 'a.ts'), sym('b', 'a.ts'), sym('c', 'a.ts')];
    expect(ndcgAt(results, fq, 10)).toBeLessThanOrEqual(1);
    expect(ndcgAt(results, fq, 10)).toBeCloseTo(1, 6); // first hit at rank 0
  });
});

function fakeDb(symbols: Array<Partial<DBSymbol>>): CodeIndexDB {
  return { listAllSymbols: () => symbols as DBSymbol[] } as unknown as CodeIndexDB;
}

describe('generateQueriesFromIndex', () => {
  it('derives NL queries from comments and exact queries from names', () => {
    const db = fakeDb([
      { name: 'processEmbeddings', file_path: 'a.ts', comment: 'Embed and upsert a single snapshot into the vector store' },
      { name: 'planQuery', file_path: 'b.ts', comment: '' },
    ]);
    const out = generateQueriesFromIndex(db, 1, { includeNames: true });
    // comment → symbol
    expect(out.some((q) => q.query.startsWith('Embed and upsert') && q.relevant_symbols?.[0] === 'processEmbeddings')).toBe(true);
    // name → symbol (both names long enough)
    expect(out.some((q) => q.query === 'processEmbeddings')).toBe(true);
    expect(out.some((q) => q.query === 'planQuery')).toBe(true);
  });

  it('skips noise comments, trivial names, and dedups', () => {
    const db = fakeDb([
      { name: 'get', file_path: 'a.ts', comment: 'eslint-disable-next-line no-console' },
      { name: 'foo', file_path: 'a.ts', comment: 'Does a thing with the cache layer' },
      { name: 'foo', file_path: 'a.ts', comment: 'Does a thing with the cache layer' }, // dup
    ]);
    const out = generateQueriesFromIndex(db, 1);
    expect(out.some((q) => q.query.startsWith('eslint'))).toBe(false); // noise filtered
    expect(out.some((q) => q.query === 'get')).toBe(false); // trivial name filtered
    expect(out.filter((q) => q.query.startsWith('Does a thing')).length).toBe(1); // deduped
  });

  it('respects maxQueries and is deterministic', () => {
    const symbols = Array.from({ length: 50 }, (_, i) => ({
      name: `symbolNumber${i}`,
      file_path: `f${i}.ts`,
      comment: `Handles operation number ${i} in the pipeline`,
    }));
    const a = generateQueriesFromIndex(fakeDb(symbols), 1, { maxQueries: 10 });
    const b = generateQueriesFromIndex(fakeDb(symbols), 1, { maxQueries: 10 });
    expect(a.length).toBe(10);
    expect(a.map((q) => q.query)).toEqual(b.map((q) => q.query)); // stable order
  });
});

describe('benchmark validity gates', () => {
  it('rejects an empty gold set instead of reporting a meaningless zero score', async () => {
    await expect(runBenchmark({
      db: {} as CodeIndexDB,
      projectId: 1,
      projectName: 'empty',
      querySet: [],
      embeddings: [],
      rerankers: [],
    })).rejects.toThrow(/at least one gold-set query/);
  });

  it('rejects a semantic cell that would silently degrade to FTS-only', async () => {
    await expect(runBenchmark({
      db: {} as CodeIndexDB,
      projectId: 1,
      projectName: 'missing-vectors',
      querySet: [{ query: 'semantic query', relevant_files: ['target.ts'] }],
      embeddings: [{
        label: 'live',
        service: {} as never,
        vectorStore: null,
      }],
      rerankers: [{
        label: 'rrf',
        reranker: { name: 'rrf', rerank: async () => [] },
      }],
      mode: 'hybrid',
    })).rejects.toThrow(/semantic benchmark requires indexed vectors/);
  });
});
