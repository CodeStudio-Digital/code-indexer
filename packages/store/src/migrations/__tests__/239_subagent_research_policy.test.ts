import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { codeAgentOptimizationTelemetry206 } from '../206_code_agent_optimization_telemetry.js';
import { subagentResearchPolicy239 } from '../239_subagent_research_policy.js';
import { subagentRunLifecycle248 } from '../248_subagent_run_lifecycle.js';

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
    subagentRunLifecycle248.up(db);
    expect(columns()).toEqual(expect.arrayContaining([
      'research_depth',
      'soft_tool_target',
      'soft_time_target_ms',
      'synthesis_nudged',
      'status',
      'heartbeat_at',
      'worker_instance_id',
    ]));
    expect(() => subagentResearchPolicy239.up(db)).not.toThrow();
  });
});
