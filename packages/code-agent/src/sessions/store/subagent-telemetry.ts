import type { Database as DB } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  agentRunStoreEnabled,
  agentRunStoreEnforceEnabled,
  createAgentRunRecorder,
} from '@mcp/code-agent/core/agent-run-recorder.js';
import type { AgentRunWaitMode } from '@mcp/agent-runtime-contracts';
import type { ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';

const WORKER_INSTANCE_ID = `${process.pid}:${randomUUID()}`;

export function currentSubagentWorkerInstanceId(): string {
  return WORKER_INSTANCE_ID;
}

/** Additive persisted contract; older rows naturally expose null/default fields. */
export interface SubagentRunTelemetry {
  id: number;
  session_id: number | null;
  run_id: string;
  parent_run_id: string | null;
  spawn_id: string | null;
  profile: string;
  label: string | null;
  task_preview: string | null;
  max_turns: number;
  max_tool_calls: number | null;
  timeout_ms: number | null;
  stall_ms: number | null;
  research_depth: string | null;
  soft_tool_target: number | null;
  soft_time_target_ms: number | null;
  synthesis_nudged: 0 | 1;
  reason: string | null;
  turns: number;
  auto_continues: number;
  tool_calls: number;
  logical_operations: number;
  productive_operations: number;
  paginate_calls: number;
  duplicate_calls: number;
  error_calls: number;
  refused_calls: number;
  elapsed_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  has_summary: 0 | 1;
  output_id: string | null;
  started_at: string;
  completed_at: string | null;
  status: 'running' | 'completed' | 'interrupted';
  heartbeat_at: string | null;
  worker_instance_id: string | null;
}

export interface SubagentToolCallTelemetry {
  id: number;
  session_id: number | null;
  run_id: string;
  seq: number;
  turn: number | null;
  tool_name: string;
  logical_operation_id: string | null;
  productive: 0 | 1;
  is_error: 0 | 1;
  refusal_kind: string | null;
  duration_ms: number;
  result_chars: number;
  created_at: string;
}

export interface WorkflowStepRunReconciliation {
  outcome: 'terminal' | 'outcome_unknown';
  runId?: string;
  /** Workflow-facing terminal classification. */
  stepStatus?: 'completed' | 'partial' | 'failed';
  reason?: string;
  resultRef?: string;
  hasSummary?: boolean;
  detail: string;
}

interface WorkflowStepRunRow {
  run_id: string;
  legacy_status: string;
  legacy_reason: string | null;
  completed_at: string | null;
  output_id: string | null;
  has_summary: number;
  agent_status: string | null;
  agent_terminal_reason: string | null;
  agent_result_ref: string | null;
}

const AGENT_RUN_TERMINAL = new Set(['completed', 'failed', 'aborted', 'interrupted']);
const PARTIAL_REASONS = new Set(['max_turns', 'tool_budget', 'time_budget']);

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
  ).get(table);
}

function workflowStepStatus(reason: string): 'completed' | 'partial' | 'failed' {
  if (reason === 'completed') return 'completed';
  if (PARTIAL_REASONS.has(reason)) return 'partial';
  return 'failed';
}

/**
 * Reconcile one persisted `running` workflow step by its idempotency identity:
 * workflow wave `spawn_id` + stable step `label`. A terminal child is adopted;
 * an absent, live, divergent or duplicate row is explicitly outcome-unknown.
 *
 * In ENFORCE both the legacy lifecycle row and AgentRun must be terminal. In
 * SHADOW/default-off the legacy row remains the read authority, preserving the
 * rollout contract while still preventing blind replay after a completed ACK.
 */
