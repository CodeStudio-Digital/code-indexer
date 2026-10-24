import {
type AgentRun,
type AgentRunAttempt,
type CoderAttemptAdmissionV1,
type CoderAttemptPreparationV1,
type SessionCommandStatus,
type SessionId
} from '@mcp/agent-runtime-contracts';
import type { RuntimeRouteCommit,RuntimeRouteRecord } from '@mcp/agent-runtime-host';
import {
ControlPlaneFileRepository,
type ControlPlaneEntityDataMap,
type ControlPlaneEntityKind,
type EntityRecord
} from '@mcp/session-storage';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import type {
AcceptCommandInput,
AcceptCommandResult,
ControlPlaneCommandContext,
ControlPlaneRunContext,
PersistedSessionCommand,
RuntimeEventAppendInput,
TerminalizeRunInput,
} from '@mcp/store/control-plane/index.js';

export class ControlPlaneFileContext {
readonly journalEnabled: boolean;
readonly internalSessions: FsSessionStore;
readonly internalRepositories = new Map<string, ControlPlaneFileRepository>();
internalRecoveryPromise: Promise<number> | null = null;
constructor(
    sessions: FsSessionStore,
    options: { journalEnabled?: boolean } = {},
  ) {
    this.internalSessions = sessions;
    this.journalEnabled = options.journalEnabled ?? true;
  }
}

export interface ControlPlaneFileContext {
internalRepository(sessionId: SessionId | string): Promise<ControlPlaneFileRepository>;
internalEnqueue<T>(sessionId: SessionId | string, task: () => Promise<T>): Promise<T>;
internalListAll<K extends ControlPlaneEntityKind>(repository: ControlPlaneFileRepository, kind: K): Promise<Array<EntityRecord<ControlPlaneEntityDataMap[K]>>>;
internalAppendRuntimeEventUnlocked<T>(repository: ControlPlaneFileRepository, input: RuntimeEventAppendInput<T>): Promise<void>;
internalUpdateCommand(repository: ControlPlaneFileRepository, command: PersistedSessionCommand): Promise<PersistedSessionCommand>;
internalUpdateRun(repository: ControlPlaneFileRepository, run: AgentRun): Promise<AgentRun>;
internalUpdateAttempt(repository: ControlPlaneFileRepository, attempt: AgentRunAttempt, sessionId: SessionId): Promise<AgentRunAttempt>;
internalCommand(repository: ControlPlaneFileRepository, commandId: string): Promise<PersistedSessionCommand | null>;
internalRun(repository: ControlPlaneFileRepository, runId: string): Promise<AgentRun | null>;
internalAttempt(repository: ControlPlaneFileRepository, attemptId: string): Promise<AgentRunAttempt | null>;
internalAssertCommandContext(repository: ControlPlaneFileRepository, context: ControlPlaneCommandContext): Promise<PersistedSessionCommand>;
internalAssertRunContext(repository: ControlPlaneFileRepository, context: ControlPlaneRunContext, options?: { requireActiveLease?: boolean; at?: string }): Promise<{
    command: PersistedSessionCommand;
    run: AgentRun;
    attempt: AgentRunAttempt;
  }>;
acceptCommand<T>(input: AcceptCommandInput<T>): Promise<AcceptCommandResult>;
bindCommandExecution(context: ControlPlaneCommandContext, busId: string, occurredAt?: string): Promise<void>;
terminalizeCommand(input: {
    context: ControlPlaneCommandContext;
    status: Extract<SessionCommandStatus, 'succeeded' | 'failed' | 'cancelled'>;
    reason: string;
    errorRef?: string;
    result?: unknown;
    occurredAt?: string;
    preserveExistingTerminal?: boolean;
  }): Promise<void>;
admitCoderAttempt(context: ControlPlaneRunContext, preparation: CoderAttemptPreparationV1): Promise<CoderAttemptAdmissionV1>;
markRunStarted(context: ControlPlaneRunContext, runnerRunId?: string, requestedAt?: string): Promise<void>;
renewAttemptLease(context: ControlPlaneRunContext, expiresAt: string, heartbeatAt?: string): Promise<void>;
appendToolBoundary(input: {
    context: ControlPlaneRunContext;
    toolUseId: string;
    toolName: string;
    phase: 'started' | 'completed';
    occurredAt?: string;
    payload?: Record<string, unknown>;
  }): Promise<void>;
appendRuntimeEvent<T>(input: RuntimeEventAppendInput<T>): Promise<void>;
internalTerminalizeRun(input: TerminalizeRunInput, interrupted: boolean): Promise<void>;
terminalizeRun(input: TerminalizeRunInput): Promise<void>;
interruptRun(input: TerminalizeRunInput): Promise<void>;
getCommand(sessionId: SessionId, commandId: string): Promise<PersistedSessionCommand | null>;
getAttemptState(context: ControlPlaneRunContext, requireActiveLease?: boolean): Promise<{ command: PersistedSessionCommand; run: AgentRun; attempt: AgentRunAttempt; }>;
getRuntimeRoute(sessionId: SessionId, attemptId: string): Promise<RuntimeRouteRecord | null>;
commitRuntimeRoute(context: ControlPlaneRunContext, route: RuntimeRouteRecord): Promise<RuntimeRouteCommit>;
commitRuntimeRequest(context: ControlPlaneRunContext, key: string, payload: unknown): Promise<boolean>;
getRun(sessionId: SessionId, agentRunId: string): Promise<AgentRun | null>;
recordDivergences(context: Pick<
      ControlPlaneRunContext,
      | 'sessionId'
      | 'commandId'
      | 'agentRunId'
      | 'correlationId'
      | 'actor'
    >, divergences: readonly unknown[]): Promise<void>;
recoverInterruptedRuns(reason?: string, occurredAt?: string): Promise<number>;
internalPerformRecovery(reason: string, occurredAt: string): Promise<number>;
}
