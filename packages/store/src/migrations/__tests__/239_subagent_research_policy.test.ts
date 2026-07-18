import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { codeAgentOptimizationTelemetry206 } from '../206_code_agent_optimization_telemetry.js';
import { subagentResearchPolicy239 } from '../239_subagent_research_policy.js';
import {
  complete,
  listRuns,
  start,
} from '@mcp/code-agent/sessions/store/subagent-telemetry.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

function columns(): string[] {
  return (db.prepare('PRAGMA table_info(coder_subagent_runs)').all() as Array<{ name: string }>).map((row) => row.name);
}

beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

describe('migration 239 — subagent research policy', () => {
  it('is a no-op for a trimmed database', () => {
    expect(() => subagentResearchPolicy239.up(db)).not.toThrow();
    expect(columns()).toEqual([]);
  });

  it('adds soft-policy telemetry columns and is idempotent', () => {
    db.exec('CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)');
    codeAgentOptimizationTelemetry206.up(db);
    subagentResearchPolicy239.up(db);
    expect(columns()).toEqual(expect.arrayContaining([
      'research_depth',
      'soft_tool_target',
      'soft_time_target_ms',
      'synthesis_nudged',
    ]));
    expect(() => subagentResearchPolicy239.up(db)).not.toThrow();
  });

  it('persists the resolved policy and whether synthesis was nudged', () => {
    db.exec('CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)');
    codeAgentOptimizationTelemetry206.up(db);
    subagentResearchPolicy239.up(db);

    start(db, {
      session_id: 7,
      run_id: 'run-research',
      profile: 'explore',
      max_turns: 0,
      research_depth: 'quick',
      soft_tool_target: 16,
      soft_time_target_ms: 180_000,
    });
    complete(db, {
      run_id: 'run-research',
      reason: 'completed',
      turns: 18,
      auto_continues: 0,
      tool_calls: 16,
      logical_operations: 15,
      productive_operations: 15,
      paginate_calls: 1,
      duplicate_calls: 0,
      error_calls: 0,
      refused_calls: 0,
      elapsed_ms: 181_000,
      input_tokens: 100,
      output_tokens: 20,
      has_summary: true,
      synthesis_nudged: true,
    });

    expect(listRuns(db, 7, 1)[0]).toMatchObject({
      research_depth: 'quick',
      soft_tool_target: 16,
      soft_time_target_ms: 180_000,
      synthesis_nudged: 1,
    });
  });
});
