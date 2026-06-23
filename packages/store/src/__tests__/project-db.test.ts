/**
 * Infra coverage for the per-project DB layer (tiered-hybrid split, plan §6).
 * Runs real better-sqlite3 under Node — verifies path resolution, schema reuse,
 * the ATTACH federation primitive (parity + batching), and pool LRU lifecycle.
 *
 * ABI note: needs `pnpm node:rebuild` (better-sqlite3 built for Node, not
 * Electron) — ERR_DLOPEN_FAILED here is an ABI mismatch, not a logic bug.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveProjectDbLocation,
  centralFallbackDir,
  openRawProjectDb,
  ProjectDb,
  ProjectDbPool,
  withAttachedProjects,
  fanOutProjects,
  attachedDbCap,
  aliasFor,
  ATTACH_BATCH,
  AttachLimitError,
  PROJECT_DB_DIRNAME,
} from '../project-db/index.js';

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'mcp-pdb-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('resolveProjectDbLocation', () => {
  it('co-locates the DB under <root>/.mcp-indexer for a writable root', () => {
    const root = freshDir();
    const loc = resolveProjectDbLocation(7, root);
    expect(loc.isFallback).toBe(false);
    expect(loc.dir).toBe(join(root, PROJECT_DB_DIRNAME));
    expect(loc.dbPath).toBe(join(root, PROJECT_DB_DIRNAME, 'index.db'));
    expect(loc.vectorsPath).toBe(join(root, PROJECT_DB_DIRNAME, 'vectors.db'));
  });

  it('falls back to the central dir for the user-memory sentinel (id 0)', () => {
    const loc = resolveProjectDbLocation(0, '/some/root');
    expect(loc.isFallback).toBe(true);
    expect(loc.dir).toBe(centralFallbackDir(0));
  });

  it('falls back for an empty/missing root', () => {
    expect(resolveProjectDbLocation(3, null).isFallback).toBe(true);
    expect(resolveProjectDbLocation(3, '   ').isFallback).toBe(true);
  });

  it('honors forceFallback', () => {
    const root = freshDir();
    expect(resolveProjectDbLocation(9, root, { forceFallback: true }).isFallback).toBe(true);
  });
});

describe('ProjectDb (schema reuse)', () => {
  it('opens a project DB with the full schema and a non-zero version', () => {
    const root = freshDir();
    const loc = resolveProjectDbLocation(1, root);
    const pdb = new ProjectDb(1, loc.dbPath);
    try {
      // Reuses the central schema → core tables exist in the project file.
      const tables = (pdb.raw().prepare(
        `SELECT name FROM sqlite_master WHERE type='table'`,
      ).all() as { name: string }[]).map((r) => r.name);
      expect(tables).toContain('files');
      expect(tables).toContain('coder_sessions');
      const v = pdb.raw().prepare(`SELECT MAX(version) v FROM schema_version`).get() as { v: number };
      expect(v.v).toBeGreaterThanOrEqual(161);
      expect(existsSync(loc.dbPath)).toBe(true);
    } finally {
      pdb.close();
    }
  });

  it('is idempotent on reopen (migrations already applied)', () => {
    const root = freshDir();
    const loc = resolveProjectDbLocation(2, root);
    new ProjectDb(2, loc.dbPath).close();
    const again = new ProjectDb(2, loc.dbPath);
    try {
      const v = again.raw().prepare(`SELECT MAX(version) v FROM schema_version`).get() as { v: number };
      expect(v.v).toBeGreaterThanOrEqual(161);
    } finally {
      again.close();
    }
  });
});

/** Minimal project-like DB with a `rows(project_id, val)` table for ATTACH tests. */
function seedMini(dbPath: string, projectId: number, vals: number[]): void {
  const db = openRawProjectDb(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS rows (project_id INTEGER, val INTEGER)`);
  const ins = db.prepare(`INSERT INTO rows (project_id, val) VALUES (?, ?)`);
  const tx = db.transaction(() => vals.forEach((v) => ins.run(projectId, v)));
  tx();
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
}

describe('ATTACH federation', () => {
  it('reads identical rows across attached project DBs (parity)', () => {
    const dir = freshDir();
    const centralPath = join(dir, 'central.db');
    const p1 = join(dir, 'p1.db');
    const p2 = join(dir, 'p2.db');
    seedMini(p1, 1, [10, 20]);
    seedMini(p2, 2, [30]);
    const central = openRawProjectDb(centralPath);
    try {
      const total = withAttachedProjects(
        central,
        [
          { projectId: 1, dbPath: p1, alias: aliasFor(1) },
          { projectId: 2, dbPath: p2, alias: aliasFor(2) },
        ],
        (db, aliases) => {
          const union = aliases.map((a) => `SELECT val FROM ${a}.rows`).join(' UNION ALL ');
          return (db.prepare(`SELECT SUM(val) s FROM (${union})`).get() as { s: number }).s;
        },
      );
      expect(total).toBe(60);
      // Detached afterwards: querying the alias must now fail.
      expect(() => central.prepare(`SELECT 1 FROM p1.rows`).get()).toThrow();
    } finally {
      central.close();
    }
  });

  it('rejects attaching more than ATTACH_BATCH at once', () => {
    const central = openRawProjectDb(':memory:');
    try {
      const targets = Array.from({ length: ATTACH_BATCH + 1 }, (_, i) => ({
        projectId: i,
        dbPath: ':memory:',
        alias: aliasFor(i),
      }));
      expect(() => withAttachedProjects(central, targets, () => 0)).toThrow(AttachLimitError);
    } finally {
      central.close();
    }
  });

  it('fans out across batches for more projects than the cap', () => {
    const dir = freshDir();
    const n = ATTACH_BATCH + 3; // forces 2 batches
    const targets = Array.from({ length: n }, (_, i) => {
      const path = join(dir, `p${i}.db`);
      seedMini(path, i, [i + 1]); // val = i+1
      return { projectId: i, dbPath: path, alias: aliasFor(i) };
    });
    const sums = fanOutProjects<number>({
      centralOpener: () => openRawProjectDb(join(dir, 'fed-central.db')),
      targets,
      perBatch: (db, aliases) =>
        aliases.map(
          (a) => (db.prepare(`SELECT SUM(val) s FROM ${a}.rows`).get() as { s: number }).s,
        ),
    });
    // Sum of 1..n = n(n+1)/2
    expect(sums.reduce((a, b) => a + b, 0)).toBe((n * (n + 1)) / 2);
  });

  it('reports SQLITE_MAX_ATTACHED and keeps ATTACH_BATCH under it', () => {
    const db = openRawProjectDb(':memory:');
    try {
      const cap = attachedDbCap(db);
      // Older builds may not advertise it; when present it must exceed our batch.
      if (cap !== null) expect(ATTACH_BATCH).toBeLessThanOrEqual(cap);
    } finally {
      db.close();
    }
  });
});

describe('ProjectDbPool', () => {
  it('caches handles, reuses on get, and evicts the LRU over capacity', () => {
    const dir = freshDir();
    const pool = new ProjectDbPool({
      resolve: (id) => ({ dbPath: join(dir, `p${id}.db`) }),
      maxOpen: 2,
    });
    try {
      const a1 = pool.get(1);
      const a1again = pool.get(1);
      expect(a1again).toBe(a1); // same cached handle
      pool.get(2);
      expect(pool.size).toBe(2);
      pool.get(3); // exceeds cap → evicts LRU (project 1)
      expect(pool.size).toBe(2);
      expect(pool.has(1)).toBe(false);
      expect(pool.has(3)).toBe(true);
    } finally {
      pool.closeAll();
    }
  });
});
