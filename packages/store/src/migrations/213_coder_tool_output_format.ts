/**
 * Migration 213 — model-facing tool-result format telemetry.
 *
 * `output_format` distinguishes text/markdown/json delivered to the model;
 * `structured_output_chars` stores only the compact serialized size of the
 * hidden structured payload. The payload itself is never persisted here.
 * coder_tool_calls is central-only, so trimmed project DBs are a guarded no-op.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
}

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export const coderToolOutputFormat213: Migration = {
  version: 213,
  name: 'coder_tool_output_format',
  up: (db: DB): void => {
    if (!tableExists(db, 'coder_tool_calls')) return;
    addColumnIfMissing(db, 'coder_tool_calls', 'output_format', 'TEXT');
    addColumnIfMissing(db, 'coder_tool_calls', 'structured_output_chars', 'INTEGER');
  },
};
