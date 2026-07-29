/**
 * `getStaleBatch` semantics under batching.
 *
 * It used to run 1 + N statements per memory (a row lookup, then one `files`
 * lookup per referenced path) — hundreds of synchronous queries on a recall,
 * all on the Electron main thread. Batching it changed the shape of the code
 * substantially while the observable contract must not move at all, so the
 * edge cases are pinned here.
 *
 * Uses a stub `db` rather than a real connection: better-sqlite3's native build
 * in this repo targets the Electron ABI and cannot load under plain Node.
 */
import { describe, it, expect } from 'vitest';
import type { Database as DB } from 'better-sqlite3';
import { getStaleBatch } from '../agent-memory.js';

interface MemoryRow { id: number; project_id: number; referenced_files: string | null }

/** Minimal `prepare().get()/.all()` router matching the queries under test. */
function makeDb(opts: {
  memories: MemoryRow[];
  files: Record<number, Record<string, string | null>>;
  filesTableThrows?: boolean;
}): { db: DB; statements: number } {
  const counter = { n: 0 };
  const db = {
    prepare(sql: string) {
      counter.n += 1;
      const normalized = sql.replace(/\s+/g, ' ');
      return {
        get(...args: unknown[]) {
          if (normalized.startsWith('SELECT 1 FROM files')) {
            if (opts.filesTableThrows) throw new Error('no such table: files');
            const pid = args[0] as number;
            return Object.keys(opts.files[pid] ?? {}).length > 0 ? { 1: 1 } : undefined;
          }
          throw new Error(`unexpected get: ${normalized}`);
        },
        all(...args: unknown[]) {
          if (normalized.includes('FROM agent_memory')) {
            const ids = args as number[];
            return opts.memories.filter((m) => ids.includes(m.id));
          }
          if (normalized.includes('FROM files')) {
            if (opts.filesTableThrows) throw new Error('no such table: files');
            const [pid, ...paths] = args as [number, ...string[]];
            const table = opts.files[pid] ?? {};
            return paths
              .filter((p) => p in table)
              .map((p) => ({ path: p, content_hash: table[p] ?? undefined }));
          }
          throw new Error(`unexpected all: ${normalized}`);
        },
      };
    },
  } as unknown as DB;
  return { db, get statements() { return counter.n; } };
}

const refs = (entries: Array<[string, string | null]>): string =>
  JSON.stringify(entries.map(([path, hash]) => ({ path, hash })));

describe('getStaleBatch', () => {
  it('returns an empty map for no ids without touching the database', () => {
    const { db, statements } = makeDb({ memories: [], files: {} });
    expect(getStaleBatch(db, [])).toEqual(new Map());
    expect(statements).toBe(0);
  });

  it('flags a path whose hash changed, and leaves a matching one alone', () => {
    const { db } = makeDb({
      memories: [{ id: 1, project_id: 7, referenced_files: refs([['a.ts', 'h1'], ['b.ts', 'h2']]) }],
      files: { 7: { 'a.ts': 'h1', 'b.ts': 'CHANGED' } },
    });
    expect(getStaleBatch(db, [1]).get(1)).toEqual({ stale: ['b.ts'], total: 2 });
  });

  it('treats a path missing from the index as stale', () => {
    const { db } = makeDb({
      memories: [{ id: 1, project_id: 7, referenced_files: refs([['gone.ts', 'h1']]) }],
      files: { 7: { 'other.ts': 'h9' } },
    });
    expect(getStaleBatch(db, [1]).get(1)).toEqual({ stale: ['gone.ts'], total: 1 });
  });

  it('treats a null current hash as stale', () => {
    const { db } = makeDb({
      memories: [{ id: 1, project_id: 7, referenced_files: refs([['a.ts', 'h1']]) }],
      files: { 7: { 'a.ts': null } },
    });
    expect(getStaleBatch(db, [1]).get(1)).toEqual({ stale: ['a.ts'], total: 1 });
  });

  it('counts only paths captured WITH a baseline hash', () => {
    const { db } = makeDb({
      memories: [{ id: 1, project_id: 7, referenced_files: refs([['a.ts', 'h1'], ['b.ts', null]]) }],
      files: { 7: { 'a.ts': 'h1', 'b.ts': 'whatever' } },
    });
    expect(getStaleBatch(db, [1]).get(1)).toEqual({ stale: [], total: 1 });
  });

  it('accepts the legacy bare-string reference shape (no baseline → not judged)', () => {
    const { db } = makeDb({
      memories: [{ id: 1, project_id: 7, referenced_files: JSON.stringify(['a.ts', 'b.ts']) }],
      files: { 7: { 'a.ts': 'h1' } },
    });
    expect(getStaleBatch(db, [1]).get(1)).toEqual({ stale: [], total: 0 });
  });

  it('yields empty entries for unparseable, non-array, null and unknown rows', () => {
    const { db } = makeDb({
      memories: [
        { id: 1, project_id: 7, referenced_files: '{not json' },
        { id: 2, project_id: 7, referenced_files: '{"nope":1}' },
        { id: 3, project_id: 7, referenced_files: null },
      ],
      files: { 7: { 'a.ts': 'h1' } },
    });
    const out = getStaleBatch(db, [1, 2, 3, 999]);
    for (const id of [1, 2, 3, 999]) expect(out.get(id)).toEqual({ stale: [], total: 0 });
  });

  it('returns not-judgeable when the project has no file index', () => {
    const { db } = makeDb({
      memories: [{ id: 1, project_id: 42, referenced_files: refs([['a.ts', 'h1']]) }],
      files: {},
    });
    expect(getStaleBatch(db, [1]).get(1)).toEqual({ stale: [], total: 0 });
  });

  it('skips rather than marks stale when the files lookup throws', () => {
    const { db } = makeDb({
      memories: [{ id: 1, project_id: 7, referenced_files: refs([['a.ts', 'h1']]) }],
      files: { 7: { 'a.ts': 'h1' } },
      filesTableThrows: true,
    });
    // No file index ⇒ not judgeable, matching the old per-path `catch { continue }`.
    expect(getStaleBatch(db, [1]).get(1)).toEqual({ stale: [], total: 0 });
  });

  it('keeps per-memory results separate across projects', () => {
    const { db } = makeDb({
      memories: [
        { id: 1, project_id: 7, referenced_files: refs([['a.ts', 'h1']]) },
        { id: 2, project_id: 8, referenced_files: refs([['a.ts', 'h1']]) },
      ],
      files: { 7: { 'a.ts': 'h1' }, 8: { 'a.ts': 'DIFFERENT' } },
    });
    const out = getStaleBatch(db, [1, 2]);
    expect(out.get(1)).toEqual({ stale: [], total: 1 });
    expect(out.get(2)).toEqual({ stale: ['a.ts'], total: 1 });
  });

  it('issues a bounded number of statements for many memories', () => {
    const memories = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1,
      project_id: 7,
      referenced_files: refs([[`file${i}.ts`, 'h1']]),
    }));
    const files: Record<string, string | null> = {};
    for (let i = 0; i < 60; i++) files[`file${i}.ts`] = 'h1';
    const handle = makeDb({ memories, files: { 7: files } });
    const out = getStaleBatch(handle.db, memories.map((m) => m.id));
    expect(out.size).toBe(60);
    // The old shape prepared 2 statements then ran 60 + 60 queries. Batched, the
    // whole job is a handful of statements regardless of the id count.
    expect(handle.statements).toBeLessThan(10);
  });
});
