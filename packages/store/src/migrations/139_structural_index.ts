/**
 * Migration 139 — structural-index layer ("dumb mode") groundwork.
 *
 * `files.semantic_hash` records the content hash at the time the SEMANTIC
 * layer (LLM summary/concepts/layer) was last computed for the file. The
 * structural pipeline advances `content_hash` without touching it, so
 * `semantic_hash != content_hash` ⇔ "semantics are stale" — the full index
 * uses that to re-run the LLM only where needed. Backfill: today summary and
 * content_hash are always written together (files.upsert), so existing rows
 * with a summary are semantically fresh by construction.
 *
 * `projects.structural_indexed_at` stamps the last structural pass (distinct
 * from `last_indexed`, which keeps meaning "semantic index").
 *
 * `runs.kind` ('full' | 'structural') keeps run history auditable and lets
 * snapshot diffing pair only full runs (structural runs have no
 * file_snapshots).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const structuralIndex139: Migration = {
  version: 139,
  name: 'structural_index',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'files', 'semantic_hash', 'TEXT');
    db.exec(`
      UPDATE files SET semantic_hash = content_hash
      WHERE semantic_hash IS NULL AND summary IS NOT NULL AND summary <> ''
    `);
    addColumnIfMissing(db, 'projects', 'structural_indexed_at', 'TEXT');
    addColumnIfMissing(db, 'runs', 'kind', "TEXT NOT NULL DEFAULT 'full'");
    db.exec('CREATE INDEX IF NOT EXISTS idx_files_semantic ON files(project_id, semantic_hash)');
  },
};
