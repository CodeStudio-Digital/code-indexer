import { randomUUID } from 'node:crypto';
import type { Database as DB } from 'better-sqlite3';
import {
  asAgentRunAttemptId,
  asAgentRunId,
  classifyCoderTerminalOutcome,
  isResolvedAgentRun,
  type AgentRun,
  type AgentRunAttempt,
  type AgentRunTerminalStatus,
  type AgentRunWaitMode,
  type EnvironmentId,
} from '@mcp/agent-runtime-contracts';
import {
  AgentRunStore,
  CommandLedgerStore,
  type ControlPlaneRunContext,
  type PersistedSessionCommand,
} from '@mcp/store/control-plane/index.js';
import { save as saveOrchestrationCheckpoint } from '@mcp/code-agent/sessions/store/orchestration-checkpoints.js';

const CHILD_LEASE_MS = 60 * 60_000;
const TERMINAL = new Set(['completed', 'failed', 'aborted', 'interrupted']);

export interface AgentRunShadowMetrics {
  childRunsCreated: number;
  childRunsTerminalized: number;
  writeErrors: number;
}

const metrics: AgentRunShadowMetrics = {
  childRunsCreated: 0,
  childRunsTerminalized: 0,
  writeErrors: 0,
};

export function agentRunStoreShadowEnabled(): boolean {
  return process.env.CODER_AGENT_RUN_STORE_SHADOW === '1';
}

/**
 * Enforcement is intentionally independent from the audit shadow. Operators
 * can burn the projection in with SHADOW first, then opt into fail-closed
 * dispatch without changing the default-off rollout.
 */
export function agentRunStoreEnforceEnabled(): boolean {
  return process.env.CODER_AGENT_RUN_STORE_ENFORCE === '1';
}

export function agentRunStoreEnabled(): boolean {
  return agentRunStoreShadowEnabled() || agentRunStoreEnforceEnabled();
}

export function snapshotAgentRunShadowMetrics(): AgentRunShadowMetrics {
  return { ...metrics };
}

export function resetAgentRunShadowMetricsForTests(): void {
  metrics.childRunsCreated = 0;
  metrics.childRunsTerminalized = 0;
  metrics.writeErrors = 0;
}

export interface RecordChildSpawnInput {
  legacySessionId: number | null;
  runId: string;
  /** Opaque authoritative parent identity passed with the worker command. */
  parentAgentRunId?: string | null;
  /** Legacy correlation fallback for in-process/rolling-upgrade callers. */
  parentRunnerRunId?: string | null;
  profile: string;
  requestedProvider?: string;
  requestedModel?: string;
  requestedReasoningEffort?: string;
  waitMode: AgentRunWaitMode;
  effectiveProvider?: string;
  effectiveModel?: string;
  effectiveReasoningEffort?: string;
  /** Actual post-filter child tool names; metadata only, never tool input. */
  effectiveCapabilities?: string[];
  /** SHA-256 over the local environment identity; never a raw filesystem path. */
  environmentFingerprint?: string;
  /** Coarse policy source applied to the child (for example inherited/background). */
  policyMode?: string;
  timeoutMs?: number | null;
}

export interface RecordChildTerminalInput {
  runId: string;
  reason: string;
  resultRef?: string | null;
  fence?: ControlPlaneRunContext;
}

export interface AgentRunRecorder {
  recordChildSpawn(input: RecordChildSpawnInput): ControlPlaneRunContext | null;
  assertChildFence(context: ControlPlaneRunContext): void;
  recordChildHeartbeat(runId: string, fence?: ControlPlaneRunContext): void;
  recordChildTerminal(input: RecordChildTerminalInput): void;
  recordChildInterrupted(runId: string, reason?: string): void;
}

export interface AgentRunRecorderDeps {
  db: DB;
  log?: (message: string) => void;
  /**
   * Continue validating/terminalizing a fence that was already issued even
   * if rollout flags are toggled off. Kill switches govern new projection;
   * they cannot revoke the authority of an in-flight token.
   */
  forceExistingFence?: boolean;
}

interface ParentLinkRow {
  agent_run_id: string;
}

