import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { codeAgentOptimizationTelemetry206 } from '@mcp/store/migrations/206_code_agent_optimization_telemetry.js';
import * as telemetry from '../subagent-telemetry.js';

let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)');
  codeAgentOptimizationTelemetry206.up(db);
});

afterEach(() => db.close());

describe('subagent telemetry reads', () => {
  it('returns the persisted runs and tool calls used by the App Studio agent rail', () => {
    telemetry.start(db, {
      session_id: 7,
      run_id: 'run-verify',
      profile: 'verify',
      label: 'Verify orders',
      task_preview: 'Run the focused acceptance tests',
      max_turns: 8,
    });
    telemetry.recordToolCall(db, {
      session_id: 7,
      run_id: 'run-verify',
      seq: 1,
      turn: 1,
      tool_name: 'shell_command',
      productive: true,
      is_error: false,
      duration_ms: 42,
      result_chars: 120,
    });
    telemetry.complete(db, {
      run_id: 'run-verify',
      reason: 'completed',
      turns: 1,
      auto_continues: 0,
      tool_calls: 1,
      logical_operations: 1,
      productive_operations: 1,
      paginate_calls: 0,
      duplicate_calls: 0,
      error_calls: 0,
      refused_calls: 0,
      elapsed_ms: 80,
      input_tokens: 100,
      output_tokens: 40,
      has_summary: true,
    });

    expect(telemetry.listRuns(db, 7)).toMatchObject([
      { run_id: 'run-verify', profile: 'verify', reason: 'completed', turns: 1, completed_at: expect.any(String) },
    ]);
    expect(telemetry.listRuns(db, 8)).toEqual([]);
    expect(telemetry.listToolCalls(db, 'run-verify')).toMatchObject([
      { seq: 1, tool_name: 'shell_command', productive: 1, is_error: 0, duration_ms: 42 },
    ]);
  });
});
