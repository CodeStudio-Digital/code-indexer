import { type AgentRun, type AgentRunAttempt, type CoderAttemptAdmissionV1, type CoderAttemptPreparationV1, type SessionCommandStatus, type SessionId } from '@mcp/agent-runtime-contracts';
import type { RuntimeRouteCommit, RuntimeRouteRecord } from '@mcp/agent-runtime-host';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import type { AcceptCommandInput, AcceptCommandResult, ControlPlaneCommandContext, ControlPlaneRunContext, PersistedSessionCommand, RuntimeEventAppendInput, TerminalizeRunInput, } from '@mcp/store/control-plane/index.js';
import { type FileControlPlaneAuthority } from './control-plane-file-shared.js';
import type { ControlPlaneFileContext } from './control-plane-file-context.js';
import { createControlPlaneFileContext } from './control-plane-file-create.js';
export type { ControlPlaneAuthority, FileControlPlaneAuthority } from './control-plane-file-shared.js';
/** Session-bundle authority with domain operations sharing one private context. */
export class FileControlPlaneStore implements FileControlPlaneAuthority {
    readonly #context: ControlPlaneFileContext;
    readonly #implementation: Pick<ControlPlaneFileContext, 'acceptCommand' | 'bindCommandExecution' | 'terminalizeCommand' | 'admitCoderAttempt' | 'markRunStarted' | 'renewAttemptLease' | 'appendToolBoundary' | 'appendRuntimeEvent' | 'terminalizeRun' | 'interruptRun' | 'getCommand' | 'getAttemptState' | 'getRuntimeRoute' | 'commitRuntimeRoute' | 'commitRuntimeRequest' | 'getRun' | 'recordDivergences' | 'recoverInterruptedRuns'>;
    readonly journalEnabled: boolean;
    constructor(sessions: FsSessionStore, options: {
        journalEnabled?: boolean;
    } = {}) {
        this.#context = createControlPlaneFileContext(sessions, options);
        this.journalEnabled = this.#context.journalEnabled;
        this.#implementation = {
            acceptCommand: this.#context.acceptCommand.bind(this.#context),
            bindCommandExecution: this.#context.bindCommandExecution.bind(this.#context),
            terminalizeCommand: this.#context.terminalizeCommand.bind(this.#context),
            admitCoderAttempt: this.#context.admitCoderAttempt.bind(this.#context),
            markRunStarted: this.#context.markRunStarted.bind(this.#context),
            renewAttemptLease: this.#context.renewAttemptLease.bind(this.#context),
            appendToolBoundary: this.#context.appendToolBoundary.bind(this.#context),
            appendRuntimeEvent: this.#context.appendRuntimeEvent.bind(this.#context),
            terminalizeRun: this.#context.terminalizeRun.bind(this.#context),
            interruptRun: this.#context.interruptRun.bind(this.#context),
            getCommand: this.#context.getCommand.bind(this.#context),
            getAttemptState: this.#context.getAttemptState.bind(this.#context),
            getRuntimeRoute: this.#context.getRuntimeRoute.bind(this.#context),
            commitRuntimeRoute: this.#context.commitRuntimeRoute.bind(this.#context),
            commitRuntimeRequest: this.#context.commitRuntimeRequest.bind(this.#context),
            getRun: this.#context.getRun.bind(this.#context),
            recordDivergences: this.#context.recordDivergences.bind(this.#context),
            recoverInterruptedRuns: this.#context.recoverInterruptedRuns.bind(this.#context),
        };
        // Domain calls retain the original virtual dispatch through this facade.
        this.#context.acceptCommand = (input) => this.acceptCommand(input);
        this.#context.bindCommandExecution = (context, busId, occurredAt) => this.bindCommandExecution(context, busId, occurredAt);
        this.#context.terminalizeCommand = (input) => this.terminalizeCommand(input);
        this.#context.admitCoderAttempt = (context, preparation) => this.admitCoderAttempt(context, preparation);
        this.#context.markRunStarted = (context, runnerRunId, requestedAt) => this.markRunStarted(context, runnerRunId, requestedAt);
        this.#context.renewAttemptLease = (context, expiresAt, heartbeatAt) => this.renewAttemptLease(context, expiresAt, heartbeatAt);
        this.#context.appendToolBoundary = (input) => this.appendToolBoundary(input);
        this.#context.appendRuntimeEvent = (input) => this.appendRuntimeEvent(input);
        this.#context.terminalizeRun = (input) => this.terminalizeRun(input);
        this.#context.interruptRun = (input) => this.interruptRun(input);
        this.#context.getCommand = (sessionId, commandId) => this.getCommand(sessionId, commandId);
        this.#context.getAttemptState = (context, requireActiveLease) => this.getAttemptState(context, requireActiveLease);
        this.#context.getRuntimeRoute = (sessionId, attemptId) => this.getRuntimeRoute(sessionId, attemptId);
        this.#context.commitRuntimeRoute = (context, route) => this.commitRuntimeRoute(context, route);
        this.#context.commitRuntimeRequest = (context, key, payload) => this.commitRuntimeRequest(context, key, payload);
        this.#context.getRun = (sessionId, agentRunId) => this.getRun(sessionId, agentRunId);
        this.#context.recordDivergences = (context, divergences) => this.recordDivergences(context, divergences);
        this.#context.recoverInterruptedRuns = (reason, occurredAt) => this.recoverInterruptedRuns(reason, occurredAt);
    }
    acceptCommand<T>(input: AcceptCommandInput<T>): Promise<AcceptCommandResult> { return this.#implementation.acceptCommand(input); }
    bindCommandExecution(context: ControlPlaneCommandContext, busId: string, occurredAt?: string): Promise<void> { return this.#implementation.bindCommandExecution(context, busId, occurredAt); }
    terminalizeCommand(input: {
        context: ControlPlaneCommandContext;
        status: Extract<SessionCommandStatus, 'succeeded' | 'failed' | 'cancelled'>;
        reason: string;
        errorRef?: string;
        result?: unknown;
        occurredAt?: string;
        preserveExistingTerminal?: boolean;
    }): Promise<void> { return this.#implementation.terminalizeCommand(input); }
    admitCoderAttempt(context: ControlPlaneRunContext, preparation: CoderAttemptPreparationV1): Promise<CoderAttemptAdmissionV1> { return this.#implementation.admitCoderAttempt(context, preparation); }
    markRunStarted(context: ControlPlaneRunContext, runnerRunId?: string, requestedAt?: string): Promise<void> { return this.#implementation.markRunStarted(context, runnerRunId, requestedAt); }
    renewAttemptLease(context: ControlPlaneRunContext, expiresAt: string, heartbeatAt?: string): Promise<void> { return this.#implementation.renewAttemptLease(context, expiresAt, heartbeatAt); }
    appendToolBoundary(input: {
        context: ControlPlaneRunContext;
        toolUseId: string;
        toolName: string;
        phase: 'started' | 'completed';
        occurredAt?: string;
        payload?: Record<string, unknown>;
    }): Promise<void> { return this.#implementation.appendToolBoundary(input); }
    appendRuntimeEvent<T>(input: RuntimeEventAppendInput<T>): Promise<void> { return this.#implementation.appendRuntimeEvent(input); }
    terminalizeRun(input: TerminalizeRunInput): Promise<void> { return this.#implementation.terminalizeRun(input); }
    interruptRun(input: TerminalizeRunInput): Promise<void> { return this.#implementation.interruptRun(input); }
    getCommand(sessionId: SessionId, commandId: string): Promise<PersistedSessionCommand | null> { return this.#implementation.getCommand(sessionId, commandId); }
    getAttemptState(context: ControlPlaneRunContext, requireActiveLease?: boolean): Promise<{
        command: PersistedSessionCommand;
        run: AgentRun;
        attempt: AgentRunAttempt;
    }> { return this.#implementation.getAttemptState(context, requireActiveLease); }
    getRuntimeRoute(sessionId: SessionId, attemptId: string): Promise<RuntimeRouteRecord | null> { return this.#implementation.getRuntimeRoute(sessionId, attemptId); }
    commitRuntimeRoute(context: ControlPlaneRunContext, route: RuntimeRouteRecord): Promise<RuntimeRouteCommit> { return this.#implementation.commitRuntimeRoute(context, route); }
    commitRuntimeRequest(context: ControlPlaneRunContext, key: string, payload: unknown): Promise<boolean> { return this.#implementation.commitRuntimeRequest(context, key, payload); }
    getRun(sessionId: SessionId, agentRunId: string): Promise<AgentRun | null> { return this.#implementation.getRun(sessionId, agentRunId); }
    recordDivergences(context: Pick<ControlPlaneRunContext, 'sessionId' | 'commandId' | 'agentRunId' | 'correlationId' | 'actor'>, divergences: readonly unknown[]): Promise<void> { return this.#implementation.recordDivergences(context, divergences); }
    recoverInterruptedRuns(reason?: string, occurredAt?: string): Promise<number> { return this.#implementation.recoverInterruptedRuns(reason, occurredAt); }
}
