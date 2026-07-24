import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { codeAgentOptimizationTelemetry206 } from '@mcp/store/migrations/206_code_agent_optimization_telemetry.js';
import { subagentResearchPolicy239 } from '@mcp/store/migrations/239_subagent_research_policy.js';
import * as telemetry from '../subagent-telemetry.js';

let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)');
  codeAgentOptimizationTelemetry206.up(db);
  subagentResearchPolicy239.up(db);
  db.exec(`
    ALTER TABLE coder_subagent_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'running';
    ALTER TABLE coder_subagent_runs ADD COLUMN heartbeat_at TEXT;
    ALTER TABLE coder_subagent_runs ADD COLUMN worker_instance_id TEXT;
  `);
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
});

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
      {
        run_id: 'run-verify', profile: 'verify', reason: 'completed', turns: 1,
        status: 'completed', heartbeat_at: expect.any(String), completed_at: expect.any(String),
      },
    ]);
    expect(telemetry.listRuns(db, 8)).toEqual([]);
    expect(telemetry.listToolCalls(db, 'run-verify')).toMatchObject([
      { seq: 1, tool_name: 'shell_command', productive: 1, is_error: 0, duration_ms: 42 },
    ]);
  });

  it('reconciles incomplete rows from a replaced worker and preserves current ownership', () => {
    telemetry.start(db, {
      session_id: 7,
      run_id: 'run-orphan',
      profile: 'explore',
      max_turns: 8,
    });
    db.prepare("UPDATE coder_subagent_runs SET worker_instance_id='old-worker' WHERE run_id='run-orphan'").run();
    telemetry.start(db, {
      session_id: 8,
      run_id: 'run-current',
      profile: 'verify',
      max_turns: 8,
    });

    expect(telemetry.recoverOrphaned(db, {
      sessionId: 7,
      currentWorkerInstanceId: telemetry.currentSubagentWorkerInstanceId(),
    })).toBe(1);
    expect(telemetry.listRuns(db, 7)[0]).toMatchObject({
      status: 'interrupted',
      reason: 'worker_restart',
      completed_at: expect.any(String),
    });
    expect(telemetry.listRuns(db, 8)[0]).toMatchObject({ status: 'running', completed_at: null });
  });

  it('reconciles a workflow child only by exact session, spawn id, and step label', () => {
    telemetry.start(db, {
      session_id: 7,
      run_id: 'run-workflow-child',
      spawn_id: 'wf_exact-w1',
      label: 'step-a',
      profile: 'explore',
      max_turns: 8,
    });
    telemetry.complete(db, {
      run_id: 'run-workflow-child',
      reason: 'completed',
      turns: 1,
      auto_continues: 0,
      tool_calls: 0,
      logical_operations: 0,
      productive_operations: 0,
      paginate_calls: 0,
      duplicate_calls: 0,
      error_calls: 0,
      refused_calls: 0,
      elapsed_ms: 10,
      input_tokens: 1,
      output_tokens: 1,
      has_summary: true,
      output_id: 'result:workflow-child',
    });

    expect(telemetry.reconcileWorkflowStepRun(
      db,
      7,
      'wf_exact-w1',
      'step-a',
    )).toMatchObject({
      outcome: 'terminal',
      runId: 'run-workflow-child',
      stepStatus: 'completed',
      resultRef: 'result:workflow-child',
    });
    expect(telemetry.reconcileWorkflowStepRun(
      db,
      7,
      'wf_exact-w1',
      'step-b',
    )).toMatchObject({
      outcome: 'outcome_unknown',
    });
    expect(telemetry.reconcileWorkflowStepRun(
      db,
      8,
      'wf_exact-w1',
      'step-a',
    )).toMatchObject({
      outcome: 'outcome_unknown',
    });
  });

  it('requires agreeing terminal legacy and AgentRun projections in ENFORCE', () => {
    telemetry.start(db, {
      session_id: 7,
      run_id: 'run-enforced-child',
      spawn_id: 'wf_enforced-w1',
      label: 'step-a',
      profile: 'explore',
      max_turns: 8,
    });
    telemetry.complete(db, {
      run_id: 'run-enforced-child',
      reason: 'completed',
      turns: 1,
      auto_continues: 0,
      tool_calls: 0,
      logical_operations: 0,
      productive_operations: 0,
      paginate_calls: 0,
      duplicate_calls: 0,
      error_calls: 0,
      refused_calls: 0,
      elapsed_ms: 10,
      input_tokens: 1,
      output_tokens: 1,
      has_summary: true,
    });
    db.exec(`
      CREATE TABLE agent_runs (
        agent_run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        terminal_reason TEXT,
        result_ref TEXT
      );
      INSERT INTO agent_runs (
        agent_run_id, status, terminal_reason, result_ref
      ) VALUES (
        'agent-run:subagent:run-enforced-child',
        'completed',
        'completed',
        'result:enforced-child'
      );
    `);
    vi.stubEnv('CODER_AGENT_RUN_STORE_ENFORCE', '1');

    expect(telemetry.reconcileWorkflowStepRun(
      db,
      7,
      'wf_enforced-w1',
      'step-a',
    )).toMatchObject({
      outcome: 'terminal',
      stepStatus: 'completed',
      resultRef: 'result:enforced-child',
    });

    db.prepare(`
      UPDATE agent_runs
      SET terminal_reason=NULL
      WHERE agent_run_id='agent-run:subagent:run-enforced-child'
    `).run();
    expect(telemetry.reconcileWorkflowStepRun(
      db,
      7,
      'wf_enforced-w1',
      'step-a',
    )).toMatchObject({
      outcome: 'outcome_unknown',
    });

    db.prepare(`
      UPDATE agent_runs
      SET terminal_reason='failed'
      WHERE agent_run_id='agent-run:subagent:run-enforced-child'
    `).run();
    expect(telemetry.reconcileWorkflowStepRun(
      db,
      7,
      'wf_enforced-w1',
      'step-a',
    )).toMatchObject({
      outcome: 'outcome_unknown',
    });
  });
});
