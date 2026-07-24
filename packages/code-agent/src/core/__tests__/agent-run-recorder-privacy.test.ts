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
import { complete, start } from '../../sessions/store/subagent-telemetry.js';

type DB = InstanceType<typeof DatabaseConstructor>;

const LEGACY_SESSION_ID = 73;
const SESSION_ID = asSessionId('session:coder:73');
const COMMAND_ID = asSessionCommandId('command:coder:privacy-root');
const ROOT_RUN_ID = asAgentRunId('agent-run:coder:privacy-root');
const ROOT_ATTEMPT_ID = asAgentRunAttemptId('agent-run-attempt:coder:privacy-root:1');
const CORRELATION_ID = asCorrelationId('correlation:coder:privacy-root');
const PARENT_RUNNER_ID = 'coder-run:privacy-parent';
const CHILD_RUNNER_ID = 'coder-run:privacy-child';
const SENTINEL = 'RAW_SECRET_PROMPT_TRANSCRIPT_SENTINEL_9a5f17';
const ACTOR = { actorId: 'privacy-user', actorType: 'user' as const, source: 'http' as const };

let db: DB;
let previousFlag: string | undefined;

function setup(): void {
  db.exec(`
    CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY);
    INSERT INTO coder_sessions (id) VALUES (${LEGACY_SESSION_ID});
  `);
  codeAgentOptimizationTelemetry206.up(db);
  subagentResearchPolicy239.up(db);
  subagentRunLifecycle248.up(db);
  controlPlaneFoundation251.up(db);
  controlPlaneAlignment252.up(db);
  agentRunChildCardinality257.up(db);
  coderOrchestrationCheckpoints259.up(db);

  const store = new ControlPlaneStore(db, { journalEnabled: true });
  const payload = { task: 'privacy-root' };
  const accepted = store.acceptCommand({
    command: {
      schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      commandId: COMMAND_ID,
      idempotencyKey: 'idem:privacy-root',
      kind: 'start',
      sessionId: SESSION_ID,
      actor: ACTOR,
      requestedAt: '2026-01-01T00:00:00.000Z',
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
      requestedCapabilityProfile: 'navigate',
      executorOwnerId: 'coder-worker:privacy',
      executorExpiresAt: '2099-01-01T00:00:00.000Z',
    },
  });
  expect(accepted.kind).toBe('accepted');
  store.markRunStarted({
    sessionId: SESSION_ID,
    legacySessionId: LEGACY_SESSION_ID,
    commandId: COMMAND_ID,
    correlationId: CORRELATION_ID,
    actor: ACTOR,
    agentRunId: ROOT_RUN_ID,
    attemptId: ROOT_ATTEMPT_ID,
    executorOwnerId: 'coder-worker:privacy',
    fencingEpoch: 1,
  }, PARENT_RUNNER_ID, '2026-01-01T00:00:01.000Z');
}

function startLegacy(parentRunId = PARENT_RUNNER_ID): void {
  start(db, {
    session_id: LEGACY_SESSION_ID,
    run_id: CHILD_RUNNER_ID,
    parent_run_id: parentRunId,
    spawn_id: 'spawn:privacy-child',
    profile: 'investigator',
    label: `Private task ${SENTINEL}`,
    task_preview: `Never mirror this raw prompt or transcript: ${SENTINEL}`,
    requested_provider: 'anthropic',
    requested_model: 'claude-child',
    requested_reasoning_effort: 'high',
    max_turns: 5,
    max_tool_calls: 10,
    timeout_ms: 30_000,
    stall_ms: 10_000,
  });
}

function completeLegacy(): void {
  complete(db, {
    run_id: CHILD_RUNNER_ID,
    reason: 'completed',
    turns: 2,
    auto_continues: 0,
    tool_calls: 1,
    logical_operations: 1,
    productive_operations: 1,
    paginate_calls: 0,
    duplicate_calls: 0,
    error_calls: 0,
    refused_calls: 0,
    elapsed_ms: 50,
    input_tokens: 10,
    output_tokens: 5,
    has_summary: true,
    output_id: 'output-ref:privacy-child',
  });
}

