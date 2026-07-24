import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import {
  CONTROL_PLANE_SCHEMA_VERSION,
  asAgentRunAttemptId,
  asAgentRunId,
  asCorrelationId,
  asSessionCommandId,
  asSessionId,
} from '@mcp/agent-runtime-contracts';
import { ControlPlaneStore } from '@mcp/store/control-plane/index.js';
import { hashControlPlanePayload } from '@mcp/store/control-plane/codec.js';
import { codeAgentOptimizationTelemetry206 } from '@mcp/store/migrations/206_code_agent_optimization_telemetry.js';
import { subagentResearchPolicy239 } from '@mcp/store/migrations/239_subagent_research_policy.js';
import { subagentRunLifecycle248 } from '@mcp/store/migrations/248_subagent_run_lifecycle.js';
import { controlPlaneFoundation251 } from '@mcp/store/migrations/251_control_plane_foundation.js';
import { controlPlaneAlignment252 } from '@mcp/store/migrations/252_control_plane_alignment.js';
import { agentRunChildCardinality257 } from '@mcp/store/migrations/257_agent_run_child_cardinality.js';
import { coderOrchestrationCheckpoints259 } from '@mcp/store/migrations/259_coder_orchestration_checkpoints.js';
import {
  createAgentRunRecorder,
  resetAgentRunShadowMetricsForTests,
  snapshotAgentRunShadowMetrics,
} from '../agent-run-recorder.js';
import {
  complete,
  heartbeat,
  recoverOrphaned,
  start,
  type CompleteSubagentRunInput,
  type StartSubagentRunInput,
} from '../../sessions/store/subagent-telemetry.js';

type DB = InstanceType<typeof DatabaseConstructor>;

const LEGACY_SESSION_ID = 42;
const SESSION_ID = asSessionId('session:coder:42');
const COMMAND_ID = asSessionCommandId('command:coder:root');
const ROOT_RUN_ID = asAgentRunId('agent-run:coder:root');
const ROOT_ATTEMPT_ID = asAgentRunAttemptId('agent-run-attempt:coder:root:1');
const CORRELATION_ID = asCorrelationId('correlation:coder:root');
const ACTOR = { actorId: 'local-user', actorType: 'user' as const, source: 'http' as const };
const PARENT_RUNNER_ID = 'coder-run:parent';
const CHILD_RUNNER_ID = 'coder-run:child';
const AT = '2026-01-01T00:00:00.000Z';

let db: DB;
let previousFlag: string | undefined;
let previousEnforceFlag: string | undefined;

function setupSchema(): void {
  db.exec(`
    CREATE TABLE coder_sessions (
      id INTEGER PRIMARY KEY
    );
    INSERT INTO coder_sessions (id) VALUES (${LEGACY_SESSION_ID});
  `);
  codeAgentOptimizationTelemetry206.up(db);
  subagentResearchPolicy239.up(db);
  subagentRunLifecycle248.up(db);
  controlPlaneFoundation251.up(db);
  controlPlaneAlignment252.up(db);
  agentRunChildCardinality257.up(db);
  coderOrchestrationCheckpoints259.up(db);
}

function setupRoot(): ControlPlaneStore {
  const store = new ControlPlaneStore(db, { journalEnabled: true });
  const payload = { task: 'root' };
  const result = store.acceptCommand({
    command: {
      schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      commandId: COMMAND_ID,
      idempotencyKey: 'idem:root',
      kind: 'start',
      sessionId: SESSION_ID,
      actor: ACTOR,
      requestedAt: AT,
      correlationId: CORRELATION_ID,
      payload,
    },
    payloadHash: hashControlPlanePayload(payload),
    legacySessionId: LEGACY_SESSION_ID,
    run: {
      agentRunId: ROOT_RUN_ID,
      attemptId: ROOT_ATTEMPT_ID,
      role: 'build',
      agentDefinitionId: 'build',
      waitMode: 'foreground',
      requestedProvider: 'anthropic',
      requestedModel: 'claude-parent',
      requestedCapabilityProfile: 'navigate',
      executorOwnerId: 'coder-worker:42',
      executorExpiresAt: '2099-01-01T00:00:00.000Z',
    },
  });
  expect(result.kind).toBe('accepted');
  store.markRunStarted({
    sessionId: SESSION_ID,
    legacySessionId: LEGACY_SESSION_ID,
    commandId: COMMAND_ID,
    correlationId: CORRELATION_ID,
    actor: ACTOR,
    agentRunId: ROOT_RUN_ID,
    attemptId: ROOT_ATTEMPT_ID,
    executorOwnerId: 'coder-worker:42',
    fencingEpoch: 1,
  }, PARENT_RUNNER_ID, AT);
  return store;
}

