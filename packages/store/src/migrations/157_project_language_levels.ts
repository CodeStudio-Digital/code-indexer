/**
 * Migration 157 — `projects.language_levels`.
 *
 * Versão da linguagem por projeto (estilo PHPStorm "PHP Language Level"), em JSON
 * `{"php":"8.2","python":"3.11"}`. Entregue ao servidor LSP (Intelephense/Pyright)
 * via `workspace/configuration` + `initializationOptions`, fazendo o autocomplete +
 * hover de símbolos NATIVOS (stubs embutidos no server) respeitar a versão.
 *
 * Forward-idempotent e zero-impact: NULL = "usar default do server" = comportamento
 * de hoje. Mirrors migration 155 (idempotent column add).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const projectLanguageLevels157: Migration = {
  version: 157,
  name: 'project_language_levels',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'projects', 'language_levels', 'TEXT');
  },
};