export function reconcileWorkflowStepRun(
  db: DB,
  sessionId: number,
  groupId: string,
  stepId: string,
): WorkflowStepRunReconciliation {
  if (!tableExists(db, 'coder_subagent_runs')) {
    return {
      outcome: 'outcome_unknown',
      detail: 'subagent lifecycle table is unavailable',
    };
  }
  const hasAgentRuns = tableExists(db, 'agent_runs');
  const rows = db.prepare(`
    SELECT
      sr.run_id,
      sr.status AS legacy_status,
      sr.reason AS legacy_reason,
      sr.completed_at,
      sr.output_id,
      sr.has_summary,
      ${hasAgentRuns ? 'ar.status' : 'NULL'} AS agent_status,
      ${hasAgentRuns ? 'ar.terminal_reason' : 'NULL'} AS agent_terminal_reason,
      ${hasAgentRuns ? 'ar.result_ref' : 'NULL'} AS agent_result_ref
    FROM coder_subagent_runs sr
    ${hasAgentRuns
      ? "LEFT JOIN agent_runs ar ON ar.agent_run_id = 'agent-run:subagent:' || sr.run_id"
      : ''}
    WHERE sr.session_id = ? AND sr.spawn_id = ? AND sr.label = ?
    ORDER BY sr.id DESC
    LIMIT 2
  `).all(sessionId, groupId, stepId) as WorkflowStepRunRow[];

  if (rows.length === 0) {
    return {
      outcome: 'outcome_unknown',
      detail: `no child lifecycle row matches group '${groupId}' step '${stepId}'`,
    };
  }
  if (rows.length !== 1) {
    return {
      outcome: 'outcome_unknown',
      detail: `multiple child lifecycle rows match group '${groupId}' step '${stepId}'`,
    };
  }

  const row = rows[0];
  const legacyTerminal = row.completed_at !== null
    && (row.legacy_status === 'completed' || row.legacy_status === 'interrupted')
    && !!row.legacy_reason;
  const agentTerminal = !!row.agent_status && AGENT_RUN_TERMINAL.has(row.agent_status);

  if (!legacyTerminal) {
    return {
      outcome: 'outcome_unknown',
      runId: row.run_id,
      detail: `child '${row.run_id}' has no durable terminal acknowledgement`,
    };
  }
  if (agentRunStoreEnforceEnabled() && !agentTerminal) {
    return {
      outcome: 'outcome_unknown',
      runId: row.run_id,
      detail: `child '${row.run_id}' AgentRun is not terminal under enforcement`,
    };
  }
  if (agentRunStoreEnforceEnabled()
    && row.agent_terminal_reason !== row.legacy_reason) {
    return {
      outcome: 'outcome_unknown',
      runId: row.run_id,
      detail: `child '${row.run_id}' terminal projections disagree`,
    };
  }

  const reason = row.legacy_reason!;
  return {
    outcome: 'terminal',
    runId: row.run_id,
    stepStatus: workflowStepStatus(reason),
    reason,
    resultRef: row.agent_result_ref ?? row.output_id ?? undefined,
    hasSummary: row.has_summary === 1,
    detail: agentTerminal
      ? `reconciled terminal AgentRun ${row.agent_status}/${reason}`
      : `reconciled terminal subagent lifecycle ${row.legacy_status}/${reason}`,
  };
}

export interface StartSubagentRunInput {
  session_id: number | null;
  run_id: string;
  parent_run_id?: string | null;
  /** Opaque control-plane identity; avoids waiting for runner_run_id mirroring. */
  parent_agent_run_id?: string | null;
  spawn_id?: string | null;
  profile: string;
  label?: string | null;
  task_preview?: string | null;
  requested_provider?: string | null;
  requested_model?: string | null;
  requested_reasoning_effort?: string | null;
  wait_mode?: AgentRunWaitMode;
  effective_provider?: string | null;
  effective_model?: string | null;
  effective_reasoning_effort?: string | null;
  /** Metadata-only resolution evidence; never prompt/tool input. */
  effective_capabilities?: string[];
  environment_fingerprint?: string | null;
  policy_mode?: string | null;
  max_turns: number;
  max_tool_calls?: number | null;
  timeout_ms?: number | null;
  stall_ms?: number | null;
  research_depth?: string | null;
  soft_tool_target?: number | null;
  soft_time_target_ms?: number | null;
}

export interface SubagentToolCallInput {
  session_id: number | null;
  run_id: string;
  seq: number;
  turn?: number | null;
  tool_name: string;
  logical_operation_id?: string | null;
  productive?: boolean;
  is_error: boolean;
  refusal_kind?: string | null;
  duration_ms: number;
  result_chars: number;
  fence?: SubagentRunFence;
}

export interface CompleteSubagentRunInput {
  run_id: string;
  reason: string;
  turns: number;
  auto_continues: number;
  tool_calls: number;
  logical_operations: number;
  productive_operations: number;
  paginate_calls: number;
  duplicate_calls: number;
  error_calls: number;
  refused_calls: number;
  elapsed_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  has_summary: boolean;
  output_id?: string | null;
  synthesis_nudged?: boolean;
  fence?: SubagentRunFence;
}

export type SubagentRunFence = ControlPlaneRunContext;

