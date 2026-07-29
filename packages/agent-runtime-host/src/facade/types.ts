import type {
  AgentRun,
  AgentRunAttempt,
  AgentRunAttemptId,
  AgentRunId,
  AgentRunSpec,
  ResolvedAgentRun,
  RuntimeEventEnvelopeV1,
  SessionCommand,
  SessionCommandId,
  SessionId,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import type {
  AgentRuntimeGeneration,
  RuntimePreference,
  RuntimeRouteRequest,
} from '../router/types.js';

export interface StartAgentCommandPayload {
  spec: AgentRunSpec;
  surface: string;
  runtimePreference: RuntimePreference;
}

export type StartAgentCommand =
  & Omit<SessionCommand<StartAgentCommandPayload>, 'kind'>
  & { kind: 'start' };

export interface ResumeAgentCommandPayload {
  agentRunId: AgentRunId;
  surface: string;
  runtimePreference: RuntimePreference;
  checkpointRef?: string;
}

export type ResumeAgentCommand =
  & Omit<SessionCommand<ResumeAgentCommandPayload>, 'kind'>
  & { kind: 'resume' };

export interface CancelReason {
  code: string;
  message?: string;
}

export interface InteractionResponse {
  value: unknown;
  idempotencyKey: string;
}

export interface EventCursor {
  afterGlobalSeq: number;
}

export type CanonicalAgentEvent = RuntimeEventEnvelopeV1;

export interface AgentRunSnapshot {
  run: AgentRun;
  activeAttempt?: AgentRunAttempt;
  runtimeGeneration?: AgentRuntimeGeneration;
  lastGlobalSeq: number;
}

export interface PreparedAgentAttempt {
  spec: AgentRunSpec;
  run: ResolvedAgentRun;
  attempt: AgentRunAttempt;
  authority: AttemptAuthority;
  wireSpec: agentV1Runtime.ResolvedAttemptSpec;
  expectedSpecSha256: Uint8Array;
  routing: RuntimeRouteRequest;
}

/**
 * Complete authority carried by every launch, cancel and interaction action.
 * uint64 values use bigint so JavaScript cannot silently truncate them.
 */
export interface AttemptAuthority {
  sessionId: SessionId;
  commandId: SessionCommandId;
  agentRunId: AgentRunId;
  attemptId: AgentRunAttemptId;
  executorOwnerId: string;
  fencingEpoch: bigint;
  correlationId: string;
  rootAgentRunId: AgentRunId;
  leaseExpiresAtUnixMs: bigint;
  deadlineAtUnixMs: bigint;
}

export type AttemptStartFailurePhase =
  | 'routing'
  | 'adapter_lookup'
  | 'launch';

export interface AttemptStartFailure {
  prepared: PreparedAgentAttempt;
  phase: AttemptStartFailurePhase;
  code: string;
  message: string;
}

export interface AgentRunHandleIdentity {
  agentRunId: AgentRunId;
  attemptId: AgentRunAttemptId;
  runtimeGeneration: AgentRuntimeGeneration;
}

export interface AgentRunHandleContext extends AgentRunHandleIdentity {
  authority: AttemptAuthority;
}
