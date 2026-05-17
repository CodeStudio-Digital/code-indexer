import type DatabaseConstructor from 'better-sqlite3';
type DB = InstanceType<typeof DatabaseConstructor>;

/**
 * Migration 020: Add structure_hash column to files table.
 *
 * structure_hash is a hash of the sorted `kind:name:signature` list from
 * tree-sitter extraction. When a file's content_hash changes but its
 * structure_hash remains the same (body-only edits), we skip the LLM call
 * and reuse the existing summary/concepts — saving ~100% of LLM cost for
 * that file on re-index.
 */
export const structureHash020 = {
  version: 20,
  name: 'structure_hash',
  up(db: DB) {
    // Idempotent: SQLite errors on duplicate column, so check first
    const cols = db.pragma('table_info(files)') as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'structure_hash')) {
      db.exec('ALTER TABLE files ADD COLUMN structure_hash TEXT');
    }
  },
};
