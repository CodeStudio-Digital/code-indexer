import { describe, it, expect, beforeEach } from 'vitest';
import type { Database as DB } from 'better-sqlite3';
import {
  installSqlTiming,
  setSqlCallSink,
  sqlCallSinkActive,
  sqlLabel,
  resetSqlTimingForTests,
} from '../sql-timing.js';

/**
 * A stand-in for better-sqlite3's Statement prototype chain. The real module is
 * a native addon whose ABI here is built for Electron, so it cannot be loaded
 * under plain Node — and the patch is process-global, which is exactly why it
 * needs its own coverage rather than riding along on integration tests.
 */
function makeFakeDb(): { db: DB; calls: string[] } {
  const calls: string[] = [];
  const StatementProto = {
    run(this: { source: string }, ...args: unknown[]) {
      calls.push(`run:${this.source}:${JSON.stringify(args)}`);
      return { changes: 1 };
    },
    get(this: { source: string }) {
      calls.push(`get:${this.source}`);
      return { ok: 1 };
    },
    all(this: { source: string }) {
      calls.push(`all:${this.source}`);
      return [{ ok: 1 }];
    },
    iterate(this: { source: string }) {
      calls.push(`iterate:${this.source}`);
      return [][Symbol.iterator]();
    },
    boom(this: { source: string }) {
      throw new Error('statement failed');
    },
  };
  const db = {
    prepare(sql: string) {
      return Object.assign(Object.create(StatementProto), { source: sql });
    },
  } as unknown as DB;
  return { db, calls };
}

describe('sql-timing', () => {
  beforeEach(() => {
    resetSqlTimingForTests();
  });

  it('delegates untouched while no sink is installed', () => {
    const { db, calls } = makeFakeDb();
    installSqlTiming(db);
    const stmt = db.prepare('SELECT 1');
    expect(stmt.get()).toEqual({ ok: 1 });
    expect(stmt.all()).toEqual([{ ok: 1 }]);
    expect(calls).toEqual(['get:SELECT 1', 'all:SELECT 1']);
    expect(sqlCallSinkActive()).toBe(false);
  });

  it('reports SQL text and duration to the sink for run/get/all', () => {
    const { db } = makeFakeDb();
    installSqlTiming(db);
    const seen: Array<{ sql: string; ms: number }> = [];
    setSqlCallSink((sql, ms) => seen.push({ sql, ms }));

    db.prepare('SELECT a FROM t WHERE id = ?').get();
    db.prepare('INSERT INTO t VALUES (?)').run();
    db.prepare('SELECT * FROM t').all();

    expect(seen.map((s) => s.sql)).toEqual([
      'SELECT a FROM t WHERE id = ?',
      'INSERT INTO t VALUES (?)',
      'SELECT * FROM t',
    ]);
    for (const s of seen) expect(s.ms).toBeGreaterThanOrEqual(0);
  });

  it('preserves `this`, arguments and return values', () => {
    const { db, calls } = makeFakeDb();
    installSqlTiming(db);
    setSqlCallSink(() => undefined);
    const result = db.prepare('INSERT INTO t VALUES (?, ?)').run(1, 'x');
    expect(result).toEqual({ changes: 1 });
    // `this.source` resolved, and both args reached the original method.
    expect(calls).toEqual(['run:INSERT INTO t VALUES (?, ?):[1,"x"]']);
  });

  it('still reports when the statement throws, and rethrows unchanged', () => {
    const calls: string[] = [];
    const StatementProto = {
      run(this: { source: string }) {
        calls.push('run');
        throw new Error('SQLITE_BUSY: database is locked');
      },
    };
    const db = {
      prepare: (sql: string) => Object.assign(Object.create(StatementProto), { source: sql }),
    } as unknown as DB;
    installSqlTiming(db);
    const seen: Array<{ sql: string; ms: number }> = [];
    setSqlCallSink((sql, ms) => seen.push({ sql, ms }));

    // A contended statement that ultimately fails must STILL be attributable:
    // it blocked the thread for its whole busy_timeout before raising, which is
    // precisely the freeze we are hunting.
    expect(() => (db.prepare('DELETE FROM t') as unknown as { run(): void }).run())
      .toThrow('SQLITE_BUSY: database is locked');
    expect(calls).toEqual(['run']);
    expect(seen.map((s) => s.sql)).toEqual(['DELETE FROM t']);
    expect(seen[0].ms).toBeGreaterThanOrEqual(0);
  });

  it('leaves `iterate` unpatched (timing it would measure generator creation)', () => {
    const { db } = makeFakeDb();
    installSqlTiming(db);
    const seen: string[] = [];
    setSqlCallSink((sql) => seen.push(sql));
    (db.prepare('SELECT * FROM t') as unknown as { iterate(): unknown }).iterate();
    expect(seen).toEqual([]);
  });

  it('is idempotent — a second install does not double-report', () => {
    const { db } = makeFakeDb();
    installSqlTiming(db);
    installSqlTiming(db);
    installSqlTiming(db);
    const seen: string[] = [];
    setSqlCallSink((sql) => seen.push(sql));
    db.prepare('SELECT 1').get();
    expect(seen).toEqual(['SELECT 1']);
  });

  it('MCP_SQL_TIMING=0 refuses to install a sink', () => {
    const { db } = makeFakeDb();
    installSqlTiming(db);
    const previous = process.env.MCP_SQL_TIMING;
    process.env.MCP_SQL_TIMING = '0';
    try {
      const seen: string[] = [];
      setSqlCallSink((sql) => seen.push(sql));
      expect(sqlCallSinkActive()).toBe(false);
      db.prepare('SELECT 1').get();
      expect(seen).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.MCP_SQL_TIMING;
      else process.env.MCP_SQL_TIMING = previous;
    }
  });

  it('survives a handle that cannot prepare', () => {
    const broken = {
      prepare() {
        throw new Error('database is closed');
      },
    } as unknown as DB;
    expect(() => installSqlTiming(broken)).not.toThrow();
  });
});

describe('sqlLabel', () => {
  it('collapses whitespace and trims', () => {
    expect(sqlLabel('  SELECT\n  a,\n  b\nFROM   t  ')).toBe('SELECT a, b FROM t');
  });

  it('truncates long statements to a bounded key', () => {
    const label = sqlLabel(`SELECT ${'x'.repeat(300)} FROM t`);
    expect(label.length).toBeLessThanOrEqual(81);
    expect(label.endsWith('…')).toBe(true);
  });

  it('is stable for the same input', () => {
    const sql = 'SELECT * FROM coder_messages WHERE session_id = ?';
    expect(sqlLabel(sql)).toBe(sqlLabel(sql));
  });
});