export function start(db: DB, input: StartSubagentRunInput): SubagentRunFence | null {
  // A session has one owning coder worker. A new worker instance starting a
  // child means incomplete rows from a different instance are crash orphans.
  if (input.session_id != null) {
    recoverOrphaned(db, {
      sessionId: input.session_id,
      currentWorkerInstanceId: WORKER_INSTANCE_ID,
    });
  }
  const writeLegacy = (): void => {
    db.prepare(`
      INSERT INTO coder_subagent_runs (
        session_id, run_id, parent_run_id, spawn_id, profile, label, task_preview,
        max_turns, max_tool_calls, timeout_ms, stall_ms, research_depth,
        soft_tool_target, soft_time_target_ms, status, heartbeat_at, worker_instance_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', datetime('now'), ?)
      ON CONFLICT(run_id) DO UPDATE SET
        parent_run_id=excluded.parent_run_id, profile=excluded.profile,
        label=excluded.label, task_preview=excluded.task_preview,
        research_depth=excluded.research_depth,
        soft_tool_target=excluded.soft_tool_target,
        soft_time_target_ms=excluded.soft_time_target_ms,
        status='running', heartbeat_at=datetime('now'),
        worker_instance_id=excluded.worker_instance_id, completed_at=NULL
    `).run(
      input.session_id, input.run_id, input.parent_run_id ?? null,
      input.spawn_id ?? null, input.profile, input.label ?? null,
      input.task_preview?.slice(0, 1000) ?? null, input.max_turns,
      input.max_tool_calls ?? null, input.timeout_ms ?? null, input.stall_ms ?? null,
      input.research_depth ?? null, input.soft_tool_target ?? null,
      input.soft_time_target_ms ?? null, WORKER_INSTANCE_ID,
    );
  };

  // Dual-write order is deliberate: coder_subagent_runs remains the read
  // authority during the shadow. A shadow failure can never suppress or roll
  // back the legacy row that callers already depend on.
  const writeAgentRun = (): SubagentRunFence | null =>
    createAgentRunRecorder({ db })?.recordChildSpawn({
      legacySessionId: input.session_id,
      runId: input.run_id,
      parentAgentRunId: input.parent_agent_run_id,
      parentRunnerRunId: input.parent_run_id,
      profile: input.profile,
      requestedProvider: input.requested_provider ?? undefined,
      requestedModel: input.requested_model ?? undefined,
      requestedReasoningEffort: input.requested_reasoning_effort ?? undefined,
      waitMode: input.wait_mode ?? 'foreground',
      effectiveProvider: input.effective_provider ?? undefined,
      effectiveModel: input.effective_model ?? undefined,
      effectiveReasoningEffort: input.effective_reasoning_effort ?? undefined,
      effectiveCapabilities: input.effective_capabilities,
      environmentFingerprint: input.environment_fingerprint ?? undefined,
      policyMode: input.policy_mode ?? undefined,
      timeoutMs: input.timeout_ms,
    }) ?? null;

  if (agentRunStoreEnforceEnabled()) {
    return db.transaction(() => {
      writeLegacy();
      const fence = writeAgentRun();
      if (!fence) throw new Error('AgentRun enforcement could not create a child fence');
      return fence;
    })();
  }
  writeLegacy();
  return writeAgentRun();
}

/** Fail closed only when a shadow fence token was successfully created. */
export function assertFence(db: DB, fence: SubagentRunFence): void {
  const forceExistingFence = !agentRunStoreEnabled();
  const recorder = createAgentRunRecorder({ db, forceExistingFence });
  if (!recorder) {
    if (agentRunStoreEnforceEnabled() || forceExistingFence) {
      throw new Error('AgentRun fence exists but the recorder is unavailable');
    }
    return;
  }
  recorder.assertChildFence(fence);
}

export function heartbeat(db: DB, runId: string, fence?: SubagentRunFence): void {
  if (fence) assertFence(db, fence);
  db.prepare(`
    UPDATE coder_subagent_runs
    SET heartbeat_at=datetime('now')
    WHERE run_id=? AND status='running' AND completed_at IS NULL
  `).run(runId);
  createAgentRunRecorder({
    db,
    forceExistingFence: !!fence && !agentRunStoreEnabled(),
  })?.recordChildHeartbeat(runId, fence);
}

