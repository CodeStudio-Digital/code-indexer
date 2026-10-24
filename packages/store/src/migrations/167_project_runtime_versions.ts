/**
 * Migration 167 — `projects.runtime_versions`.
 *
 * Versão de RUNTIME (interpretador) por projeto para PHP/Python, em JSON
 * `{"php":"managed:8.3.7","python":"managed:3.12.3"}`. É o que o terminal/runner
 * colocam no PATH ao subir (ver `runtime-resolve.ts`), distinto de
 * `language_levels` (migration 157), que é o alvo de ANÁLISE do LSP. Node fica
 * na coluna própria `node_version` (migration 118) — não é tocada aqui.
 *
 * Forward-idempotent e zero-impact: NULL/ausente = "default do sistema" (sem
 * injeção de PATH) = comportamento de hoje. Espelha migration 157.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const projectRuntimeVersions167: Migration = {
  version: 167,
  name: 'project_runtime_versions',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'projects', 'runtime_versions', 'TEXT');
  },
};
