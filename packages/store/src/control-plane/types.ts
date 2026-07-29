import type {
  AgentRun,
  AgentRunAttempt,
  AgentRunAttemptId,
  AgentRunId,
  AgentRunStatus,
  AgentRunWaitMode,
  CorrelationId,
  EnvironmentId,
  ResolutionReason,
  RuntimeEventEnvelopeV1,
  SessionCommand,
  SessionCommandId,
  SessionCommandKind,
  SessionCommandResult,
  SessionCommandStatus,
  SessionId,
} from '@mcp/agent-runtime-contracts';

export interface PersistedSessionCommand extends SessionCommandResult {
  schemaVersion: 1;
  sessionId: SessionId;
  idempotencyKey: string;
  kind: SessionCommandKind;
  payloadHash: string;
  actor: SessionCommand['actor'];
  expectedSessionVersion?: number;
  correlationId: CorrelationId;
  requestedAt: string;
  deadlineAt?: string;
  result?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunSeed {
  agentRunId: AgentRunId;
  attemptId: AgentRunAttemptId;
  role: string;
  agentDefinitionId: string;
  /**
   * Hierarchy — a child AgentRun (a subagent) sets owner/parent and its real
   * spawn depth. Root runs omit these (owner/parent null, spawnDepth 0), which
   * preserves the pre-Fase-3 create() shape exactly.
   */
  ownerAgentRunId?: AgentRunId;
  parentAgentRunId?: AgentRunId;
  spawnDepth?: number;
  waitMode: AgentRunWaitMode;
  requestedProvider?: string;
  requestedModel?: string;
  requestedReasoningEffort?: string;
  requestedPreset?: string;
  requestedCapabilityProfile: string;
  /**
   * Resolution — normally written later via `markResolved`, but a caller that
   * already resolved provider/model/preset/environment may seed them at
   * create time. Absent for the current shadow flow (root runs stay
   * unresolved until the runner resolves them).
   */
  effectiveProvider?: string;
  effectiveModel?: string;
  effectiveReasoningEffort?: string;
  effectivePreset?: string;
  capabilitySetRef?: string;
  environmentId?: EnvironmentId;
  presetResolutionRef?: string;
  policySnapshotRef?: string;
  downgradeReasons?: ResolutionReason[];
  executorOwnerId: string;
  executorExpiresAt: string;
}

/**
 * Resolution patch applied AFTER accept, once the runner has resolved the
 * effective provider/model/preset, capability set, environment and policy
 * snapshot. Written by `AgentRunStore.markResolved` under a version
 * compare-and-set so a `ResolvedAgentRun` is only ever produced by a single
 * winning writer. Does not touch status or the executor lease.
 */
export interface AgentRunResolutionPatch {
  effectiveProvider: string;
  effectiveModel: string;
  capabilitySetRef: string;
  environmentId: EnvironmentId;
  presetResolutionRef: string;
  policySnapshotRef: string;
  effectiveReasoningEffort?: string;
  effectivePreset?: string;
  downgradeReasons?: ResolutionReason[];
  at?: string;
}

export interface AcceptCommandInput<T = unknown> {
  command: SessionCommand<T>;
  payloadHash: string;
  /**
   * Historical command kinds that shared this command's idempotency namespace.
   * They are checked in the same IMMEDIATE transaction before a new command is
   * accepted, which makes rolling upgrades restart-safe.
   */
  idempotencyKindAliases?: SessionCommandKind[];
  run?: AgentRunSeed;
  linkedAgentRunId?: AgentRunId;
}

export type AcceptCommandResult =
  | { kind: 'accepted'; command: PersistedSessionCommand; agentRun?: AgentRun; attempt?: AgentRunAttempt }
  | { kind: 'existing'; command: PersistedSessionCommand; agentRun?: AgentRun; attempt?: AgentRunAttempt }
  | { kind: 'payload_conflict'; command: PersistedSessionCommand }
  | { kind: 'version_conflict'; expected: number; actual: number };

export interface ControlPlaneCommandContext {
  sessionId: SessionId;
  commandId: SessionCommandId;
  correlationId: CorrelationId;
  actor: SessionCommand['actor'];
}

export interface ExecutorLeaseToken {
  ownerId: string;
  fencingEpoch: number;
}

export interface ControlPlaneRunContext extends ControlPlaneCommandContext {
  agentRunId: AgentRunId;
  attemptId: AgentRunAttemptId;
  executorOwnerId: string;
  fencingEpoch: number;
}

export interface RuntimeEventAppendInput<T = unknown>
  extends Omit<RuntimeEventEnvelopeV1<T>, 'globalSeq' | 'recordedAt' | 'payloadHash'> {
  recordedAt?: string;
  payloadHash?: string;
}

export interface TerminalizeRunInput {
  context: ControlPlaneRunContext;
  status: Extract<AgentRunStatus, 'completed' | 'failed' | 'aborted' | 'interrupted'>;
  commandStatus: Extract<SessionCommandStatus, 'succeeded' | 'failed' | 'cancelled'>;
  reason: string;
  errorRef?: string;
  transcriptRef?: string;
  attemptLeaseStatus?: 'released' | 'expired' | 'fenced';
  occurredAt?: string;
}
