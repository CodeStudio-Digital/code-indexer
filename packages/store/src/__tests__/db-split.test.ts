/**
 * Coverage for the lazy backfill engine (tiered-hybrid split, plan §8).
 * Seeds a temp central DB, splits one project, and asserts parity, id
 * preservation, FTS auto-population, project isolation, and the marker flow.
 *
 * ABI: needs `pnpm node:rebuild` (better-sqlite3 for Node).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRawProjectDb, initProjectSchema } from '../project-db/index.js';
import {
  splitProject, backupPathFor, isSplitComplete, markSplitCompleteIfDone, readSplitComplete,
  pendingProjectCount,
} from '../db-split/index.js';
import type { DB } from '../db/types.js';

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'mcp-split-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function openFresh(path: string): DB {
  const db = openRawProjectDb(path);
  initProjectSchema(db);
  return db;
}

function seedCentral(path: string): DB {
  const db = openFresh(path);
  db.exec(`
    INSERT INTO projects (id, name, root_path, db_split_status) VALUES
      (1, 'p1', '/p1', 'pending'),
      (2, 'p2', '/p2', 'pending');
  `);
  const ins = db.prepare(`INSERT INTO files (id, project_id, path, content_hash) VALUES (?,?,?,?)`);
  ins.run(10, 1, 'src/a.ts', 'ha');
  ins.run(11, 1, 'src/b.ts', 'hb');
  ins.run(20, 2, 'src/other.ts', 'ho'); // project 2 — must NOT be copied
  return db;
}

describe('splitProject (INDEX backfill)', () => {
  it('copies one project into its own DB with parity, preserved ids, FTS, and isolation', () => {
    const dir = freshDir();
    const centralPath = join(dir, 'index.db');
    const projPath = join(dir, 'p1', '.mcp-indexer', 'index.db');
    const central = seedCentral(centralPath);
    try {
      const outcome = splitProject({
        central,
        centralDbPath: centralPath,
        projectDbPath: projPath,
        projectId: 1,
        openFreshProjectDb: openFresh,
      });
      expect(outcome.status).toBe('done');
      expect(outcome.copied).toBe(2);
      expect(central.prepare(`SELECT db_split_status s FROM projects WHERE id=1`).get()).toEqual({
        s: 'done',
      });

      // The project DB exists and holds exactly project 1's files, ids preserved.
      expect(existsSync(projPath)).toBe(true);
      const proj = openRawProjectDb(projPath);
      try {
        const ids = (proj.prepare(`SELECT id FROM files ORDER BY id`).all() as { id: number }[]).map(
          (r) => r.id,
        );
        expect(ids).toEqual([10, 11]); // not 20
        // Its own catalog row came along (FK satisfaction + self-describing).
        expect(proj.prepare(`SELECT name FROM projects WHERE id=1`).get()).toEqual({ name: 'p1' });
        // FTS auto-populated via the AFTER INSERT trigger during copy.
        const hit = proj.prepare(
          `SELECT f.path p FROM files_fts ff JOIN files f ON f.id = ff.rowid
             WHERE files_fts MATCH 'a' ` ,
        ).all() as { p: string }[];
        expect(hit.some((h) => h.p === 'src/a.ts')).toBe(true);
        // sqlite_sequence advanced so new inserts don't collide with copied ids.
        const seq = proj.prepare(`SELECT seq FROM sqlite_sequence WHERE name='files'`).get() as
          | { seq: number }
          | undefined;
        expect(seq?.seq).toBe(11);
      } finally {
        proj.close();
      }

      // Central is untouched (purge deferred): all 3 files still present.
      expect(
        (central.prepare(`SELECT COUNT(*) n FROM files`).get() as { n: number }).n,
      ).toBe(3);
      // A one-time backup was taken.
      expect(existsSync(backupPathFor(centralPath))).toBe(true);
    } finally {
      central.close();
    }
  });

  it('is a no-op once done and skips the sentinel/synthetic', () => {
    const dir = freshDir();
    const centralPath = join(dir, 'index.db');
    const central = seedCentral(centralPath);
    try {
      // id 0 sentinel (created by migration 145, seeded 'done' by 161) is skipped.
      expect(
        splitProject({
          central,
          centralDbPath: centralPath,
          projectDbPath: join(dir, 'u', 'index.db'),
          projectId: 0,
          openFreshProjectDb: openFresh,
        }).status,
      ).toBe('skipped');

      // Second run after done → no-op.
      const projPath = join(dir, 'p1', '.mcp-indexer', 'index.db');
      splitProject({ central, centralDbPath: centralPath, projectDbPath: projPath, projectId: 1, openFreshProjectDb: openFresh });
      const again = splitProject({ central, centralDbPath: centralPath, projectDbPath: projPath, projectId: 1, openFreshProjectDb: openFresh });
      expect(again.status).toBe('done');
    } finally {
      central.close();
    }
  });
});

describe('split completion / sunset detection', () => {
  it('fires only when all projects are done AND central is drained', () => {
    const dir = freshDir();
    const central = openFresh(join(dir, 'index.db'));
    try {
      // Two projects, no index rows yet. id 0 sentinel exists (mig 145) + 'done' (161).
      central.exec(`
        INSERT INTO projects (id, name, root_path, db_split_status) VALUES
          (1,'p1','/p1','done'),
          (2,'p2','/p2','pending');
      `);
      // p2 still pending → not complete.
      expect(pendingProjectCount(central)).toBe(1);
      expect(isSplitComplete(central)).toBe(false);
      expect(markSplitCompleteIfDone(central)).toBe(false);

      // Mark p2 done; central has no project-scoped rows → complete.
      central.exec(`UPDATE projects SET db_split_status='done' WHERE id=2`);
      expect(pendingProjectCount(central)).toBe(0);
      expect(isSplitComplete(central)).toBe(true);
      expect(markSplitCompleteIfDone(central)).toBe(true);
      expect(readSplitComplete(central)).toBe(true);

      // A leftover central project row blocks completion (canary).
      central.exec(`UPDATE projects SET db_split_status='pending' WHERE id=2`);
      central.prepare(`INSERT INTO files (project_id, path, content_hash) VALUES (1,'x.ts','h')`).run();
      central.exec(`UPDATE projects SET db_split_status='done' WHERE id=2`);
      expect(isSplitComplete(central)).toBe(false);
    } finally {
      central.close();
    }
  });
});
