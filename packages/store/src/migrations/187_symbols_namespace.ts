/**
 * Migration 187 — symbol namespace/FQN.
 *
 * `symbols.namespace`: the language-level container path (PHP namespace,
 * Python dotted module, Go/Java/C#/Kotlin package, Rust mod path). NULL =
 * global / language without namespaces (TS/JS import by file path instead).
 * FQN is DERIVED (`namespace + separator + [parent.] + name`), never stored —
 * storing it would duplicate `parent` and drift.
 *
 * `idx_symbols_project_ns_name`: resolves `use App\Services\Foo;` (and
 * homonym disambiguation) by equality on (project_id, namespace, name).
 *
 * Backfill: blanking `files.content_hash` re-extracts every file on the next
 * structural run (tree-sitter, ~15ms/file, $0) — the migration-141 pattern.
 * `semantic_hash` is untouched, so dumb→smart staleness doesn't change.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const symbolsNamespace187: Migration = {
  version: 187,
  name: 'symbols_namespace',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'symbols', 'namespace', 'TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_project_ns_name ON symbols(project_id, namespace, name)');
    db.exec("UPDATE files SET content_hash = '' WHERE content_hash <> ''");
  },
};
