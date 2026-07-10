import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { codeAgentOptimizationTelemetry206 } from '../206_code_agent_optimization_telemetry.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

function columns(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

describe('migration 206 — code-agent optimization telemetry', () => {
  it('is a no-op for trimmed project databases', () => {
    expect(() => codeAgentOptimizationTelemetry206.up(db)).not.toThrow();
    expect(columns('coder_subagent_runs')).toEqual([]);
  });

  it('adds correlation and reduction columns and creates subagent tables', () => {
    db.exec(`
      CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY);
      CREATE TABLE coder_tool_calls (id INTEGER PRIMARY KEY);
      CREATE TABLE coder_turn_telemetry (id INTEGER PRIMARY KEY);
      CREATE TABLE quality_classifications (id INTEGER PRIMARY KEY);
    `);
    codeAgentOptimizationTelemetry206.up(db);
    expect(columns('coder_tool_calls')).toEqual(expect.arrayContaining([
      'reduction_kind', 'reduction_technique', 'output_id', 'run_id',
      'parent_run_id', 'is_subagent', 'subagent_profile',
      'logical_operation_id', 'productive',
    ]));
    expect(columns('coder_turn_telemetry')).toEqual(expect.arrayContaining([
      'parent_run_id', 'subagent_profile', 'eligible_tools_def_chars',
    ]));
    expect(columns('quality_classifications')).toEqual(expect.arrayContaining([
      'coder_run_id', 'parent_run_id', 'is_subagent', 'subagent_profile',
    ]));
    expect(columns('coder_subagent_runs')).toContain('productive_operations');
    expect(columns('coder_subagent_tool_calls')).toContain('logical_operation_id');
  });

  it('is idempotent', () => {
    db.exec(`CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)`);
    codeAgentOptimizationTelemetry206.up(db);
    expect(() => codeAgentOptimizationTelemetry206.up(db)).not.toThrow();
  });
});
