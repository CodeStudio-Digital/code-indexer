import type DatabaseConstructor from 'better-sqlite3';
import {
  asAgentRunAttemptId,
  asAgentRunId,
  asSessionCommandId,
  asSessionId,
  canTransitionAgentRun,
  type AgentRun,
  type AgentRunAttempt,
  type AgentRunStatus,
  type SessionCommand,
} from '@mcp/agent-runtime-contracts';
import { parseControlPlaneJson } from './codec.js';
import type { AgentRunResolutionPatch, AgentRunSeed, ControlPlaneRunContext } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

interface RunRow {
  agent_run_id: string;
  spec_version: number;
  session_id: string;
  legacy_session_id: number | null;
  command_id: string;
  owner_agent_run_id: string | null;
  parent_agent_run_id: string | null;
  spawn_depth: number;
  role: string;
  status: AgentRunStatus;
  effective_provider: string | null;
  effective_model: string | null;
  effective_reasoning_effort: string | null;
  effective_preset: string | null;
  downgrade_reasons_json: string;
  capability_set_ref: string | null;
  environment_id: string | null;
  workspace_lease_id: string | null;
  active_attempt_id: string | null;
  preset_resolution_ref: string | null;
  terminal_reason: string | null;
  transcript_ref: string | null;
  checkpoint_ref: string | null;
  result_ref: string | null;
  policy_snapshot_ref: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  version: number;
}

interface AttemptRow {
  attempt_id: string;
  agent_run_id: string;
  ordinal: number;
  trigger: AgentRunAttempt['trigger'];
  status: AgentRunAttempt['status'];
  executor_owner_id: string;
  fencing_epoch: number;
  lease_status: AgentRunAttempt['executorLease']['status'];
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  released_at: string | null;
  runner_run_id: string | null;
  provider_request_refs_json: string;
  checkpoint_input_ref: string | null;
  terminal_reason: string | null;
  error_ref: string | null;
  started_at: string;
  finished_at: string | null;
  version: number;
}

interface CommandLinkRow {
  session_id: string;
  legacy_session_id: number | null;
  correlation_id: string;
  agent_run_id: string | null;
}

export class AgentRunFenceError extends Error {
  constructor(agentRunId: string, detail: string) {
    super(`AgentRun ${agentRunId} lease/context conflict: ${detail}`);
    this.name = 'AgentRunFenceError';
  }
}

function hydrateRun(row: RunRow): AgentRun {
  return {
    agentRunId: asAgentRunId(row.agent_run_id),
    specVersion: row.spec_version,
    sessionId: asSessionId(row.session_id),
    commandId: asSessionCommandId(row.command_id),
    ownerAgentRunId: row.owner_agent_run_id ? asAgentRunId(row.owner_agent_run_id) : undefined,
    parentAgentRunId: row.parent_agent_run_id ? asAgentRunId(row.parent_agent_run_id) : undefined,
    spawnDepth: row.spawn_depth,
    role: row.role,
    status: row.status,
    effectiveProvider: row.effective_provider ?? undefined,
    effectiveModel: row.effective_model ?? undefined,
    effectiveReasoningEffort: row.effective_reasoning_effort ?? undefined,
    effectivePreset: row.effective_preset ?? undefined,
    downgradeReasons: parseControlPlaneJson(row.downgrade_reasons_json, []),
    capabilitySetRef: row.capability_set_ref ?? undefined,
    environmentId: row.environment_id ? row.environment_id as NonNullable<AgentRun['environmentId']> : undefined,
    workspaceLeaseId: row.workspace_lease_id ? row.workspace_lease_id as NonNullable<AgentRun['workspaceLeaseId']> : undefined,
    activeAttemptId: row.active_attempt_id ? asAgentRunAttemptId(row.active_attempt_id) : undefined,
    presetResolutionRef: row.preset_resolution_ref ?? undefined,
    terminalReason: row.terminal_reason ?? undefined,
    transcriptRef: row.transcript_ref ?? undefined,
    checkpointRef: row.checkpoint_ref ?? undefined,
    resultRef: row.result_ref ?? undefined,
    policySnapshotRef: row.policy_snapshot_ref ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    version: row.version,
  };
}

