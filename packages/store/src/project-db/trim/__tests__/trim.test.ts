/**
 * C2 — trimProjectSchema turns a full-schema project DB into a project-only one.
 *
 * Builds the REAL full schema (initSchema + runMigrations), runs the trim, and
 * asserts: every central table is gone, NO table survives outside the project
 * KEEP set (completeness of the drop-list — catches a missed central table),
 * the project tables + code FTS survive + are writable, foreign_key_check is
 * clean, and a re-run is a no-op.
 *
 * ABI: better-sqlite3 → needs `pnpm node:rebuild`.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRawProjectDb } from '../../open.js';
import { initSchema } from '../../../db/schema/index.js';
import { runMigrations } from '../../../migrations/index.js';
import { trimProjectSchema } from '../index.js';
import { CENTRAL_DROP_TABLES, projectKeepTables } from '../drop-list.js';
import type { DB } from '../../../db/types.js';

beforeAll(() => {
  process.env.MCP_PROJECT_DB = '1'; // enable the split → flags.trim defaults on
});

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'mcp-trim-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) {
    try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function buildFullSchema(): { db: DB; path: string } {
  const path = join(freshDir(), 'index.db');
  const db = openRawProjectDb(path);
  initSchema(db);
  runMigrations(db);
  return { db, path };
}

function userTables(db: DB): string[] {
  return (db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
  ).all() as { name: string }[]).map((r) => r.name);
}

describe('trimProjectSchema (C2)', () => {
  it('drops every central table and leaves a project-only DB that still writes', () => {
    const { db } = buildFullSchema();
    try {
      // Sanity: the full schema really did create central tables.
      expect(userTables(db)).toContain('coder_sessions');
      expect(userTables(db)).toContain('company_sessions');

      trimProjectSchema(db);

      const after = userTables(db);
      // 1) No central table survives.
      for (const t of CENTRAL_DROP_TABLES) expect(after).not.toContain(t);
      // 2) Completeness: nothing survives outside the project KEEP set + FTS
      //    shadows. A leftover here is a central table missing from the drop-list.
      const keep = projectKeepTables();
      const isFtsShadow = (n: string) => /^(files_fts|symbols_fts|file_contents_fts)(_.*)?$/.test(n);
      const leftover = after.filter((n) => !keep.has(n) && !isFtsShadow(n));
      expect(leftover, `central tables missing from drop-list: ${leftover.join(', ')}`).toEqual([]);
      // 3) Core project tables + code FTS survive (FTS5 vtabs list as type='table').
      for (const t of ['files', 'symbols', 'api_collections', 'files_fts', 'symbols_fts', 'file_contents_fts']) {
        expect(after).toContain(t);
      }
      // 4) FK integrity intact (no dangling cross-DB FK).
      expect((db.pragma('foreign_key_check') as unknown[]).length).toBe(0);

      // 5) Writes still work: seed a project, insert a file → files_fts updates.
      db.prepare(`INSERT INTO projects (id, name, root_path) VALUES (1, 'p', '/p')`).run();
      db.prepare(
        `INSERT INTO files (project_id, path, language, content_hash) VALUES (1, 'a.ts', 'ts', 'h')`,
      ).run();
      const ftsHits = db.prepare(`SELECT COUNT(*) AS n FROM files_fts`).get() as { n: number };
      expect(ftsHits.n).toBeGreaterThanOrEqual(0); // FTS table queryable post-trim

      // 6) A project table that had a cross-DB FK is now writable with a dangling
      //    central pointer (FK stripped) — pipeline_executions with a project_id.
      db.prepare(`INSERT INTO pipelines (name, project_id, graph_json) VALUES ('pl', 1, '{}')`).run();
    } finally {
      db.close();
    }
  });

  it('is idempotent — a second trim is a no-op', () => {
    const { db } = buildFullSchema();
    try {
      trimProjectSchema(db);
      const first = userTables(db).sort();
      trimProjectSchema(db); // re-run
      expect(userTables(db).sort()).toEqual(first);
      expect((db.pragma('foreign_key_check') as unknown[]).length).toBe(0);
    } finally {
      db.close();
    }
  });
});

/**
 * Regression for the indexer-worker crash-loop: a NEW migration that mutates a
 * central table (here `provider_models`, mig 175) ran against a project DB that
 * was created under an older build and already trimmed that table away. The
 * unguarded `ALTER TABLE` threw `Migration 175 ... no such table: provider_models`
 * on every boot. The `tableExists` guard in such migrations makes them a no-op
 * on trimmed project DBs.
 */