function serializedControlPlaneRows(): string {
  const runs = db.prepare(`
    SELECT * FROM agent_runs WHERE agent_run_id LIKE 'agent-run:subagent:%'
  `).all();
  const attempts = db.prepare(`
    SELECT a.* FROM agent_run_attempts a
    JOIN agent_runs r ON r.agent_run_id = a.agent_run_id
    WHERE r.agent_run_id LIKE 'agent-run:subagent:%'
  `).all();
  return JSON.stringify({ runs, attempts });
}

beforeEach(() => {
  previousFlag = process.env.CODER_AGENT_RUN_STORE_SHADOW;
  delete process.env.CODER_AGENT_RUN_STORE_SHADOW;
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  setup();
});

afterEach(() => {
  if (previousFlag === undefined) delete process.env.CODER_AGENT_RUN_STORE_SHADOW;
  else process.env.CODER_AGENT_RUN_STORE_SHADOW = previousFlag;
  db.close();
});

describe('AgentRun child dual-write privacy', () => {
  it('keeps only the legacy row when the shadow flag is off', () => {
    startLegacy();

    expect(db.prepare(`
      SELECT task_preview FROM coder_subagent_runs WHERE run_id = ?
    `).get(CHILD_RUNNER_ID)).toEqual({
      task_preview: `Never mirror this raw prompt or transcript: ${SENTINEL}`,
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM agent_runs WHERE parent_agent_run_id IS NOT NULL
    `).get()).toEqual({ count: 0 });
  });

  it('persists legacy + child lifecycle together without copying prompt/transcript content', () => {
    process.env.CODER_AGENT_RUN_STORE_SHADOW = '1';

    startLegacy();
    completeLegacy();

    expect(db.prepare(`
      SELECT run_id, task_preview, status, reason
      FROM coder_subagent_runs WHERE run_id = ?
    `).get(CHILD_RUNNER_ID)).toEqual({
      run_id: CHILD_RUNNER_ID,
      task_preview: `Never mirror this raw prompt or transcript: ${SENTINEL}`,
      status: 'completed',
      reason: 'completed',
    });
    expect(db.prepare(`
      SELECT command_id, parent_agent_run_id, role, status, result_ref
      FROM agent_runs WHERE agent_run_id = ?
    `).get(`agent-run:subagent:${CHILD_RUNNER_ID}`)).toEqual({
      command_id: COMMAND_ID,
      parent_agent_run_id: ROOT_RUN_ID,
      role: 'subagent',
      status: 'completed',
      result_ref: 'output-ref:privacy-child',
    });
    expect(serializedControlPlaneRows()).not.toContain(SENTINEL);
    expect(serializedControlPlaneRows()).not.toContain('Never mirror this raw prompt or transcript');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('contains a shadow error after the legacy write without leaking the prompt sentinel', () => {
    process.env.CODER_AGENT_RUN_STORE_SHADOW = '1';

    expect(() => startLegacy('missing-parent')).not.toThrow();

    expect(db.prepare(`
      SELECT task_preview, status FROM coder_subagent_runs WHERE run_id = ?
    `).get(CHILD_RUNNER_ID)).toEqual({
      task_preview: `Never mirror this raw prompt or transcript: ${SENTINEL}`,
      status: 'running',
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM agent_runs WHERE parent_agent_run_id IS NOT NULL
    `).get()).toEqual({ count: 0 });
    const divergenceJson = JSON.stringify(db.prepare(`
      SELECT legacy_state_json, control_plane_state_json, detail
      FROM control_plane_divergences
      WHERE kind = 'agent_run_shadow_write_error'
    `).all());
    expect(divergenceJson).not.toContain(SENTINEL);
    expect(divergenceJson).not.toContain('Never mirror this raw prompt or transcript');
  });
});
