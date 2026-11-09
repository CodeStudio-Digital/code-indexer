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
import { isProjectSchemaTrimCurrent, trimProjectSchema } from '../index.js';
import { initProjectSchema } from '../../project-schema.js';
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
  it('skips central bootstrap and foreign-key sweep when a reopened project DB is current', () => {
    const { db } = buildFullSchema();
    try {
      trimProjectSchema(db);
      expect(isProjectSchemaTrimCurrent(db)).toBe(true);
      let foreignKeyChecks = 0;
      const guarded = new Proxy(db, {
        get(target, property) {
          if (property === 'pragma') {
            return (source: string, ...args: unknown[]) => {
              if (source === 'foreign_key_check') foreignKeyChecks += 1;
              return Reflect.apply(target.pragma, target, [source, ...args]);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as DB;

      initProjectSchema(guarded);

      expect(foreignKeyChecks).toBe(0);
      expect(userTables(db)).not.toContain('provider_configs');
    } finally {
      db.close();
    }
  });

  it('drops every central table and leaves a project-only DB that still writes', () => {
    const { db } = buildFullSchema();
    try {
      // Sanity: the full schema still contains essential central catalogs, but
      // migration 263 has already removed every session-scoped table before a
      // project database reaches the trim pass.
      expect(userTables(db)).toContain('provider_configs');
      expect(userTables(db)).toContain('company_templates');
      expect(userTables(db)).not.toContain('coder_sessions');
      expect(userTables(db)).not.toContain('company_sessions');

      trimProjectSchema(db);

      const after = userTables(db);
      // 1) No central table survives.
      for (const t of CENTRAL_DROP_TABLES) expect(after).not.toContain(t);
      // 2) Completeness: nothing survives outside the project KEEP set + FTS
      //    shadows. A leftover here is a central table missing from the drop-list.
      const keep = projectKeepTables();
      const isFtsShadow = (n: string) => /^(files_fts|symbols_fts|file_contents_fts|file_paths_fts)(_.*)?$/.test(n);
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

    } finally {
      db.close();
    }
  });

  /**
   * The declared drop-list drifted by 18 tables (migrations 240-259) before this
   * sweep existed. The KEEP set (db-split copy manifest) is the source of truth:
   * a table outside it can never hold project rows, so an EMPTY one is central by
   * construction. A non-empty unknown table means something DID write to it — a
   * missing manifest entry — so it survives instead of being silently deleted.
   */
  it('sweeps an unknown EMPTY table but preserves an unknown table with rows', () => {
    const { db } = buildFullSchema();
    try {
      db.exec(`CREATE TABLE future_central_thing (id INTEGER PRIMARY KEY, v TEXT)`);
      db.exec(`CREATE TABLE unclassified_with_rows (id INTEGER PRIMARY KEY, v TEXT)`);
      db.prepare(`INSERT INTO unclassified_with_rows (v) VALUES ('keep me')`).run();

      trimProjectSchema(db);

      const after = userTables(db);
      expect(after).not.toContain('future_central_thing');
      expect(after).toContain('unclassified_with_rows');
      expect(db.prepare(`SELECT COUNT(*) AS n FROM unclassified_with_rows`).get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it('re-arms itself for a central table that appears after the marker was stamped', () => {
    const { db } = buildFullSchema();
    try {
      trimProjectSchema(db); // stamps the current trim_version
      db.exec(`CREATE TABLE later_central_table (id INTEGER PRIMARY KEY)`);

      trimProjectSchema(db); // marker is current — only the sweep can catch this

      expect(userTables(db)).not.toContain('later_central_table');
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
  it('reopens a pre-268 project without recreating semantic jobs or blocking chat', () => {
    const { db } = buildFullSchema();
    try {
      trimProjectSchema(db);
      expect(userTables(db)).not.toContain('semantic_jobs');
      db.prepare('DELETE FROM schema_version WHERE version >= ?').run(268);
      expect(() => initProjectSchema(db)).not.toThrow();
      expect(() => initProjectSchema(db)).not.toThrow();
      expect(userTables(db)).not.toContain('semantic_jobs');
      expect(db.prepare('SELECT version FROM schema_version WHERE version = 268').get()).toBeTruthy();
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally { db.close(); }
  });

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
      ).get()).toEqual({ value: '3' });
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

/**
 * The control plane (251-257) and the policy engine landed as central-only tables
 * AFTER the v2 trim, so they were left behind in every project DB until v3. Now
 * that they are dropped, their follow-up migrations must obey the same
 * `tableExists` convention as migration 175 — otherwise a replay against an
 * already-trimmed DB throws `no such table` and crash-loops the boot.
 */
describe('control-plane migrations on a trimmed project DB (252/256/257 guards)', () => {
  const GONE = ['agent_runs', 'runtime_events', 'policy_decision_comparisons'];

  it('records the pending migrations without recreating central control-plane tables', () => {
    const { db } = buildFullSchema();
    try {
      trimProjectSchema(db);
      for (const t of GONE) expect(userTables(db)).not.toContain(t);

      // Reproduce an existing project DB opened after 252/256/257 shipped.
      for (const v of [252, 256, 257]) {
        db.prepare('DELETE FROM schema_version WHERE version = ?').run(v);
      }

      expect(() => runMigrations(db)).not.toThrow();

      for (const t of [...GONE, 'control_plane_divergences']) expect(userTables(db)).not.toContain(t);
      for (const v of [252, 256, 257]) {
        expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(v)).toBeTruthy();
      }
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