function startInput(overrides: Partial<StartSubagentRunInput> = {}): StartSubagentRunInput {
  return {
    session_id: LEGACY_SESSION_ID,
    run_id: CHILD_RUNNER_ID,
    parent_run_id: PARENT_RUNNER_ID,
    spawn_id: 'spawn:child',
    profile: 'investigator',
    label: 'Inspect lifecycle',
    task_preview: 'Inspect lifecycle metadata only',
    requested_provider: 'anthropic',
    requested_model: 'claude-child',
    requested_reasoning_effort: 'high',
    wait_mode: 'foreground',
    effective_provider: 'anthropic',
    effective_model: 'claude-child',
    effective_reasoning_effort: 'high',
    effective_capabilities: ['read_file', 'grep_code'],
    environment_fingerprint: 'sha256:test-environment',
    policy_mode: 'inherited_permission_gate',
    max_turns: 8,
    max_tool_calls: 20,
    timeout_ms: 30_000,
    stall_ms: 10_000,
    research_depth: 'standard',
    soft_tool_target: 10,
    soft_time_target_ms: 15_000,
    ...overrides,
  };
}

function completeInput(overrides: Partial<CompleteSubagentRunInput> = {}): CompleteSubagentRunInput {
  return {
    run_id: CHILD_RUNNER_ID,
    reason: 'completed',
    turns: 3,
    auto_continues: 0,
    tool_calls: 2,
    logical_operations: 2,
    productive_operations: 2,
    paginate_calls: 0,
    duplicate_calls: 0,
    error_calls: 0,
    refused_calls: 0,
    elapsed_ms: 100,
    input_tokens: 10,
    output_tokens: 5,
    has_summary: true,
    output_id: 'output:child',
    ...overrides,
  };
}

beforeEach(() => {
  previousFlag = process.env.CODER_AGENT_RUN_STORE_SHADOW;
  previousEnforceFlag = process.env.CODER_AGENT_RUN_STORE_ENFORCE;
  delete process.env.CODER_AGENT_RUN_STORE_SHADOW;
  delete process.env.CODER_AGENT_RUN_STORE_ENFORCE;
  resetAgentRunShadowMetricsForTests();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  setupSchema();
  setupRoot();
});

afterEach(() => {
  if (previousFlag === undefined) delete process.env.CODER_AGENT_RUN_STORE_SHADOW;
  else process.env.CODER_AGENT_RUN_STORE_SHADOW = previousFlag;
  if (previousEnforceFlag === undefined) delete process.env.CODER_AGENT_RUN_STORE_ENFORCE;
  else process.env.CODER_AGENT_RUN_STORE_ENFORCE = previousEnforceFlag;
  db.close();
});

