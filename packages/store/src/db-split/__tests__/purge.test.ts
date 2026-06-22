/**
 * C3 — purgeProjectIndex deletes a project's INDEX rows from the central DB
 * (after its split is verified + soaked), cleaning the central code FTS via the
 * real AFTER DELETE triggers, while leaving other projects + the projects row
 * untouched. Scoped to the INDEX class only.
 *
 * ABI: better-sqlite3 → needs `pnpm node:rebuild`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRawProjectDb } from '../../project-db/open.js';
import { initSchema } from '../../db/schema/index.js';
import { runMigrations } from '../../migrations/index.js';
import { purgeProjectIndex } from '../purge.js';
import type { DB } from '../../db/types.js';

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'mcp-purge-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) {
    try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function fullSchemaDb(): DB {
  const db = openRawProjectDb(join(freshDir(), 'central.db')); // full (central-shaped) schema
  initSchema(db);
  runMigrations(db);
  return db;
}

describe('purgeProjectIndex (C3)', () => {
  it("deletes a project's INDEX rows from central, cleans FTS, leaves others intact", () => {
    const db = fullSchemaDb();
    try {
      db.prepare(`INSERT INTO projects (id, name, root_path) VALUES (1,'p1','/p1'),(2,'p2','/p2')`).run();
      for (const pid of [1, 2]) {
        const fileId = db.prepare(
          `INSERT INTO files (project_id, path, language, content_hash) VALUES (?, ?, 'ts', ?)`,
        ).run(pid, `p${pid}/a.ts`, `h${pid}`).lastInsertRowid as number;
        db.prepare(`INSERT INTO symbols (project_id, file_id, name, kind, file_path) VALUES (?, ?, ?, 'function', ?)`)
          .run(pid, fileId, `p${pid}sym`, `p${pid}/a.ts`);
        db.prepare(`INSERT INTO vector_ids (project_id, vector_id, type) VALUES (?, ?, 'file')`)
          .run(pid, `v${pid}`);
      }

      const result = purgeProjectIndex(db, 1);
      expect(result.purged).toBeGreaterThan(0);

      // Project 1 INDEX gone; project 2 intact.
      expect((db.prepare(`SELECT COUNT(*) n FROM files WHERE project_id=1`).get() as { n: number }).n).toBe(0);
      expect((db.prepare(`SELECT COUNT(*) n FROM symbols WHERE project_id=1`).get() as { n: number }).n).toBe(0);
      expect((db.prepare(`SELECT COUNT(*) n FROM vector_ids WHERE project_id=1`).get() as { n: number }).n).toBe(0);
      expect((db.prepare(`SELECT COUNT(*) n FROM files WHERE project_id=2`).get() as { n: number }).n).toBe(1);

      // Central code FTS cleaned for p1 (real AFTER DELETE triggers), p2 still found.
      expect((db.prepare(`SELECT COUNT(*) n FROM files_fts WHERE files_fts MATCH 'p1'`).get() as { n: number }).n).toBe(0);
      expect((db.prepare(`SELECT COUNT(*) n FROM files_fts WHERE files_fts MATCH 'p2'`).get() as { n: number }).n).toBeGreaterThan(0);

      // projects rows kept (only INDEX rows purged) + integrity intact. (The
      // full schema seeds a sentinel project id 0, so check the seeded ids.)
      expect((db.prepare(`SELECT COUNT(*) n FROM projects WHERE id IN (1,2)`).get() as { n: number }).n).toBe(2);
      expect((db.pragma('foreign_key_check') as unknown[]).length).toBe(0);
    } finally {
      db.close();
    }
  });
});
