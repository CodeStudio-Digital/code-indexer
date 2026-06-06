import { describe, it, expect } from 'vitest';
import { expandGraph } from '../graph-expansion-source.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { DBFile, DBSymbol, HybridSearchResult } from '@mcp/shared/types.js';

const file = (id: number, path: string): DBFile => ({ id, project_id: 1, path } as unknown as DBFile);

const fileSeed = (id: number, path: string): HybridSearchResult =>
  ({ id, type: 'file', score: 1, fts_rank: 1, vector_score: null, data: file(id, path) });

const symbolSeed = (id: number, name: string): HybridSearchResult =>
  ({ id, type: 'symbol', score: 1, fts_rank: 1, vector_score: null, data: { id, project_id: 1, name } as unknown as DBSymbol });

interface FakeGraph {
  callers?: Record<string, number[]>;      // symbolName → referencing file ids
  dependents?: Record<number, string[]>;   // fileId → importer file paths
  dependencies?: Record<number, string[]>; // fileId → imported file paths
  files?: DBFile[];
}

function fakeDb(g: FakeGraph): CodeIndexDB {
  const byId = new Map((g.files ?? []).map((f) => [f.id, f]));
  const byPath = new Map((g.files ?? []).map((f) => [f.path, f]));
  return {
    getSymbolCallers: (_pid: number, name: string) =>
      (g.callers?.[name] ?? []).map((fid) => ({ referencing_file_id: fid })),
    getDependents: (_pid: number, fid: number) =>
      (g.dependents?.[fid] ?? []).map((p) => ({ source_file_path: p })),
    getDependencies: (fid: number) =>
      (g.dependencies?.[fid] ?? []).map((p) => ({ target_file_path: p })),
    getFileById: (id: number) => byId.get(id),
    getFileByPath: (_pid: number, path: string) => byPath.get(path),
  } as unknown as CodeIndexDB;
}

describe('expandGraph', () => {
  it('surfaces caller files of a matched symbol', () => {
    const db = fakeDb({ callers: { doThing: [10, 11] }, files: [file(10, 'caller1.ts'), file(11, 'caller2.ts')] });
    const out = expandGraph(db, 1, [symbolSeed(1, 'doThing')], 'all');
    expect(out.map((r) => r.id).sort((a, b) => a - b)).toEqual([10, 11]);
    expect(out.every((r) => r.type === 'file')).toBe(true);
  });

  it('surfaces importers AND imports of a matched file', () => {
    const db = fakeDb({
      dependents: { 20: ['importer.ts'] },
      dependencies: { 20: ['imported.ts'] },
      files: [file(20, 'seed.ts'), file(30, 'importer.ts'), file(31, 'imported.ts')],
    });
    const out = expandGraph(db, 1, [fileSeed(20, 'seed.ts')], 'all');
    expect(out.map((r) => r.id).sort((a, b) => a - b)).toEqual([30, 31]);
  });

  it('excludes neighbors already in the primary set', () => {
    const db = fakeDb({ callers: { doThing: [10, 11] }, files: [file(10, 'a.ts'), file(11, 'b.ts')] });
    const primary = [symbolSeed(1, 'doThing'), fileSeed(10, 'a.ts')];
    const out = expandGraph(db, 1, primary, 'all');
    expect(out.map((r) => r.id)).toEqual([11]); // 10 already present → dropped
  });

  it('returns nothing for a symbols-only query (graph yields files)', () => {
    const db = fakeDb({ callers: { doThing: [10] }, files: [file(10, 'a.ts')] });
    expect(expandGraph(db, 1, [symbolSeed(1, 'doThing')], 'symbols')).toEqual([]);
  });

  it('ranks a file reached from multiple seeds ahead of a single-seed one', () => {
    const db = fakeDb({ callers: { a: [10, 11], b: [10] }, files: [file(10, 'shared.ts'), file(11, 'single.ts')] });
    const out = expandGraph(db, 1, [symbolSeed(1, 'a'), symbolSeed(2, 'b')], 'all');
    expect(out.map((r) => r.id)).toEqual([10, 11]); // file 10 reached from both seeds → ranks first
  });

  it('caps neighbors per seed (a hub symbol cannot blow up the set)', () => {
    const many = Array.from({ length: 100 }, (_, i) => i + 1);
    const db = fakeDb({ callers: { hub: many }, files: many.map((id) => file(id, `f${id}.ts`)) });
    const out = expandGraph(db, 1, [symbolSeed(999, 'hub')], 'all', { maxNeighborsPerSeed: 10, maxResults: 20 });
    expect(out.length).toBe(10);
  });
});
