/**
 * Migration 145 — user-scoped memory (Workstream A).
 *
 * The agent memory was 100% codebase-centric (every snapshot bound to a real
 * project). This adds a USER scope: durable facts about who the user is and
 * how they want the agent to work, applying across ALL projects.
 *
 * Implementation reuses the entire snapshot pipeline (FTS, embeddings, dedup,
 * retrieval, distill-log, editor UI) via a reserved sentinel project — id 0,
 * name "__user__" — that holds the user rows. A `scope` discriminator
 * ('project' | 'user') labels them so project-memory read paths never surface
 * user rows. The hidden project is excluded from the dashboard's project list
 * (see db/projects.ts: `WHERE id <> 0`).
 *
 * Idempotent + forward-only (the runner is version-gated). Existing rows
 * default to scope 'project' → zero behaviour change.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const userMemory145: Migration = {
  version: 145,
  name: 'user_memory',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'snapshots', 'scope', "TEXT NOT NULL DEFAULT 'project'");
    // Seed the hidden user-memory project. The FK on snapshots.project_id is
    // NOT NULL, so this row must exist before any user snapshot is written.
    db.prepare(
      "INSERT OR IGNORE INTO projects (id, name, root_path, memory_enabled) VALUES (0, '__user__', '', 1)",
    ).run();
    db.exec('CREATE INDEX IF NOT EXISTS idx_snapshots_scope ON snapshots(scope);');
  },
};
