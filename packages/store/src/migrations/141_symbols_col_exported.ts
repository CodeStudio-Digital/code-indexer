/**
 * Migration 141 — editor-grade symbol metadata.
 *
 * `symbols.col` / `symbols.end_line`: tree-sitter always had exact start
 * column + end line (the INSERT discarded them); the editor needs them for
 * precise go-to-definition ranges and file-structure popups.
 *
 * `symbols.exported`: per-language visibility flag (TS export, Rust pub,
 * Go uppercase, PHP non-private, Python non-underscore, fallback top-level)
 * — drives project-wide prefix completion without drowning it in privates.
 *
 * `symbol_references.col`: same precision for find-usages jumps.
 *
 * `idx_symbols_project_name`: the prefix-completion range scan
 * (`name >= ? AND name < ?`) needs (project_id, name); the legacy
 * `idx_symbols_name(name)` would scan every project in the DB.
 *
 * Backfill: blanking `files.content_hash` makes the next structural run
 * re-extract EVERY file (tree-sitter, ~15ms/file, $0) and repopulate the new
 * columns. `semantic_hash` is untouched — the re-extract writes the SAME
 * content hash back, so the dumb→smart staleness picture doesn't change.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const symbolsColExported141: Migration = {
  version: 141,
  name: 'symbols_col_exported',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'symbols', 'col', 'INTEGER');
    addColumnIfMissing(db, 'symbols', 'end_line', 'INTEGER');
    addColumnIfMissing(db, 'symbols', 'exported', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'symbol_references', 'col', 'INTEGER');
    db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_project_name ON symbols(project_id, name)');
    db.exec("UPDATE files SET content_hash = '' WHERE content_hash <> ''");
  },
};
