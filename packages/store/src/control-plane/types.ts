import type {
  AgentRun,
  AgentRunAttempt,
  AgentRunAttemptId,
  AgentRunId,
  AgentRunStatus,
  AgentRunWaitMode,
  CorrelationId,
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
  legacySessionId?: number;
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
  waitMode: AgentRunWaitMode;
  requestedProvider?: string;
  requestedModel?: string;
  requestedReasoningEffort?: string;
  requestedPreset?: string;
  requestedCapabilityProfile: string;
  executorOwnerId: string;
  executorExpiresAt: string;
}

export interface AcceptCommandInput<T = unknown> {
  command: SessionCommand<T>;
  payloadHash: string;
  legacySessionId?: number;
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
  legacySessionId?: number;
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
  legacySessionId?: number;
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
