/**
 * Migration 210 — structured guard/dedup telemetry on coder_tool_calls.
 *
 * All columns are nullable so existing rows and older producers remain valid.
 * The table is central-only and may be absent from trimmed project databases,
 * therefore every alteration is guarded.
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

export const coderToolCallGuardTelemetry210: Migration = {
  version: 210,
  name: 'coder_tool_call_guard_telemetry',
  up: (db: DB): void => {
    if (!tableExists(db, 'coder_tool_calls')) return;

    for (const [column, definition] of [
      ['guard_action', 'TEXT'],
      ['guard_reason', 'TEXT'],
      ['would_block', 'INTEGER'],
      ['state_epoch', 'INTEGER'],
      ['result_novel', 'INTEGER'],
      ['coverage_novel', 'INTEGER'],
      ['delivered', 'INTEGER'],
      ['repeat_policy', 'TEXT'],
      ['execution_class', 'TEXT'],
      ['guard_origin_tool_use_id', 'TEXT'],
    ] as const) {
      addColumnIfMissing(db, 'coder_tool_calls', column, definition);
    }
  },
};