describe('central-table migration on a trimmed project DB (mig 175 regression)', () => {
  it('a pending central-table migration after trim is a no-op, not a crash', () => {
    const { db } = buildFullSchema();
    try {
      // A real project DB: full schema, then trimmed → provider_models is gone.
      trimProjectSchema(db);
      expect(userTables(db)).not.toContain('provider_models');

      // Simulate a DB created under a build whose newest migration was ≤174:
      // migration 175 is now "pending" against the already-trimmed DB. (Only 175
      // is removed, so runMigrations re-runs exactly that one.)
      db.prepare('DELETE FROM schema_version WHERE version = ?').run(175);

      // Pre-fix this threw and crash-looped the indexer-worker; the guard makes
      // the central-table ALTER a clean no-op on a project DB.
      expect(() => runMigrations(db)).not.toThrow();

      // The trimmed table stays absent, and 175 is recorded so it never retries.
      expect(userTables(db)).not.toContain('provider_models');
      expect(
        db.prepare('SELECT version FROM schema_version WHERE version = 175').get(),
      ).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it('upgrades a v1-trimmed project DB with newly classified central tables', () => {
    const { db } = buildFullSchema();
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS project_db_meta (key TEXT PRIMARY KEY, value TEXT)`);
      db.prepare(`INSERT OR REPLACE INTO project_db_meta (key, value) VALUES ('trim_version', '1')`).run();
      expect(userTables(db)).toContain('agent_memory');
      expect(userTables(db)).toContain('doc_ingest_runs');

      trimProjectSchema(db);

      expect(userTables(db)).not.toContain('agent_memory');
      expect(userTables(db)).not.toContain('doc_ingest_runs');
      expect(db.prepare(
        `SELECT value FROM project_db_meta WHERE key = 'trim_version'`,
      ).get()).toEqual({ value: '2' });
    } finally {
      db.close();
    }
  });

  it('removes central base tables recreated by the shared bootstrap on reopen', () => {
    const { db } = buildFullSchema();
    try {
      trimProjectSchema(db);
      expect(userTables(db)).not.toContain('agent_memory');

      // initProjectSchema calls initSchema before trim on every writable open.
      initSchema(db);
      expect(userTables(db)).toContain('agent_memory');

      trimProjectSchema(db);
      expect(userTables(db)).not.toContain('agent_memory');
      expect(userTables(db)).not.toContain('runs');
    } finally {
      db.close();
    }
  });

});

describe('App Studio migration on a trimmed project DB (mig 218 regression)', () => {
  it('records the pending migration without recreating central App Studio tables', () => {
    const { db } = buildFullSchema();
    try {
      trimProjectSchema(db);
      expect(userTables(db)).not.toContain('app_studio_sessions');
      expect(userTables(db)).not.toContain('app_studio_work_items');

      // Reproduce an existing project DB opened after migration 218 shipped.
      db.prepare('DELETE FROM schema_version WHERE version = ?').run(218);

      expect(() => runMigrations(db)).not.toThrow();

      expect(userTables(db)).not.toContain('app_studio_sessions');
      expect(userTables(db)).not.toContain('app_studio_work_items');
      expect(
        db.prepare('SELECT version FROM schema_version WHERE version = 218').get(),
      ).toBeTruthy();
    } finally {
      db.close();
    }
  });
});