function childAgentRunId(runId: string): ReturnType<typeof asAgentRunId> {
  return asAgentRunId(`agent-run:subagent:${runId}`);
}

function childAttemptId(runId: string): ReturnType<typeof asAgentRunAttemptId> {
  return asAgentRunAttemptId(`agent-run-attempt:subagent:${runId}:1`);
}

function terminalStatus(reason: string): AgentRunTerminalStatus {
  const terminal = classifyCoderTerminalOutcome({ event: 'done', reason });
  if (terminal.classification === 'completed') return 'completed';
  if (terminal.classification === 'cancelled') return 'aborted';
  if (terminal.classification === 'interrupted') return 'interrupted';
  return 'failed';
}

function isTerminal(run: AgentRun): boolean {
  return TERMINAL.has(run.status);
}

function resolutionCheckpointId(runId: string): string {
  return `agent-run-resolution:${runId}`;
}

function contextFor(
  run: AgentRun,
  attempt: AgentRunAttempt,
  command: PersistedSessionCommand,
): ControlPlaneRunContext {
  return {
    sessionId: run.sessionId,
    legacySessionId: command.legacySessionId,
    commandId: run.commandId,
    correlationId: command.correlationId,
    actor: command.actor,
    agentRunId: run.agentRunId,
    attemptId: attempt.attemptId,
    executorOwnerId: attempt.executorLease.ownerId,
    fencingEpoch: attempt.executorLease.fencingEpoch,
  };
}