function hydrateAttempt(row: AttemptRow): AgentRunAttempt {
  return {
    attemptId: asAgentRunAttemptId(row.attempt_id),
    agentRunId: asAgentRunId(row.agent_run_id),
    ordinal: row.ordinal,
    trigger: row.trigger,
    executorLease: {
      ownerId: row.executor_owner_id,
      fencingEpoch: row.fencing_epoch,
      status: row.lease_status,
      acquiredAt: row.acquired_at,
      heartbeatAt: row.heartbeat_at,
      expiresAt: row.expires_at,
      releasedAt: row.released_at ?? undefined,
    },
    status: row.status,
    runnerRunId: row.runner_run_id ?? undefined,
    providerRequestRefs: parseControlPlaneJson(row.provider_request_refs_json, []),
    checkpointInputRef: row.checkpoint_input_ref ?? undefined,
    terminalReason: row.terminal_reason ?? undefined,
    errorRef: row.error_ref ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    version: row.version,
  };
}

function isTerminalStatus(status: AgentRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'aborted' || status === 'interrupted';
}

function hasExpired(expiresAt: string, at: string): boolean {
  const expires = Date.parse(expiresAt);
  const now = Date.parse(at);
  return Number.isFinite(expires) && Number.isFinite(now) ? expires <= now : expiresAt <= at;
}

export class AgentRunStore {
  constructor(private readonly db: DB) {}

  get(agentRunId: string): AgentRun | null {
    const row = this.db.prepare('SELECT * FROM agent_runs WHERE agent_run_id = ?').get(agentRunId) as RunRow | undefined;
    return row ? hydrateRun(row) : null;
  }

  getByCommand(commandId: string): AgentRun | null {
    const row = this.db.prepare(`
      SELECT * FROM agent_runs
      WHERE command_id = ? AND parent_agent_run_id IS NULL
    `).get(commandId) as RunRow | undefined;
    return row ? hydrateRun(row) : null;
  }

  getAttempt(attemptId: string): AgentRunAttempt | null {
    const row = this.db.prepare('SELECT * FROM agent_run_attempts WHERE attempt_id = ?').get(attemptId) as AttemptRow | undefined;
    return row ? hydrateAttempt(row) : null;
  }

  listActiveAttempts(limit = 100): AgentRunAttempt[] {
    const safeLimit = Math.max(1, Math.min(10_000, Math.floor(limit)));
    return (this.db.prepare(`
      SELECT * FROM agent_run_attempts
      WHERE status IN ('starting', 'running') AND lease_status = 'active'
      ORDER BY started_at ASC LIMIT ?
    `).all(safeLimit) as AttemptRow[]).map(hydrateAttempt);
  }

  listExpiredActiveAttempts(expiresAt: string, limit = 100): AgentRunAttempt[] {
    const safeLimit = Math.max(1, Math.min(10_000, Math.floor(limit)));
    return (this.db.prepare(`
      SELECT * FROM agent_run_attempts
      WHERE status IN ('starting', 'running')
        AND lease_status = 'active'
        AND expires_at <= ?
      ORDER BY expires_at ASC LIMIT ?
    `).all(expiresAt, safeLimit) as AttemptRow[]).map(hydrateAttempt);
  }

  create<T>(command: Pick<SessionCommand<T>, 'sessionId' | 'commandId'>, legacySessionId: number | undefined, seed: AgentRunSeed): AgentRun {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_runs (
        agent_run_id, spec_version, session_id, legacy_session_id, command_id,
        owner_agent_run_id, parent_agent_run_id, spawn_depth,
        role, agent_definition_id, status, wait_mode,
        requested_provider, requested_model, requested_reasoning_effort, requested_preset,
        requested_capability_profile,
        effective_provider, effective_model, effective_reasoning_effort, effective_preset,
        capability_set_ref, environment_id, preset_resolution_ref, policy_snapshot_ref,
        downgrade_reasons_json, active_attempt_id,
        created_at, updated_at, version
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      seed.agentRunId, command.sessionId, legacySessionId ?? null, command.commandId,
      seed.ownerAgentRunId ?? null, seed.parentAgentRunId ?? null, seed.spawnDepth ?? 0,
      seed.role, seed.agentDefinitionId, seed.waitMode,
      seed.requestedProvider ?? null, seed.requestedModel ?? null,
      seed.requestedReasoningEffort ?? null, seed.requestedPreset ?? null,
      seed.requestedCapabilityProfile,
      seed.effectiveProvider ?? null, seed.effectiveModel ?? null,
      seed.effectiveReasoningEffort ?? null, seed.effectivePreset ?? null,
      seed.capabilitySetRef ?? null, seed.environmentId ?? null,
      seed.presetResolutionRef ?? null, seed.policySnapshotRef ?? null,
      seed.downgradeReasons ? JSON.stringify(seed.downgradeReasons) : '[]',
      seed.attemptId, now, now,
    );
    return this.get(seed.agentRunId)!;
  }