export function recordToolCall(db: DB, input: SubagentToolCallInput): void {
  if (input.fence) assertFence(db, input.fence);
  db.prepare(`
    INSERT OR IGNORE INTO coder_subagent_tool_calls (
      session_id, run_id, seq, turn, tool_name, logical_operation_id,
      productive, is_error, refusal_kind, duration_ms, result_chars
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.session_id, input.run_id, input.seq, input.turn ?? null,
    input.tool_name, input.logical_operation_id ?? null, input.productive ? 1 : 0,
    input.is_error ? 1 : 0, input.refusal_kind ?? null,
    input.duration_ms, input.result_chars,
  );
  heartbeat(db, input.run_id, input.fence);
}

export function complete(db: DB, input: CompleteSubagentRunInput): void {
  const forceExistingFence = !!input.fence && !agentRunStoreEnabled();
  const write = (): void => {
    if (input.fence) assertFence(db, input.fence);
    db.prepare(`
      UPDATE coder_subagent_runs SET
        reason=?, turns=?, auto_continues=?, tool_calls=?, logical_operations=?,
        productive_operations=?, paginate_calls=?, duplicate_calls=?, error_calls=?,
        refused_calls=?, elapsed_ms=?, input_tokens=?, output_tokens=?,
        cache_read_input_tokens=?, cache_creation_input_tokens=?, has_summary=?,
        output_id=?, synthesis_nudged=?, status='completed',
        heartbeat_at=datetime('now'), completed_at=datetime('now')
      WHERE run_id=?
    `).run(
      input.reason, input.turns, input.auto_continues, input.tool_calls,
      input.logical_operations, input.productive_operations, input.paginate_calls,
      input.duplicate_calls, input.error_calls, input.refused_calls, input.elapsed_ms,
      input.input_tokens, input.output_tokens, input.cache_read_input_tokens ?? 0,
      input.cache_creation_input_tokens ?? 0, input.has_summary ? 1 : 0,
      input.output_id ?? null, input.synthesis_nudged ? 1 : 0, input.run_id,
    );
    const recorder = createAgentRunRecorder({ db, forceExistingFence });
    if ((agentRunStoreEnforceEnabled() || forceExistingFence) && !recorder) {
      throw new Error('AgentRun enforcement recorder unavailable at child terminal');
    }
    recorder?.recordChildTerminal({
      runId: input.run_id,
      reason: input.reason,
      resultRef: input.output_id ?? null,
      fence: input.fence,
    });
  };
  if (agentRunStoreEnforceEnabled() || forceExistingFence) db.transaction(write)();
  else write();
}

export interface RecoverOrphanedSubagentRunsOptions {
  sessionId?: number;
  /** When set, preserve incomplete rows owned by this live worker instance. */
  currentWorkerInstanceId?: string;
}

/**
 * Mark incomplete rows left by a dead/replaced worker as terminal. Idempotent;
 * completed rows and rows owned by the current worker are never touched.
 */
export function recoverOrphaned(
  db: DB,
  opts: RecoverOrphanedSubagentRunsOptions = {},
): number {
  const table = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='coder_subagent_runs'",
  ).get();
  if (!table) return 0;
  const columns = new Set(
    (db.prepare('PRAGMA table_info(coder_subagent_runs)').all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  if (!columns.has('status') || !columns.has('heartbeat_at') || !columns.has('worker_instance_id')) return 0;

  const where: string[] = ["completed_at IS NULL", "status = 'running'"];
  const params: unknown[] = [];
  if (opts.sessionId != null) {
    where.push('session_id = ?');
    params.push(opts.sessionId);
  }
  if (opts.currentWorkerInstanceId) {
    where.push('(worker_instance_id IS NULL OR worker_instance_id <> ?)');
    params.push(opts.currentWorkerInstanceId);
  }
  const recover = (): number => {
    const orphanRunIds = (db.prepare(`
      SELECT run_id FROM coder_subagent_runs
      WHERE ${where.join(' AND ')}
    `).all(...params) as Array<{ run_id: string }>).map((row) => row.run_id);
    const result = db.prepare(`
      UPDATE coder_subagent_runs
      SET status='interrupted', reason=COALESCE(reason, 'worker_restart'),
          heartbeat_at=datetime('now'), completed_at=datetime('now')
      WHERE ${where.join(' AND ')}
    `).run(...params);

    // Existing pre-shadow rows have no child AgentRun and are intentionally
    // skipped by the recorder. Under enforcement both projections commit or
    // roll back together, matching start()/complete().
    const recorder = createAgentRunRecorder({ db });
    if (agentRunStoreEnforceEnabled() && !recorder) {
      throw new Error('AgentRun enforcement recorder unavailable during orphan recovery');
    }
    for (const runId of orphanRunIds) recorder?.recordChildInterrupted(runId);
    return result.changes;
  };
  return agentRunStoreEnforceEnabled() ? db.transaction(recover)() : recover();
}

export function listRuns(db: DB, sessionId: number, limit = 50): SubagentRunTelemetry[] {
  return db.prepare(`
    SELECT * FROM coder_subagent_runs
    WHERE session_id = ?
    ORDER BY started_at DESC, id DESC
    LIMIT ?
  `).all(sessionId, Math.max(1, Math.min(200, limit))) as SubagentRunTelemetry[];
}

export function listToolCalls(db: DB, runId: string, limit = 100): SubagentToolCallTelemetry[] {
  return db.prepare(`
    SELECT * FROM coder_subagent_tool_calls
    WHERE run_id = ?
    ORDER BY seq DESC
    LIMIT ?
  `).all(runId, Math.max(1, Math.min(500, limit))) as SubagentToolCallTelemetry[];
}
