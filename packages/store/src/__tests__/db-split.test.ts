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
import { splitProject, backupPathFor, copyProjectData } from '../db-split/index.js';
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
  it('upgrades an empty legacy files table before copying classification flags', () => {
    const dir = freshDir();
    const centralPath = join(dir, 'catalog.db');
    const target = join(dir, 'legacy.db');
    const central = seedCentral(centralPath);
    try {
      central.prepare('UPDATE files SET is_test=1,is_generated=1 WHERE id=10').run();
      const stub = openRawProjectDb(target);
      stub.exec(`CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id),
        path TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'unknown', size INTEGER NOT NULL DEFAULT 0,
        line_count INTEGER NOT NULL DEFAULT 0, content_hash TEXT NOT NULL, dependencies TEXT DEFAULT '[]',
        internal_deps TEXT DEFAULT '[]', external_deps TEXT DEFAULT '[]', created_at TEXT, updated_at TEXT,
        UNIQUE(project_id,path))`);
      stub.close();
      const result = splitProject({central,centralDbPath:centralPath,projectDbPath:target,projectId:1,openFreshProjectDb:openFresh});
      expect(result.status, result.reason).toBe('done');
      const check = openRawProjectDb(target);
      try {
        expect(check.prepare('SELECT is_test,is_generated FROM files WHERE id=10').get()).toEqual({is_test:1,is_generated:1});
        expect(check.prepare("SELECT 1 FROM sqlite_schema WHERE name='idx_files_tier'").get()).toBeTruthy();
      } finally { check.close(); }
    } finally { central.close(); }
  });

  it('rolls back imported rows when a concurrent catalog write invalidates the snapshot', () => {
    const dir = freshDir();
    const centralPath = join(dir, 'catalog.db');
    const central = seedCentral(centralPath);
    const other = openRawProjectDb(centralPath);
    const target = openFresh(join(dir, 'target.db'));
    try {
      expect(() => central.transaction(() => {
        central.prepare('SELECT content_hash FROM files WHERE id=10').get();
        copyProjectData(target, centralPath, 1, ['INDEX'], () => {
          other.prepare("UPDATE files SET content_hash='new' WHERE id=10").run();
          central.prepare("UPDATE projects SET db_split_status='verified' WHERE id=1").run();
        });
      })()).toThrow(/locked|busy/i);
      expect(target.prepare('SELECT id FROM files').all()).toEqual([]);
      copyProjectData(target, centralPath, 1);
      expect(target.prepare('SELECT content_hash FROM files WHERE id=10').pluck().get()).toBe('new');
    } finally { target.close(); other.close(); central.close(); }
  });

  it('repairs an exhausted worktree, keeps its ancestor chain and restores the content index', () => {
    const dir = freshDir();
    const centralPath = join(dir, 'central.db');
    const target = join(dir, 'worktree.db');
    const central = seedCentral(centralPath);
    try {
      central.exec(`
        INSERT INTO projects(id,name,root_path,worktree_parent_id) VALUES (3,'nested','/nested',2);
        UPDATE projects SET worktree_parent_id=1 WHERE id=2;
        UPDATE projects SET db_split_status='failed',db_split_attempts=3 WHERE id=3;
        INSERT INTO files(id,project_id,path,content_hash) VALUES (30,3,'x','x'),(31,3,'y','y');
        INSERT INTO file_contents_fts(rowid,content) VALUES
          (10,'parentonly'),(30,'Café café cache'),(31,'');
      `);
      const deps = {central, centralDbPath:centralPath, projectDbPath:target, projectId:3, openFreshProjectDb:openFresh};
      expect(splitProject(deps).reason).toBe('max attempts reached');
      const result = splitProject({...deps, retryFailed:true});
      expect(result.status, result.reason).toBe('done');
      const db = openRawProjectDb(target);
      try {
        expect(db.prepare('SELECT id FROM projects WHERE id>0 ORDER BY id').pluck().all()).toEqual([1,2,3]);
        expect(db.prepare('SELECT id FROM files ORDER BY id').pluck().all()).toEqual([30,31]);
        expect(db.prepare("SELECT rowid FROM file_contents_fts WHERE file_contents_fts MATCH 'cafe'").pluck().all()).toEqual([30]);
        expect(db.prepare("SELECT rowid FROM file_contents_fts WHERE file_contents_fts MATCH 'parentonly'").all()).toEqual([]);
        expect(db.prepare('SELECT id,sz FROM file_contents_fts_docsize ORDER BY id').all()).toEqual(
          central.prepare('SELECT id,sz FROM file_contents_fts_docsize WHERE id>=30 ORDER BY id').all());
        expect(db.pragma('foreign_key_check')).toEqual([]);
      } finally { db.close(); }
    } finally { central.close(); }
  });

  it('keeps a populated unversioned target and a conflicting versioned target intact', () => {
    const dir = freshDir();
    const centralPath = join(dir,'central.db');
    const central = seedCentral(centralPath);
    const target = join(dir,'existing.db');
    const deps = { central, centralDbPath:centralPath, projectDbPath:target, projectId:1, openFreshProjectDb:openFresh };
    try {
      const legacy = openRawProjectDb(target);
      legacy.exec("CREATE TABLE notes(text); INSERT INTO notes VALUES ('local')");
      legacy.close();
      expect(splitProject(deps).reason).toMatch(/contains data/);
      const preserved = openRawProjectDb(target);
      expect(preserved.prepare('SELECT text FROM notes').pluck().get()).toBe('local');
      preserved.close();
      const other = join(dir,'partial.db');
      const partial = openFresh(other);
      partial.exec("INSERT INTO projects(id,name,root_path) VALUES (1,'p1','/p1'); INSERT INTO files(id,project_id,path,content_hash) VALUES (10,1,'src/a.ts','local')");
      partial.close();
      expect(splitProject({...deps, projectDbPath:other}).reason).toMatch(/Row values differ/);
      const check = openRawProjectDb(other);
      try { expect(check.prepare('SELECT content_hash FROM files').pluck().all()).toEqual(['local']); }
      finally { check.close(); }
    } finally { central.close(); }
  });

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
