/**
 * Migration 209 — repair `eligible_tools_def_chars` on databases that had
 * already recorded migration 206 before that column was added to its source.
 *
 * Migrations are immutable once released: changing migration 206 cannot repair
 * an installation whose `schema_version` already contains 206, so this small
 * additive migration intentionally repeats the guarded column check.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
}

function columnExists(db: DB, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some((row) => row.name === column);
}

export const coderTelemetryEligibleToolsRepair209: Migration = {
  version: 209,
  name: 'coder_telemetry_eligible_tools_repair',
  up: (db: DB): void => {
    if (!tableExists(db, 'coder_turn_telemetry')) return;
    if (columnExists(db, 'coder_turn_telemetry', 'eligible_tools_def_chars')) return;
    db.exec('ALTER TABLE coder_turn_telemetry ADD COLUMN eligible_tools_def_chars INTEGER');
  },
};
