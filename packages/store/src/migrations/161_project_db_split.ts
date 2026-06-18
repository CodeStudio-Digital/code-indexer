/**
 * Migration 161 — Tiered-hybrid DB split: central-side scaffolding.
 *
 * Adds the per-project split markers to `projects`, plus two new CENTRAL tables:
 *   - `coder_session_index` — thin routing pointer (session id → owning project
 *     DB) + just enough columns (title/status/model/updated_at) to render the
 *     session sidebar WITHOUT opening any project DB. Token counters stay in the
 *     project DB (high-frequency field). `id` is the global session-id allocator.
 *   - `project_cost_rollup` — denormalized billing aggregate so the global cost
 *     dashboard never has to ATTACH/scan every project DB.
 *
 * Purely additive/idempotent — zero impact on existing data. The actual split
 * is gated behind MCP_PROJECT_DB* flags and runs lazily later (plan §8). The
 * user-memory sentinel (id 0) and synthetic union projects are seeded 'done' so
 * the lazy backfill never selects them (their data stays central by design).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const projectDbSplit161: Migration = {
  version: 161,
  name: 'project_db_split',
  up: (db: DB): void => {
    // ── projects: split markers ──────────────────────────────────────────
    addColumnIfMissing(db, 'projects', 'db_path', 'TEXT');
    addColumnIfMissing(db, 'projects', 'db_split_status', "TEXT NOT NULL DEFAULT 'pending'");
    addColumnIfMissing(db, 'projects', 'db_split_at', 'TEXT');
    addColumnIfMissing(db, 'projects', 'db_split_err', 'TEXT');
    addColumnIfMissing(db, 'projects', 'db_split_attempts', 'INTEGER NOT NULL DEFAULT 0');

    // ── coder_session_index: central routing pointer ─────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS coder_session_index (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  INTEGER NOT NULL,
        is_global   INTEGER NOT NULL DEFAULT 0,
        title       TEXT,
        status      TEXT,
        model       TEXT,
        updated_at  TEXT
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_csi_project ON coder_session_index(project_id);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_csi_updated ON coder_session_index(updated_at DESC);`);

    // ── project_cost_rollup: denormalized billing aggregate ──────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_cost_rollup (
        project_id    INTEGER NOT NULL,
        day           TEXT NOT NULL,
        provider      TEXT NOT NULL,
        model         TEXT NOT NULL DEFAULT '',
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd      REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, day, provider, model)
      );
    `);

    // ── seed sentinels/synthetics as already-migrated ────────────────────
    // Sentinel id 0 (user memory) always; synthetic union projects if present.
    db.exec(`UPDATE projects SET db_split_status = 'done' WHERE id = 0;`);
    const hasSynthetic = (db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[])
      .some((c) => c.name === 'is_synthetic');
    if (hasSynthetic) {
      db.exec(`UPDATE projects SET db_split_status = 'done' WHERE COALESCE(is_synthetic, 0) = 1;`);
    }
  },
};
