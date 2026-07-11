import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { coderTelemetryEligibleToolsRepair209 } from '../209_coder_telemetry_eligible_tools_repair.js';
import { MIGRATIONS, runMigrations } from '../index.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

function columns(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((row) => row.name);
}

beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

describe('migration 209 — coder telemetry eligible-tools repair', () => {
  it('is a no-op for trimmed project databases', () => {
    expect(() => coderTelemetryEligibleToolsRepair209.up(db)).not.toThrow();
    expect(columns('coder_turn_telemetry')).toEqual([]);
  });

  it('repairs through the migration runner when 206 was already recorded without the column', () => {
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE coder_turn_telemetry (
        id INTEGER PRIMARY KEY,
        tools_def_chars INTEGER
      );
    `);
    const markApplied = db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)');
    for (const migration of MIGRATIONS) {
      if (migration.version !== 209) markApplied.run(migration.version, migration.name);
    }

    const result = runMigrations(db);

    expect(result.applied).toEqual([209]);
    expect(columns('coder_turn_telemetry')).toContain('eligible_tools_def_chars');
  });

  it('is idempotent when the repaired column already exists', () => {
    db.exec(`
      CREATE TABLE coder_turn_telemetry (
        id INTEGER PRIMARY KEY,
        eligible_tools_def_chars INTEGER
      );
    `);
    expect(() => coderTelemetryEligibleToolsRepair209.up(db)).not.toThrow();
    expect(columns('coder_turn_telemetry').filter((name) => name === 'eligible_tools_def_chars')).toHaveLength(1);
  });
});
