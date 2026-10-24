import type {
  AgentRun,
  AgentRunAttempt,
  AgentRunAttemptId,
  AgentRunId,
  AgentRunSpec,
  CoderAttemptAdmissionV1,
  CoderAttemptPreparationV1,
  ResolvedAgentRun,
  RuntimeEventEnvelopeV1,
  SessionCommand,
  SessionCommandId,
  SessionId,
} from '@mcp/agent-runtime-contracts';
import type {
  AgentRuntimeGeneration,
  RuntimePreference,
  RuntimeRouteRequest,
} from '../router/types.js';

export type StartAgentCommandPayload = ({ spec: AgentRunSpec; admittedPreparationRef?: never }
  | { admittedPreparationRef: string; spec?: never }) & {
  surface: string;
  runtimePreference: RuntimePreference;
};

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
  /** Required when continuing a volatile stream whose sequence resets per run. */
  streamId?: string;
}

export type CanonicalAgentEvent = RuntimeEventEnvelopeV1 & {
  stream?: { id: string; durability: 'volatile'; sequenceScope: 'stream' };
};

export interface AgentRunSnapshot {
  run: AgentRun;
  activeAttempt?: AgentRunAttempt;
  runtimeGeneration?: AgentRuntimeGeneration;
  lastGlobalSeq: number;
  stream?: { id: string; durability: 'volatile'; sequenceScope: 'stream' };
}

/** Durable admission for a prepared TypeScript worker. */
export interface PreparedLegacyAgentAttempt {
  run: ResolvedAgentRun;
  attempt: AgentRunAttempt;
  authority: AttemptAuthority;
  preparation: CoderAttemptPreparationV1;
  admission: CoderAttemptAdmissionV1;
  expectedSpecSha256: Uint8Array;
  routing: RuntimeRouteRequest;
}

export type ExecutableAgentAttempt = PreparedLegacyAgentAttempt;

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
  prepared: ExecutableAgentAttempt;
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
