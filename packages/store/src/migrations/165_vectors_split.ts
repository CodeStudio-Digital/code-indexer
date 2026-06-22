/**
 * Migration 165 — per-project vectors split (R2) markers.
 *
 * Adds a SEPARATE split-status track for a project's vectors file, distinct from
 * `db_split_status` (the relational index/feature split). They must be separate:
 * the relational flip can land 'done' while the vectors copy is still pending or
 * failed (it is non-fatal / re-embeddable). Code-vector routing gates on
 * `vectors_split_status = 'done'` ONLY, so a relational-done but vectors-pending
 * project keeps reading the central vectors store instead of an empty per-project
 * vectors.db (which would silently lose all code RAG).
 *
 * Purely additive/idempotent. Gated behind MCP_PROJECT_DB_VECTORS; inert when
 * off. Sentinel id 0 (user memory) and synthetic union projects are seeded
 * 'done' (their vectors stay central by design — docs/user vectors never move).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const vectorsSplit165: Migration = {
  version: 165,
  name: 'vectors_split',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'projects', 'vectors_split_status', "TEXT NOT NULL DEFAULT 'pending'");
    addColumnIfMissing(db, 'projects', 'vectors_split_at', 'TEXT');
    addColumnIfMissing(db, 'projects', 'vectors_split_err', 'TEXT');

    db.exec(`UPDATE projects SET vectors_split_status = 'done' WHERE id = 0;`);
    const hasSynthetic = (db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[])
      .some((c) => c.name === 'is_synthetic');
    if (hasSynthetic) {
      db.exec(`UPDATE projects SET vectors_split_status = 'done' WHERE COALESCE(is_synthetic, 0) = 1;`);
    }
  },
};