describe('AgentRun recorder shadow', () => {
  it('is default-off while the legacy subagent row remains authoritative', () => {
    expect(createAgentRunRecorder({ db })).toBeNull();

    start(db, startInput());

    expect(db.prepare(`
      SELECT run_id, status FROM coder_subagent_runs WHERE run_id = ?
    `).get(CHILD_RUNNER_ID)).toEqual({ run_id: CHILD_RUNNER_ID, status: 'running' });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM agent_runs WHERE parent_agent_run_id IS NOT NULL
    `).get()).toEqual({ count: 0 });
    expect(snapshotAgentRunShadowMetrics()).toEqual({
      childRunsCreated: 0,
      childRunsTerminalized: 0,
      writeErrors: 0,
    });
  });

  it('dual-writes a child run + own attempt and terminalizes it without terminalizing the root command', () => {
    process.env.CODER_AGENT_RUN_STORE_SHADOW = '1';

    const fence = start(db, startInput());
    expect(fence).not.toBeNull();
    expect(() => start(db, startInput())).not.toThrow(); // idempotent replay

    const childId = `agent-run:subagent:${CHILD_RUNNER_ID}`;
    const childAttemptId = `agent-run-attempt:subagent:${CHILD_RUNNER_ID}:1`;
    expect(db.prepare(`
      SELECT agent_run_id, command_id, owner_agent_run_id, parent_agent_run_id,
        spawn_depth, role, agent_definition_id, status,
        requested_provider, requested_model, requested_reasoning_effort,
        requested_capability_profile, active_attempt_id, wait_mode,
        effective_provider, effective_model, capability_set_ref,
        environment_id, preset_resolution_ref, policy_snapshot_ref
      FROM agent_runs WHERE agent_run_id = ?
    `).get(childId)).toEqual({
      agent_run_id: childId,
      command_id: COMMAND_ID,
      owner_agent_run_id: ROOT_RUN_ID,
      parent_agent_run_id: ROOT_RUN_ID,
      spawn_depth: 1,
      role: 'subagent',
      agent_definition_id: 'investigator',
      status: 'running',
      requested_provider: 'anthropic',
      requested_model: 'claude-child',
      requested_reasoning_effort: 'high',
      requested_capability_profile: 'investigator',
      active_attempt_id: childAttemptId,
      wait_mode: 'foreground',
      effective_provider: 'anthropic',
      effective_model: 'claude-child',
      capability_set_ref: `checkpoint:agent-run-resolution:${CHILD_RUNNER_ID}#capabilities`,
      environment_id: `environment:agent-run-resolution:${CHILD_RUNNER_ID}`,
      preset_resolution_ref: `checkpoint:agent-run-resolution:${CHILD_RUNNER_ID}#profile`,
      policy_snapshot_ref: `checkpoint:agent-run-resolution:${CHILD_RUNNER_ID}#policyMode`,
    });
    expect(db.prepare(`
      SELECT attempt_id, agent_run_id, status, executor_owner_id,
        fencing_epoch, lease_status, runner_run_id
      FROM agent_run_attempts WHERE attempt_id = ?
    `).get(childAttemptId)).toEqual({
      attempt_id: childAttemptId,
      agent_run_id: childId,
      status: 'running',
      executor_owner_id: 'coder-worker:42',
      fencing_epoch: 1,
      lease_status: 'active',
      runner_run_id: CHILD_RUNNER_ID,
    });
    expect(snapshotAgentRunShadowMetrics()).toEqual({
      childRunsCreated: 1,
      childRunsTerminalized: 0,
      writeErrors: 0,
    });
    const resolutionPayload = JSON.parse((db.prepare(`
      SELECT payload_json FROM coder_orchestration_checkpoints
      WHERE checkpoint_kind='agent_run_resolution' AND scope_id=?
    `).get(CHILD_RUNNER_ID) as { payload_json: string }).payload_json) as Record<string, unknown>;
    expect(resolutionPayload.profile).toBe('investigator');
    expect(resolutionPayload.policyMode).toBe('inherited_permission_gate');

    complete(db, completeInput());
    complete(db, completeInput()); // terminal replay is also idempotent

    expect(db.prepare(`
      SELECT status, reason, completed_at IS NOT NULL AS completed
      FROM coder_subagent_runs WHERE run_id = ?
    `).get(CHILD_RUNNER_ID)).toEqual({ status: 'completed', reason: 'completed', completed: 1 });
    expect(db.prepare(`
      SELECT status, terminal_reason, result_ref, finished_at IS NOT NULL AS finished
      FROM agent_runs WHERE agent_run_id = ?
    `).get(childId)).toEqual({
      status: 'completed',
      terminal_reason: 'completed',
      result_ref: 'output:child',
      finished: 1,
    });
    expect(db.prepare(`
      SELECT status, lease_status, terminal_reason, released_at IS NOT NULL AS released
      FROM agent_run_attempts WHERE attempt_id = ?
    `).get(childAttemptId)).toEqual({
      status: 'terminal',
      lease_status: 'released',
      terminal_reason: 'completed',
      released: 1,
    });
    expect(db.prepare(`
      SELECT status, agent_run_id, completed_at FROM session_commands WHERE command_id = ?
    `).get(COMMAND_ID)).toEqual({ status: 'running', agent_run_id: ROOT_RUN_ID, completed_at: null });
    expect(db.prepare(`
      SELECT status, finished_at FROM agent_runs WHERE agent_run_id = ?
    `).get(ROOT_RUN_ID)).toEqual({ status: 'running', finished_at: null });
    expect(snapshotAgentRunShadowMetrics()).toEqual({
      childRunsCreated: 1,
      childRunsTerminalized: 1,
      writeErrors: 0,
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('fences the child attempt when legacy orphan recovery interrupts its row', () => {
    process.env.CODER_AGENT_RUN_STORE_SHADOW = '1';
    start(db, startInput());

    expect(recoverOrphaned(db, {
      sessionId: LEGACY_SESSION_ID,
      currentWorkerInstanceId: 'replacement-worker',
    })).toBe(1);
    expect(recoverOrphaned(db, {
      sessionId: LEGACY_SESSION_ID,
      currentWorkerInstanceId: 'replacement-worker',
    })).toBe(0);

    const childId = `agent-run:subagent:${CHILD_RUNNER_ID}`;
    const childAttemptId = `agent-run-attempt:subagent:${CHILD_RUNNER_ID}:1`;
    expect(db.prepare(`
      SELECT status, reason FROM coder_subagent_runs WHERE run_id = ?
    `).get(CHILD_RUNNER_ID)).toEqual({ status: 'interrupted', reason: 'worker_restart' });
    expect(db.prepare(`
      SELECT status, terminal_reason FROM agent_runs WHERE agent_run_id = ?
    `).get(childId)).toEqual({ status: 'interrupted', terminal_reason: 'worker_restart' });
    expect(db.prepare(`
      SELECT status, lease_status, terminal_reason FROM agent_run_attempts WHERE attempt_id = ?
    `).get(childAttemptId)).toEqual({
      status: 'terminal',
      lease_status: 'fenced',
      terminal_reason: 'worker_restart',
    });
    expect(db.prepare(`
      SELECT status, agent_run_id, completed_at FROM session_commands WHERE command_id = ?
    `).get(COMMAND_ID)).toEqual({ status: 'running', agent_run_id: ROOT_RUN_ID, completed_at: null });
    expect(db.prepare(`
      SELECT status, finished_at FROM agent_runs WHERE agent_run_id = ?
    `).get(ROOT_RUN_ID)).toEqual({ status: 'running', finished_at: null });
    expect(snapshotAgentRunShadowMetrics()).toEqual({
      childRunsCreated: 1,
      childRunsTerminalized: 1,
      writeErrors: 0,
    });
  });

  it('persists background wait mode and rejects a stale terminal writer before legacy mutation', () => {
    process.env.CODER_AGENT_RUN_STORE_ENFORCE = '1';
    const fence = start(db, startInput({
      wait_mode: 'background',
      parent_agent_run_id: ROOT_RUN_ID,
    }));
    expect(fence).not.toBeNull();
    expect(db.prepare(`
      SELECT wait_mode FROM agent_runs WHERE agent_run_id=?
    `).get(`agent-run:subagent:${CHILD_RUNNER_ID}`)).toEqual({ wait_mode: 'background' });

    expect(recoverOrphaned(db, {
      sessionId: LEGACY_SESSION_ID,
      currentWorkerInstanceId: 'replacement-worker',
    })).toBe(1);
    expect(() => complete(db, completeInput({ fence: fence! }))).toThrow(/lease|context|terminal/i);
    expect(db.prepare(`
      SELECT status, reason FROM coder_subagent_runs WHERE run_id=?
    `).get(CHILD_RUNNER_ID)).toEqual({ status: 'interrupted', reason: 'worker_restart' });
  });

  it('audits a stale shadow fence but keeps the legacy execution fail-open', () => {
    process.env.CODER_AGENT_RUN_STORE_SHADOW = '1';
    const fence = start(db, startInput());
    expect(fence).not.toBeNull();
    expect(recoverOrphaned(db, {
      sessionId: LEGACY_SESSION_ID,
      currentWorkerInstanceId: 'replacement-worker',
    })).toBe(1);

    expect(() => complete(db, completeInput({ fence: fence! }))).not.toThrow();
    expect(db.prepare(`
      SELECT status, reason FROM coder_subagent_runs WHERE run_id=?
    `).get(CHILD_RUNNER_ID)).toEqual({ status: 'completed', reason: 'completed' });
    expect(db.prepare(`
      SELECT status, terminal_reason FROM agent_runs WHERE agent_run_id=?
    `).get(`agent-run:subagent:${CHILD_RUNNER_ID}`)).toEqual({
      status: 'interrupted',
      terminal_reason: 'worker_restart',
    });
    expect(snapshotAgentRunShadowMetrics().writeErrors).toBeGreaterThan(0);
  });

  it('contains a shadow write error after the legacy write and records a metadata-only divergence', () => {
    process.env.CODER_AGENT_RUN_STORE_SHADOW = '1';

    expect(() => start(db, startInput({ parent_run_id: 'missing-parent-run' }))).not.toThrow();

    expect(db.prepare(`
      SELECT run_id, parent_run_id, status FROM coder_subagent_runs WHERE run_id = ?
    `).get(CHILD_RUNNER_ID)).toEqual({
      run_id: CHILD_RUNNER_ID,
      parent_run_id: 'missing-parent-run',
      status: 'running',
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM agent_runs WHERE parent_agent_run_id IS NOT NULL
    `).get()).toEqual({ count: 0 });
    const divergence = db.prepare(`
      SELECT kind, legacy_state_json, control_plane_state_json, detail
      FROM control_plane_divergences
      WHERE kind = 'agent_run_shadow_write_error'
    `).get() as {
      kind: string;
      legacy_state_json: string;
      control_plane_state_json: string;
      detail: string;
    };
    expect(divergence.kind).toBe('agent_run_shadow_write_error');
    expect(JSON.parse(divergence.legacy_state_json)).toEqual({
      runId: CHILD_RUNNER_ID,
      parentRunnerRunId: 'missing-parent-run',
    });
    expect(JSON.parse(divergence.control_plane_state_json)).toEqual({
      operation: 'spawn',
      state: 'write_error',
    });
    expect(divergence.detail).toContain('parent AgentRun not found');
    expect(snapshotAgentRunShadowMetrics()).toEqual({
      childRunsCreated: 0,
      childRunsTerminalized: 0,
      writeErrors: 1,
    });
  });

  it('links an immediate child by opaque parent AgentRun id before runner_run_id is mirrored', () => {
    process.env.CODER_AGENT_RUN_STORE_SHADOW = '1';
    db.prepare(`
      UPDATE agent_run_attempts SET runner_run_id=NULL WHERE attempt_id=?
    `).run(ROOT_ATTEMPT_ID);

    const fence = start(db, startInput({
      parent_agent_run_id: ROOT_RUN_ID,
      parent_run_id: 'runner-id-not-mirrored-yet',
    }));

    expect(fence?.agentRunId).toBe(`agent-run:subagent:${CHILD_RUNNER_ID}`);
    expect(db.prepare(`
      SELECT parent_agent_run_id, status
      FROM agent_runs WHERE agent_run_id=?
    `).get(`agent-run:subagent:${CHILD_RUNNER_ID}`)).toEqual({
      parent_agent_run_id: ROOT_RUN_ID,
      status: 'running',
    });
  });

  it('fails closed and rolls back the legacy start when AgentRun enforcement cannot create a fence', () => {
    process.env.CODER_AGENT_RUN_STORE_ENFORCE = '1';

    expect(() => start(db, startInput({
      parent_agent_run_id: 'agent-run:missing-parent',
      parent_run_id: null,
    }))).toThrow(/parent AgentRun .* not found/i);

    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM coder_subagent_runs WHERE run_id=?
    `).get(CHILD_RUNNER_ID)).toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM agent_runs WHERE parent_agent_run_id IS NOT NULL
    `).get()).toEqual({ count: 0 });
  });

  it('treats an empty effective capability set as a complete enforced resolution', () => {
    process.env.CODER_AGENT_RUN_STORE_ENFORCE = '1';

    const fence = start(db, startInput({
      parent_agent_run_id: ROOT_RUN_ID,
      effective_capabilities: [],
    }));

    expect(fence).not.toBeNull();
    expect(db.prepare(`
      SELECT effective_provider, effective_model, capability_set_ref,
        environment_id, preset_resolution_ref, policy_snapshot_ref
      FROM agent_runs WHERE agent_run_id=?
    `).get(`agent-run:subagent:${CHILD_RUNNER_ID}`)).toEqual({
      effective_provider: 'anthropic',
      effective_model: 'claude-child',
      capability_set_ref: `checkpoint:agent-run-resolution:${CHILD_RUNNER_ID}#capabilities`,
      environment_id: `environment:agent-run-resolution:${CHILD_RUNNER_ID}`,
      preset_resolution_ref: `checkpoint:agent-run-resolution:${CHILD_RUNNER_ID}#profile`,
      policy_snapshot_ref: `checkpoint:agent-run-resolution:${CHILD_RUNNER_ID}#policyMode`,
    });
    const checkpoint = db.prepare(`
      SELECT payload_json FROM coder_orchestration_checkpoints
      WHERE checkpoint_kind='agent_run_resolution' AND scope_id=?
    `).get(CHILD_RUNNER_ID) as { payload_json: string };
    expect(JSON.parse(checkpoint.payload_json).capabilities).toEqual([]);
  });

  it('never shortens a long child lease on heartbeat', () => {
    process.env.CODER_AGENT_RUN_STORE_SHADOW = '1';
    const fence = start(db, startInput({ timeout_ms: 2 * 60 * 60_000 }));
    const attemptId = `agent-run-attempt:subagent:${CHILD_RUNNER_ID}:1`;
    const before = db.prepare(`
      SELECT expires_at FROM agent_run_attempts WHERE attempt_id=?
    `).get(attemptId) as { expires_at: string };

    heartbeat(db, CHILD_RUNNER_ID, fence!);

    const after = db.prepare(`
      SELECT expires_at FROM agent_run_attempts WHERE attempt_id=?
    `).get(attemptId) as { expires_at: string };
    expect(after.expires_at).toBe(before.expires_at);
  });

  it('rolls back the legacy terminal row when enforced AgentRun terminalization fails', () => {
    process.env.CODER_AGENT_RUN_STORE_ENFORCE = '1';
    const fence = start(db, startInput({ parent_agent_run_id: ROOT_RUN_ID }));
    const childId = `agent-run:subagent:${CHILD_RUNNER_ID}`;
    db.exec(`
      CREATE TRIGGER force_child_terminal_failure
      BEFORE UPDATE OF status ON agent_runs
      WHEN OLD.agent_run_id='${childId}' AND NEW.status='completed'
      BEGIN
        SELECT RAISE(ABORT, 'forced child terminal failure');
      END;
    `);

    expect(() => complete(db, completeInput({ fence: fence! })))
      .toThrow(/forced child terminal failure/);
    expect(db.prepare(`
      SELECT status, reason, completed_at FROM coder_subagent_runs WHERE run_id=?
    `).get(CHILD_RUNNER_ID)).toEqual({
      status: 'running',
      reason: null,
      completed_at: null,
    });
    expect(db.prepare(`
      SELECT status FROM agent_runs WHERE agent_run_id=?
    `).get(childId)).toEqual({ status: 'running' });
    expect(db.prepare(`
      SELECT status, lease_status FROM agent_run_attempts WHERE agent_run_id=?
    `).get(childId)).toEqual({ status: 'running', lease_status: 'active' });
  });

  it('rolls back legacy orphan recovery when enforced AgentRun interruption fails', () => {
    process.env.CODER_AGENT_RUN_STORE_ENFORCE = '1';
    start(db, startInput({ parent_agent_run_id: ROOT_RUN_ID }));
    const childId = `agent-run:subagent:${CHILD_RUNNER_ID}`;
    db.exec(`
      CREATE TRIGGER force_child_interrupt_failure
      BEFORE UPDATE OF status ON agent_runs
      WHEN OLD.agent_run_id='${childId}' AND NEW.status='interrupted'
      BEGIN
        SELECT RAISE(ABORT, 'forced child interrupt failure');
      END;
    `);

    expect(() => recoverOrphaned(db, {
      sessionId: LEGACY_SESSION_ID,
      currentWorkerInstanceId: 'replacement-worker',
    })).toThrow(/forced child interrupt failure/);
    expect(db.prepare(`
      SELECT status, reason, completed_at FROM coder_subagent_runs WHERE run_id=?
    `).get(CHILD_RUNNER_ID)).toEqual({
      status: 'running',
      reason: null,
      completed_at: null,
    });
    expect(db.prepare(`
      SELECT status FROM agent_runs WHERE agent_run_id=?
    `).get(childId)).toEqual({ status: 'running' });
  });

  it('terminalizes an already-issued child fence after rollout flags are toggled off', () => {
    process.env.CODER_AGENT_RUN_STORE_SHADOW = '1';
    const fence = start(db, startInput());
    expect(fence).not.toBeNull();
    delete process.env.CODER_AGENT_RUN_STORE_SHADOW;
    delete process.env.CODER_AGENT_RUN_STORE_ENFORCE;

    complete(db, completeInput({ fence: fence! }));

    expect(db.prepare(`
      SELECT status, reason FROM coder_subagent_runs WHERE run_id=?
    `).get(CHILD_RUNNER_ID)).toEqual({ status: 'completed', reason: 'completed' });
    expect(db.prepare(`
      SELECT status, terminal_reason FROM agent_runs WHERE agent_run_id=?
    `).get(`agent-run:subagent:${CHILD_RUNNER_ID}`)).toEqual({
      status: 'completed',
      terminal_reason: 'completed',
    });
    expect(db.prepare(`
      SELECT status, lease_status FROM agent_run_attempts WHERE agent_run_id=?
    `).get(`agent-run:subagent:${CHILD_RUNNER_ID}`)).toEqual({
      status: 'terminal',
      lease_status: 'released',
    });
  });

  it('fails closed and rolls back when the enforced resolution checkpoint is unavailable', () => {
    process.env.CODER_AGENT_RUN_STORE_ENFORCE = '1';
    db.exec('DROP TABLE coder_orchestration_checkpoints');

    expect(() => start(db, startInput({
      parent_agent_run_id: ROOT_RUN_ID,
    }))).toThrow(/resolution checkpoint/i);

    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM coder_subagent_runs WHERE run_id=?
    `).get(CHILD_RUNNER_ID)).toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM agent_runs WHERE parent_agent_run_id IS NOT NULL
    `).get()).toEqual({ count: 0 });
  });

  it('fails closed before execution when enforced effective resolution fields are incomplete', () => {
    process.env.CODER_AGENT_RUN_STORE_ENFORCE = '1';

    expect(() => start(db, startInput({
      parent_agent_run_id: ROOT_RUN_ID,
      effective_model: null,
    }))).toThrow(/complete effective resolution metadata/i);

    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM coder_subagent_runs WHERE run_id=?
    `).get(CHILD_RUNNER_ID)).toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM agent_runs WHERE parent_agent_run_id IS NOT NULL
    `).get()).toEqual({ count: 0 });
  });
});