  createInitialAttempt(agentRunId: string, seed: AgentRunSeed): AgentRunAttempt {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_run_attempts (
        attempt_id, agent_run_id, ordinal, trigger, status,
        executor_owner_id, fencing_epoch, lease_status,
        acquired_at, heartbeat_at, expires_at, started_at, version
      ) VALUES (?, ?, 1, 'initial', 'starting', ?, 1, 'active', ?, ?, ?, ?, 1)
    `).run(seed.attemptId, agentRunId, seed.executorOwnerId, now, now, seed.executorExpiresAt, now);
    return this.getAttempt(seed.attemptId)!;
  }

  assertContext(
    context: ControlPlaneRunContext,
    options: { requireActiveLease?: boolean; at?: string } = {},
  ): { run: AgentRun; attempt: AgentRunAttempt } {
    const runRow = this.db.prepare('SELECT * FROM agent_runs WHERE agent_run_id = ?').get(context.agentRunId) as RunRow | undefined;
    const attemptRow = this.db.prepare('SELECT * FROM agent_run_attempts WHERE attempt_id = ?').get(context.attemptId) as AttemptRow | undefined;
    const commandRow = this.db.prepare(`
      SELECT session_id, legacy_session_id, correlation_id, agent_run_id
      FROM session_commands WHERE command_id = ?
    `).get(context.commandId) as CommandLinkRow | undefined;
    if (!runRow || !attemptRow || !commandRow) throw new AgentRunFenceError(context.agentRunId, 'missing command/run/attempt');
    if (runRow.session_id !== context.sessionId || runRow.command_id !== context.commandId) {
      throw new AgentRunFenceError(context.agentRunId, 'run is not linked to context session/command');
    }
    if (runRow.active_attempt_id !== context.attemptId || attemptRow.agent_run_id !== context.agentRunId) {
      throw new AgentRunFenceError(context.agentRunId, 'attempt is not the active attempt for this run');
    }
    if (commandRow.session_id !== context.sessionId) {
      throw new AgentRunFenceError(context.agentRunId, 'command is not linked to context session');
    }
    // Root runs remain linked directly from session_commands.agent_run_id.
    // Fase-3 child runs intentionally share the root command (D-018), so the
    // command keeps pointing at the root while the child is linked by
    // parent_agent_run_id. The run's own session_id/command_id checks above,
    // plus its exact active attempt + lease token below, still fence the child
    // independently. A root without a direct command link remains invalid.
    const directlyLinkedRoot = commandRow.agent_run_id === context.agentRunId;
    const childOfCommand = commandRow.agent_run_id !== null
      && runRow.parent_agent_run_id !== null
      && (runRow.parent_agent_run_id === commandRow.agent_run_id
        || runRow.owner_agent_run_id === commandRow.agent_run_id);
    if (!directlyLinkedRoot && !childOfCommand) {
      throw new AgentRunFenceError(context.agentRunId, 'command is not linked to context run/root hierarchy');
    }
    if (commandRow.correlation_id !== context.correlationId) {
      throw new AgentRunFenceError(context.agentRunId, 'correlation id mismatch');
    }
    if (context.legacySessionId !== undefined
      && (runRow.legacy_session_id !== context.legacySessionId || commandRow.legacy_session_id !== context.legacySessionId)) {
      throw new AgentRunFenceError(context.agentRunId, 'legacy session mismatch');
    }
    if (attemptRow.executor_owner_id !== context.executorOwnerId || attemptRow.fencing_epoch !== context.fencingEpoch) {
      throw new AgentRunFenceError(context.agentRunId, 'executor lease token mismatch');
    }
    if (options.requireActiveLease !== false) {
      const at = options.at ?? new Date().toISOString();
      if (attemptRow.lease_status !== 'active' || attemptRow.status === 'terminal') {
        throw new AgentRunFenceError(context.agentRunId, `executor lease is ${attemptRow.lease_status}/${attemptRow.status}`);
      }
      if (hasExpired(attemptRow.expires_at, at)) {
        throw new AgentRunFenceError(context.agentRunId, `executor lease expired at ${attemptRow.expires_at}`);
      }
    }
    return { run: hydrateRun(runRow), attempt: hydrateAttempt(attemptRow) };
  }

  transition(
    context: ControlPlaneRunContext,
    to: AgentRunStatus,
    patch: { terminalReason?: string; transcriptRef?: string; resultRef?: string; errorRef?: string; at?: string } = {},
  ): AgentRun {
    const at = patch.at ?? new Date().toISOString();
    const snapshot = this.assertContext(context, { requireActiveLease: false });
    const current = snapshot.run;
    if (!isTerminalStatus(current.status)) this.assertContext(context, { requireActiveLease: true, at });
    if (!canTransitionAgentRun(current.status, to)) {
      throw new AgentRunFenceError(context.agentRunId, `invalid transition ${current.status} -> ${to}`);
    }
    const terminalReason = patch.terminalReason ?? patch.errorRef;
    if (terminalReason !== undefined && current.terminalReason !== undefined && current.terminalReason !== terminalReason) {
      throw new AgentRunFenceError(context.agentRunId, 'terminal reason differs from persisted value');
    }
    if (patch.transcriptRef !== undefined && current.transcriptRef !== undefined && current.transcriptRef !== patch.transcriptRef) {
      throw new AgentRunFenceError(context.agentRunId, 'transcript ref differs from persisted value');
    }
    if (patch.resultRef !== undefined && current.resultRef !== undefined && current.resultRef !== patch.resultRef) {
      throw new AgentRunFenceError(context.agentRunId, 'result ref differs from persisted value');
    }
    const needsUpdate = current.status !== to
      || (terminalReason !== undefined && current.terminalReason === undefined)
      || (patch.transcriptRef !== undefined && current.transcriptRef === undefined)
      || (patch.resultRef !== undefined && current.resultRef === undefined);
    if (!needsUpdate) return current;

    const terminal = isTerminalStatus(to);
    const result = this.db.prepare(`
      UPDATE agent_runs SET
        status = ?, terminal_reason = COALESCE(terminal_reason, ?),
        transcript_ref = COALESCE(transcript_ref, ?), result_ref = COALESCE(result_ref, ?),
        started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
        finished_at = CASE WHEN ? THEN COALESCE(finished_at, ?) ELSE finished_at END,
        updated_at = ?, version = version + 1
      WHERE agent_run_id = ? AND version = ? AND active_attempt_id = ?
        AND EXISTS (
          SELECT 1 FROM agent_run_attempts a
          WHERE a.attempt_id = ? AND a.agent_run_id = agent_runs.agent_run_id
            AND a.executor_owner_id = ? AND a.fencing_epoch = ?
            AND (
              (agent_runs.status IN ('completed', 'failed', 'aborted', 'interrupted') AND a.status = 'terminal')
              OR (a.lease_status = 'active' AND a.status IN ('starting', 'running'))
            )
        )
    `).run(
      to, terminalReason ?? null, patch.transcriptRef ?? null, patch.resultRef ?? null,
      to, at, terminal ? 1 : 0, at, at, context.agentRunId, current.version, context.attemptId,
      context.attemptId, context.executorOwnerId, context.fencingEpoch,
    );
    if (result.changes !== 1) throw new AgentRunFenceError(context.agentRunId, 'transition changed concurrently or was fenced');
    return this.get(context.agentRunId)!;
  }

  /**
   * Writes the AgentRun resolution (effective provider/model/preset, capability
   * set, environment and policy snapshot) AFTER accept, under an optimistic
   * version compare-and-set. Owner/epoch are always fenced via assertContext;
   * status and the executor lease are left untouched. When `expectedVersion`
   * is supplied and no longer matches the persisted version, the write is a
   * fenced no-op (AgentRunFenceError) so exactly one writer resolves a run.
   */
  markResolved(
    context: ControlPlaneRunContext,
    patch: AgentRunResolutionPatch,
    expectedVersion?: number,
  ): AgentRun {
    const at = patch.at ?? new Date().toISOString();
    const current = this.assertContext(context, { requireActiveLease: false }).run;
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new AgentRunFenceError(
        context.agentRunId,
        `resolution version stale: expected ${expectedVersion}, actual ${current.version}`,
      );
    }
    const result = this.db.prepare(`
      UPDATE agent_runs SET
        effective_provider = ?,
        effective_model = ?,
        effective_reasoning_effort = COALESCE(?, effective_reasoning_effort),
        effective_preset = COALESCE(?, effective_preset),
        capability_set_ref = ?,
        environment_id = ?,
        preset_resolution_ref = ?,
        policy_snapshot_ref = ?,
        downgrade_reasons_json = COALESCE(?, downgrade_reasons_json),
        updated_at = ?, version = version + 1
      WHERE agent_run_id = ? AND version = ?
    `).run(
      patch.effectiveProvider,
      patch.effectiveModel,
      patch.effectiveReasoningEffort ?? null,
      patch.effectivePreset ?? null,
      patch.capabilitySetRef,
      patch.environmentId,
      patch.presetResolutionRef,
      patch.policySnapshotRef,
      patch.downgradeReasons ? JSON.stringify(patch.downgradeReasons) : null,
      at, context.agentRunId, current.version,
    );
    if (result.changes !== 1) {
      throw new AgentRunFenceError(context.agentRunId, 'resolution changed concurrently or was fenced');
    }
    return this.get(context.agentRunId)!;
  }

  markAttemptRunning(
    context: ControlPlaneRunContext,
    runnerRunId?: string,
    at = new Date().toISOString(),
  ): AgentRunAttempt {
    const current = this.assertContext(context, { requireActiveLease: true, at }).attempt;
    if (current.runnerRunId && runnerRunId && current.runnerRunId !== runnerRunId) {
      throw new AgentRunFenceError(context.agentRunId, 'runner run id cannot be replaced');
    }
    if (current.status === 'running' && (!runnerRunId || current.runnerRunId === runnerRunId)) return current;
    const result = this.db.prepare(`
      UPDATE agent_run_attempts SET
        status = 'running', runner_run_id = COALESCE(runner_run_id, ?),
        heartbeat_at = ?, version = version + 1
      WHERE attempt_id = ? AND agent_run_id = ? AND version = ?
        AND executor_owner_id = ? AND fencing_epoch = ?
        AND lease_status = 'active' AND status IN ('starting', 'running')
        AND EXISTS (
          SELECT 1 FROM agent_runs r
          WHERE r.agent_run_id = agent_run_attempts.agent_run_id AND r.active_attempt_id = agent_run_attempts.attempt_id
        )
    `).run(
      runnerRunId ?? null, at, context.attemptId, context.agentRunId, current.version,
      context.executorOwnerId, context.fencingEpoch,
    );
    if (result.changes !== 1) throw new AgentRunFenceError(context.agentRunId, 'attempt start changed concurrently or was fenced');
    return this.getAttempt(context.attemptId)!;
  }

  renewAttemptLease(
    context: ControlPlaneRunContext,
    expiresAt: string,
    at = new Date().toISOString(),
  ): AgentRunAttempt {
    const current = this.assertContext(context, { requireActiveLease: true, at }).attempt;
    if (hasExpired(expiresAt, at)) throw new AgentRunFenceError(context.agentRunId, 'renewal expiry must be in the future');
    const result = this.db.prepare(`
      UPDATE agent_run_attempts SET heartbeat_at = ?, expires_at = ?, version = version + 1
      WHERE attempt_id = ? AND agent_run_id = ? AND version = ?
        AND executor_owner_id = ? AND fencing_epoch = ?
        AND lease_status = 'active' AND status IN ('starting', 'running')
        AND EXISTS (
          SELECT 1 FROM agent_runs r
          WHERE r.agent_run_id = agent_run_attempts.agent_run_id AND r.active_attempt_id = agent_run_attempts.attempt_id
        )
    `).run(
      at, expiresAt, context.attemptId, context.agentRunId, current.version,
      context.executorOwnerId, context.fencingEpoch,
    );
    if (result.changes !== 1) throw new AgentRunFenceError(context.agentRunId, 'lease renewal changed concurrently or was fenced');
    return this.getAttempt(context.attemptId)!;
  }

  recoverInterrupted(
    context: ControlPlaneRunContext,
    terminalReason: string,
    at = new Date().toISOString(),
  ): { run: AgentRun; attempt: AgentRunAttempt } {
    const snapshot = this.assertContext(context, { requireActiveLease: false });
    if (isTerminalStatus(snapshot.run.status) && snapshot.attempt.status === 'terminal') {
      if (snapshot.run.status !== 'interrupted' || snapshot.run.terminalReason !== terminalReason) {
        throw new AgentRunFenceError(context.agentRunId, 'recovery terminal differs from persisted value');
      }
      return snapshot;
    }
    if (isTerminalStatus(snapshot.run.status) || snapshot.attempt.status === 'terminal') {
      throw new AgentRunFenceError(context.agentRunId, 'run and attempt terminal states are inconsistent');
    }
    const runUpdate = this.db.prepare(`
      UPDATE agent_runs SET
        status = 'interrupted', terminal_reason = COALESCE(terminal_reason, ?),
        finished_at = COALESCE(finished_at, ?), updated_at = ?, version = version + 1
      WHERE agent_run_id = ? AND version = ? AND active_attempt_id = ?
        AND status NOT IN ('completed', 'failed', 'aborted', 'interrupted')
    `).run(terminalReason, at, at, context.agentRunId, snapshot.run.version, context.attemptId);
    if (runUpdate.changes !== 1) {
      throw new AgentRunFenceError(context.agentRunId, 'recovery run transition changed concurrently');
    }
    const attemptUpdate = this.db.prepare(`
      UPDATE agent_run_attempts SET
        status = 'terminal', lease_status = 'fenced', terminal_reason = ?,
        released_at = ?, finished_at = ?, heartbeat_at = ?, version = version + 1
      WHERE attempt_id = ? AND agent_run_id = ? AND version = ?
        AND executor_owner_id = ? AND fencing_epoch = ?
        AND lease_status = 'active' AND status IN ('starting', 'running')
        AND EXISTS (
          SELECT 1 FROM agent_runs r
          WHERE r.agent_run_id = agent_run_attempts.agent_run_id
            AND r.active_attempt_id = agent_run_attempts.attempt_id
            AND r.status = 'interrupted'
        )
    `).run(
      terminalReason, at, at, at, context.attemptId, context.agentRunId, snapshot.attempt.version,
      context.executorOwnerId, context.fencingEpoch,
    );
    if (attemptUpdate.changes !== 1) {
      throw new AgentRunFenceError(context.agentRunId, 'recovery attempt fence changed concurrently');
    }
    return { run: this.get(context.agentRunId)!, attempt: this.getAttempt(context.attemptId)! };
  }

  terminalizeAttempt(
    context: ControlPlaneRunContext,
    terminalReason: string,
    errorRef?: string,
    at = new Date().toISOString(),
    leaseStatus: 'released' | 'expired' | 'fenced' = 'released',
  ): AgentRunAttempt {
    const snapshot = this.assertContext(context, { requireActiveLease: false });
    const current = snapshot.attempt;
    if (current.status === 'terminal') {
      if (current.terminalReason !== terminalReason || (errorRef !== undefined && current.errorRef !== errorRef)) {
        throw new AgentRunFenceError(context.agentRunId, 'terminal attempt payload differs from persisted value');
      }
      return current;
    }
    this.assertContext(context, { requireActiveLease: true, at });
    const result = this.db.prepare(`
      UPDATE agent_run_attempts SET
        status = 'terminal', lease_status = ?, terminal_reason = ?, error_ref = ?,
        released_at = ?, finished_at = ?, heartbeat_at = ?, version = version + 1
      WHERE attempt_id = ? AND agent_run_id = ? AND version = ?
        AND executor_owner_id = ? AND fencing_epoch = ?
        AND lease_status = 'active' AND status IN ('starting', 'running')
        AND EXISTS (
          SELECT 1 FROM agent_runs r
          WHERE r.agent_run_id = agent_run_attempts.agent_run_id AND r.active_attempt_id = agent_run_attempts.attempt_id
        )
    `).run(
      leaseStatus, terminalReason, errorRef ?? null, at, at, at,
      context.attemptId, context.agentRunId, current.version,
      context.executorOwnerId, context.fencingEpoch,
    );
    if (result.changes !== 1) throw new AgentRunFenceError(context.agentRunId, 'attempt terminal changed concurrently or was fenced');
    return this.getAttempt(context.attemptId)!;
  }
}