export function createAgentRunRecorder(deps: AgentRunRecorderDeps): AgentRunRecorder | null {
  const forceExistingFence = deps.forceExistingFence === true;
  if (!agentRunStoreEnabled() && !forceExistingFence) return null;

  const runs = new AgentRunStore(deps.db);
  const commands = new CommandLedgerStore(deps.db);
  const log = deps.log ?? ((message: string) => console.warn(message));

  const recordDurableError = (
    operation: string,
    runId: string,
    detail: string,
    legacySessionId?: number | null,
    parentRunnerRunId?: string | null,
    parent?: AgentRun | null,
  ): void => {
    metrics.writeErrors += 1;
    log(`[agent-run-shadow] ${operation} failed run=${runId}: ${detail}`);
    try {
      const child = runs.get(childAgentRunId(runId));
      const relatedRun = parent ?? child;
      const relatedCommand = relatedRun ? commands.get(relatedRun.commandId) : null;
      const effectiveLegacySessionId = legacySessionId ?? relatedCommand?.legacySessionId;
      const sessionId = relatedRun?.sessionId
        ?? (effectiveLegacySessionId == null
          ? undefined
          : (deps.db.prepare(`
              SELECT session_id FROM control_plane_sessions WHERE legacy_session_id = ?
            `).get(effectiveLegacySessionId) as { session_id: string } | undefined)?.session_id);
      if (!sessionId) return;
      deps.db.prepare(`
        INSERT INTO control_plane_divergences (
          divergence_id, session_id, legacy_session_id, command_id, agent_run_id,
          kind, legacy_state_json, control_plane_state_json, detail, detected_at
        ) VALUES (?, ?, ?, ?, ?, 'agent_run_shadow_write_error', ?, ?, ?, ?)
      `).run(
        `divergence:agent-run-shadow:${randomUUID()}`,
        sessionId,
        effectiveLegacySessionId ?? null,
        relatedRun?.commandId ?? null,
        childAgentRunId(runId),
        JSON.stringify({ runId, parentRunnerRunId: parentRunnerRunId ?? null }),
        JSON.stringify({ operation, state: 'write_error' }),
        detail.slice(0, 2_000),
        new Date().toISOString(),
      );
    } catch {
      // The shadow must remain best-effort even when its diagnostic sink is unavailable.
    }
  };

  const loadParent = (parentRunnerRunId: string, legacySessionId: number): AgentRun => {
    const row = deps.db.prepare(`
      SELECT r.agent_run_id
      FROM agent_run_attempts a
      JOIN agent_runs r ON r.agent_run_id = a.agent_run_id
      WHERE a.runner_run_id = ? AND r.legacy_session_id = ?
      ORDER BY a.ordinal DESC
      LIMIT 1
    `).get(parentRunnerRunId, legacySessionId) as ParentLinkRow | undefined;
    const parent = row ? runs.get(row.agent_run_id) : null;
    if (!parent) throw new Error(`parent AgentRun not found for runner ${parentRunnerRunId}`);
    return parent;
  };

  const loadParentByAgentRunId = (parentAgentRunId: string, legacySessionId: number): AgentRun => {
    const row = deps.db.prepare(`
      SELECT agent_run_id
      FROM agent_runs
      WHERE agent_run_id = ? AND legacy_session_id = ?
      LIMIT 1
    `).get(parentAgentRunId, legacySessionId) as ParentLinkRow | undefined;
    const parent = row ? runs.get(row.agent_run_id) : null;
    if (!parent) {
      throw new Error(`parent AgentRun ${parentAgentRunId} not found for session ${legacySessionId}`);
    }
    return parent;
  };

  const loadChildContext = (runId: string): {
    run: AgentRun;
    attempt: AgentRunAttempt;
    command: PersistedSessionCommand;
    context: ControlPlaneRunContext;
  } => {
    const run = runs.get(childAgentRunId(runId));
    if (!run || !run.activeAttemptId) throw new Error('child AgentRun/active attempt not found');
    const attempt = runs.getAttempt(run.activeAttemptId);
    const command = commands.get(run.commandId);
    if (!attempt || !command) throw new Error('child attempt/command not found');
    return { run, attempt, command, context: contextFor(run, attempt, command) };
  };

  return {
    recordChildSpawn(input): ControlPlaneRunContext | null {
      if (!agentRunStoreEnabled() && !forceExistingFence) return null;
      let parent: AgentRun | null = null;
      try {
        if (input.legacySessionId == null) {
          throw new Error('legacy session id is required for child AgentRun');
        }
        if (!input.parentAgentRunId && !input.parentRunnerRunId) {
          throw new Error('authoritative parent AgentRun id is unavailable');
        }
        parent = input.parentAgentRunId
          ? loadParentByAgentRunId(input.parentAgentRunId, input.legacySessionId)
          : loadParent(input.parentRunnerRunId!, input.legacySessionId);
        const parentAttempt = parent.activeAttemptId ? runs.getAttempt(parent.activeAttemptId) : null;
        const command = commands.get(parent.commandId);
        if (!parentAttempt || !command) throw new Error('parent attempt/command not found');

        const id = childAgentRunId(input.runId);
        const attemptId = childAttemptId(input.runId);
        let created = false;
        deps.db.transaction(() => {
          let child = runs.get(id);
          if (!child) {
            child = runs.create(command, input.legacySessionId ?? undefined, {
              agentRunId: id,
              attemptId,
              ownerAgentRunId: parent!.ownerAgentRunId ?? parent!.agentRunId,
              parentAgentRunId: parent!.agentRunId,
              spawnDepth: parent!.spawnDepth + 1,
              role: 'subagent',
              agentDefinitionId: input.profile,
              waitMode: input.waitMode,
              requestedProvider: input.requestedProvider,
              requestedModel: input.requestedModel,
              requestedReasoningEffort: input.requestedReasoningEffort,
              requestedCapabilityProfile: input.profile,
              effectiveProvider: input.effectiveProvider,
              effectiveModel: input.effectiveModel,
              effectiveReasoningEffort: input.effectiveReasoningEffort,
              executorOwnerId: parentAttempt.executorLease.ownerId,
              executorExpiresAt: new Date(Date.now() + Math.max(
                CHILD_LEASE_MS,
                (input.timeoutMs ?? 0) + 60_000,
              )).toISOString(),
            });
            runs.createInitialAttempt(child.agentRunId, {
              agentRunId: id,
              attemptId,
              role: 'subagent',
              agentDefinitionId: input.profile,
              waitMode: input.waitMode,
              requestedCapabilityProfile: input.profile,
              executorOwnerId: parentAttempt.executorLease.ownerId,
              executorExpiresAt: new Date(Date.now() + Math.max(
                CHILD_LEASE_MS,
                (input.timeoutMs ?? 0) + 60_000,
              )).toISOString(),
            });
            created = true;
          } else {
            const persisted = deps.db.prepare(`
              SELECT wait_mode, parent_agent_run_id, agent_definition_id
              FROM agent_runs WHERE agent_run_id=?
            `).get(id) as {
              wait_mode: AgentRunWaitMode;
              parent_agent_run_id: string | null;
              agent_definition_id: string;
            } | undefined;
            if (!persisted
              || persisted.wait_mode !== input.waitMode
              || persisted.parent_agent_run_id !== parent!.agentRunId
              || persisted.agent_definition_id !== input.profile) {
              throw new Error('child AgentRun replay does not match persisted spawn contract');
            }
          }
          if (isTerminal(child)) return;
          const attempt = child.activeAttemptId ? runs.getAttempt(child.activeAttemptId) : null;
          if (!attempt) throw new Error('child active attempt not found after create');
          const context = contextFor(child, attempt, command);
          runs.markAttemptRunning(context, input.runId);
          runs.transition(context, 'running');

          const capabilities = [...new Set(input.effectiveCapabilities ?? [])].sort();
          const hasResolutionMetadata = !!input.effectiveProvider
            && !!input.effectiveModel
            && !!input.environmentFingerprint
            && !!input.policyMode
            && input.effectiveCapabilities !== undefined;
          if (agentRunStoreEnforceEnabled() && !hasResolutionMetadata) {
            throw new Error('AgentRun enforcement requires complete effective resolution metadata');
          }
          if (hasResolutionMetadata) {
            // `hasResolutionMetadata` is the runtime completeness proof; bind
            // required fields once so the persisted/resolved contracts stay
            // statically non-optional too.
            const effectiveProvider = input.effectiveProvider!;
            const effectiveModel = input.effectiveModel!;
            const environmentFingerprint = input.environmentFingerprint!;
            const policyMode = input.policyMode!;
            const checkpointId = resolutionCheckpointId(input.runId);
            const payload = {
              schemaVersion: 1,
              runId: input.runId,
              profile: input.profile,
              waitMode: input.waitMode,
              effectiveProvider,
              effectiveModel,
              effectiveReasoningEffort: input.effectiveReasoningEffort ?? null,
              capabilities,
              environmentFingerprint,
              policyMode,
            };
            const persisted = saveOrchestrationCheckpoint(deps.db, {
              sessionId: input.legacySessionId!,
              kind: 'agent_run_resolution',
              scopeId: input.runId,
              privacyClass: 'metadata_only',
              payloadJson: JSON.stringify(payload),
              expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
            });
            if (!persisted && agentRunStoreEnforceEnabled()) {
              throw new Error('AgentRun enforcement could not persist the resolution checkpoint');
            }
            if (persisted) {
              const resolution = {
                effectiveProvider,
                effectiveModel,
                effectiveReasoningEffort: input.effectiveReasoningEffort,
                capabilitySetRef: `checkpoint:${checkpointId}#capabilities`,
                environmentId: `environment:${checkpointId}` as EnvironmentId,
                // Refs must dereference to fields that actually exist in the
                // metadata checkpoint. The effective specialist profile is
                // the child preset resolution; policyMode is its applied
                // policy snapshot/coarse authority mode.
                presetResolutionRef: `checkpoint:${checkpointId}#profile`,
                policySnapshotRef: `checkpoint:${checkpointId}#policyMode`,
              };
              const current = runs.get(id)!;
              if (isResolvedAgentRun(current)) {
                if (current.effectiveProvider !== resolution.effectiveProvider
                  || current.effectiveModel !== resolution.effectiveModel
                  || current.capabilitySetRef !== resolution.capabilitySetRef
                  || current.environmentId !== resolution.environmentId
                  || current.presetResolutionRef !== resolution.presetResolutionRef
                  || current.policySnapshotRef !== resolution.policySnapshotRef) {
                  throw new Error('child AgentRun resolution replay differs from persisted value');
                }
              } else {
                runs.markResolved(context, resolution, current.version);
              }
            }
          }
        })();
        if (created) metrics.childRunsCreated += 1;
        return loadChildContext(input.runId).context;
      } catch (error) {
        recordDurableError(
          'spawn',
          input.runId,
          error instanceof Error ? error.message : String(error),
          input.legacySessionId,
          input.parentRunnerRunId,
          parent,
        );
        if (agentRunStoreEnforceEnabled() || forceExistingFence) throw error;
        return null;
      }
    },

    assertChildFence(context): void {
      if (!agentRunStoreEnabled() && !forceExistingFence) return;
      try {
        runs.assertContext(context, { requireActiveLease: true });
      } catch (error) {
        const encoded = String(context.agentRunId);
        const runId = encoded.startsWith('agent-run:subagent:')
          ? encoded.slice('agent-run:subagent:'.length)
          : encoded;
        recordDurableError(
          'fence',
          runId,
          error instanceof Error ? error.message : String(error),
          context.legacySessionId,
        );
        if (agentRunStoreEnforceEnabled() || forceExistingFence) throw error;
      }
    },

    recordChildHeartbeat(runId, fence): void {
      if (!agentRunStoreEnabled() && !forceExistingFence) return;
      try {
        const child = loadChildContext(runId);
        if (isTerminal(child.run)) return;
        if (fence) {
          runs.assertContext(fence, { requireActiveLease: true });
          child.context = fence;
        }
        const now = new Date();
        const heartbeatExpiry = new Date(now.getTime() + CHILD_LEASE_MS).toISOString();
        const currentExpiry = child.attempt.executorLease.expiresAt;
        runs.renewAttemptLease(
          child.context,
          currentExpiry && currentExpiry > heartbeatExpiry ? currentExpiry : heartbeatExpiry,
          now.toISOString(),
        );
      } catch (error) {
        recordDurableError('heartbeat', runId, error instanceof Error ? error.message : String(error));
        if (agentRunStoreEnforceEnabled() || forceExistingFence) throw error;
      }
    },

    recordChildTerminal(input): void {
      if (!agentRunStoreEnabled() && !forceExistingFence) return;
      try {
        let terminalized = false;
        deps.db.transaction(() => {
          let child = loadChildContext(input.runId);
          const status = terminalStatus(input.reason);
          if (isTerminal(child.run)) {
            if (child.run.status !== status || child.run.terminalReason !== input.reason) {
              throw new Error(`terminal payload differs from persisted ${child.run.status}/${child.run.terminalReason}`);
            }
            return;
          }
          if (input.fence) {
            runs.assertContext(input.fence, { requireActiveLease: true });
            child.context = input.fence;
          }
          if (child.run.status === 'starting') {
            runs.markAttemptRunning(child.context, input.runId);
            runs.transition(child.context, 'running');
            child = loadChildContext(input.runId);
          }
          runs.transition(child.context, status, {
            terminalReason: input.reason,
            resultRef: input.resultRef ?? undefined,
          });
          runs.terminalizeAttempt(child.context, input.reason);
          terminalized = true;
        })();
        if (terminalized) metrics.childRunsTerminalized += 1;
      } catch (error) {
        recordDurableError('terminal', input.runId, error instanceof Error ? error.message : String(error));
        if (agentRunStoreEnforceEnabled() || forceExistingFence) throw error;
      }
    },

    recordChildInterrupted(runId, reason = 'worker_restart'): void {
      if (!agentRunStoreEnabled() && !forceExistingFence) return;
      // Rows created before this shadow was enabled legitimately have no child
      // AgentRun. Orphan recovery must skip them rather than manufacture a
      // divergence for historical telemetry.
      if (!runs.get(childAgentRunId(runId))) return;
      try {
        let terminalized = false;
        deps.db.transaction(() => {
          const child = loadChildContext(runId);
          if (isTerminal(child.run)) {
            if (child.run.status !== 'interrupted' || child.run.terminalReason !== reason) {
              throw new Error(`interruption differs from persisted ${child.run.status}/${child.run.terminalReason}`);
            }
            return;
          }
          runs.recoverInterrupted(child.context, reason);
          terminalized = true;
        })();
        if (terminalized) metrics.childRunsTerminalized += 1;
      } catch (error) {
        recordDurableError('interrupt', runId, error instanceof Error ? error.message : String(error));
        if (agentRunStoreEnforceEnabled() || forceExistingFence) throw error;
      }
    },
  };
}
