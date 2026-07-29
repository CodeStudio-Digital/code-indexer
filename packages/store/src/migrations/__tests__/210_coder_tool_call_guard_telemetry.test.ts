import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { coderToolCallGuardTelemetry210 } from '../210_coder_tool_call_guard_telemetry.js';
import { MIGRATIONS } from '../index.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

function columns(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((row) => row.name);
}

beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

describe('migration 210 — coder tool-call guard telemetry', () => {
  // Asserts POSITION, not "is last" — the original form rotted the moment
  // migration 211 landed and says nothing about this migration.
  it('is registered directly after 209', () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    expect(versions.indexOf(210)).toBe(versions.indexOf(209) + 1);
    expect(MIGRATIONS[versions.indexOf(210)]).toMatchObject({
      version: 210,
      name: 'coder_tool_call_guard_telemetry',
    });
  });

  it('is a no-op for trimmed project databases', () => {
    expect(() => coderToolCallGuardTelemetry210.up(db)).not.toThrow();
    expect(columns('coder_tool_calls')).toEqual([]);
  });

  it('adds nullable guard, novelty, delivery, and policy columns', () => {
    db.exec('CREATE TABLE coder_tool_calls (id INTEGER PRIMARY KEY)');

    coderToolCallGuardTelemetry210.up(db);

    expect(columns('coder_tool_calls')).toEqual(expect.arrayContaining([
      'guard_action',
      'guard_reason',
      'would_block',
      'state_epoch',
      'result_novel',
      'coverage_novel',
      'delivered',
      'repeat_policy',
      'execution_class',
      'guard_origin_tool_use_id',
    ]));

    const added = db.prepare('PRAGMA table_info(coder_tool_calls)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: unknown;
    }>;
    for (const column of added.filter((row) => row.name !== 'id')) {
      expect(column.notnull).toBe(0);
      expect(column.dflt_value).toBeNull();
    }
  });

  it('is idempotent', () => {
    db.exec('CREATE TABLE coder_tool_calls (id INTEGER PRIMARY KEY, guard_action TEXT)');
    coderToolCallGuardTelemetry210.up(db);
    expect(() => coderToolCallGuardTelemetry210.up(db)).not.toThrow();
    expect(columns('coder_tool_calls').filter((name) => name === 'guard_action')).toHaveLength(1);
  });
});
