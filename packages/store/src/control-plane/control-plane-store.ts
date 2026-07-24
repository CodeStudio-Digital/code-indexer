import type DatabaseConstructor from 'better-sqlite3';
import {
  CONTROL_PLANE_EVENT_TYPES,
  CONTROL_PLANE_SCHEMA_VERSION,
  asRuntimeEventId,
  runtimeEventClass,
  type ControlPlaneEventType,
  type RuntimeEventId,
} from '@mcp/agent-runtime-contracts';
import { AgentRunStore } from './agent-run-store.js';
import { CommandLedgerStore } from './command-ledger-store.js';
import { hashControlPlanePayload } from './codec.js';
import { RuntimeJournalStore } from './runtime-journal-store.js';
import type {
  AcceptCommandInput,
  AcceptCommandResult,
  ControlPlaneCommandContext,
  ControlPlaneRunContext,
  RuntimeEventAppendInput,
  TerminalizeRunInput,
} from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function eventId(...parts: string[]): RuntimeEventId {
  return asRuntimeEventId(`evt:${parts.join(':')}`);
}

function commandTerminalType(status: 'succeeded' | 'failed' | 'cancelled'): ControlPlaneEventType {
  return status === 'succeeded'
    ? CONTROL_PLANE_EVENT_TYPES.commandSucceeded
    : status === 'cancelled'
      ? CONTROL_PLANE_EVENT_TYPES.commandCancelled
      : CONTROL_PLANE_EVENT_TYPES.commandFailed;
}

export interface ControlPlaneStoreOptions {
  journalEnabled?: boolean;
}

export function createControlPlaneStore(
  db: DB,
  options: ControlPlaneStoreOptions = {},
): ControlPlaneStore {
  return new ControlPlaneStore(db, options);
}

export class ControlPlaneStore {
  readonly commands: CommandLedgerStore;
  readonly runs: AgentRunStore;
  readonly journal: RuntimeJournalStore;
  private readonly journalEnabled: boolean;

  constructor(private readonly db: DB, options: ControlPlaneStoreOptions = {}) {
    this.commands = new CommandLedgerStore(db);
    this.runs = new AgentRunStore(db);
    this.journal = new RuntimeJournalStore(db);
    this.journalEnabled = options.journalEnabled ?? true;
  }

  private appendJournal<T>(input: RuntimeEventAppendInput<T>): void {
    if (this.journalEnabled) this.journal.append(input);
  }

  private assertCommandContext(context: ControlPlaneCommandContext): void {
    const command = this.commands.get(context.commandId);
    if (!command
      || command.sessionId !== context.sessionId
      || command.correlationId !== context.correlationId
      || (context.legacySessionId !== undefined && command.legacySessionId !== context.legacySessionId)) {
      throw new Error(`Command ${context.commandId} does not match its control-plane context`);
    }
  }

  acceptCommand<T>(input: AcceptCommandInput<T>): AcceptCommandResult {
    const tx = this.db.transaction((): AcceptCommandResult => {
      const { command } = input;
      const canonicalPayloadHash = hashControlPlanePayload(command.payload);
      if (canonicalPayloadHash !== input.payloadHash) {
        throw new Error(`Command ${command.commandId} payload hash is not canonical`);
      }
      const idempotencyKinds = [
        command.kind,
        ...(input.idempotencyKindAliases ?? []).filter((kind) => kind !== command.kind),
      ];
      const existing = idempotencyKinds
        .map((kind) => this.commands.findByIdempotency(command.sessionId, kind, command.idempotencyKey))
        .find((candidate) => candidate != null);
      if (existing) {
        const agentRun = existing.agentRunId ? this.runs.get(existing.agentRunId) ?? undefined : undefined;
        const attempt = agentRun?.activeAttemptId ? this.runs.getAttempt(agentRun.activeAttemptId) ?? undefined : undefined;
        return existing.payloadHash === input.payloadHash
          ? { kind: 'existing', command: existing, agentRun, attempt }
          : { kind: 'payload_conflict', command: existing };
      }

      const sessionRow = this.db.prepare(`
        SELECT version, legacy_session_id FROM control_plane_sessions WHERE session_id = ?
      `).get(command.sessionId) as { version: number; legacy_session_id: number | null } | undefined;
      if (sessionRow && input.legacySessionId !== undefined && sessionRow.legacy_session_id !== input.legacySessionId) {
        throw new Error(`Session ${command.sessionId} is already bound to legacy session ${sessionRow.legacy_session_id}`);
      }
      const currentVersion = sessionRow?.version ?? 0;
      if (command.expectedSessionVersion !== undefined && command.expectedSessionVersion !== currentVersion) {
        return { kind: 'version_conflict', expected: command.expectedSessionVersion, actual: currentVersion };
      }

      const now = new Date().toISOString();
      if (!sessionRow) {
        this.db.prepare(`
          INSERT INTO control_plane_sessions (session_id, legacy_session_id, version, created_at, updated_at)
          VALUES (?, ?, 0, ?, ?)
        `).run(command.sessionId, input.legacySessionId ?? null, now, now);
      }
      const nextVersion = currentVersion + 1;
      const versionUpdate = this.db.prepare(`
        UPDATE control_plane_sessions SET version = ?, updated_at = ?
        WHERE session_id = ? AND version = ?
      `).run(nextVersion, now, command.sessionId, currentVersion);
      if (versionUpdate.changes !== 1) throw new Error(`Session ${command.sessionId} version changed concurrently`);

      const linkedRunId = input.run?.agentRunId ?? input.linkedAgentRunId;
      if (input.linkedAgentRunId) {
        const linkedRun = this.runs.get(input.linkedAgentRunId);
        if (!linkedRun || linkedRun.sessionId !== command.sessionId) {
          throw new Error(`Linked AgentRun ${input.linkedAgentRunId} does not belong to session ${command.sessionId}`);
        }
      }
      let persisted = this.commands.insertAccepted(
        command,
        input.payloadHash,
        nextVersion,
        input.legacySessionId,
        linkedRunId,
      );

      let agentRun;
      let attempt;
      if (input.run) {
        agentRun = this.runs.create(command, input.legacySessionId, input.run);
        attempt = this.runs.createInitialAttempt(agentRun.agentRunId, input.run);
        this.commands.linkAgentRun(command.commandId, agentRun.agentRunId);
        persisted = this.commands.get(command.commandId)!;
      }

      this.appendJournal({
        schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
        eventId: eventId(command.commandId, 'accepted'),
        eventClass: runtimeEventClass(CONTROL_PLANE_EVENT_TYPES.commandAccepted),
        partitionKey: command.sessionId,
        sessionId: command.sessionId,
        legacySessionId: input.legacySessionId,
        commandId: command.commandId,
        agentRunId: linkedRunId,
        attemptId: input.run?.attemptId,
        correlationId: command.correlationId,
        type: CONTROL_PLANE_EVENT_TYPES.commandAccepted,
        occurredAt: command.requestedAt,
        actor: command.actor,
        payload: { kind: command.kind, sessionVersion: nextVersion },
        idempotencyKey: `command:${command.commandId}:accepted`,
        redaction: { policyVersion: 'control-plane-shadow-v1', fields: ['payload'], secretRefs: [] },
      });

      if (agentRun && attempt) {
        this.appendJournal({
          schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
          eventId: eventId(agentRun.agentRunId, 'created'),
          eventClass: runtimeEventClass(CONTROL_PLANE_EVENT_TYPES.agentRunCreated),
          partitionKey: command.sessionId,
          sessionId: command.sessionId,
          legacySessionId: input.legacySessionId,
          commandId: command.commandId,
          agentRunId: agentRun.agentRunId,
          attemptId: attempt.attemptId,
          causationId: command.commandId,
          correlationId: command.correlationId,
          type: CONTROL_PLANE_EVENT_TYPES.agentRunCreated,
          occurredAt: agentRun.createdAt,
          actor: command.actor,
          payload: { role: agentRun.role, waitMode: input.run!.waitMode, status: agentRun.status },
          idempotencyKey: `agent-run:${agentRun.agentRunId}:created`,
          redaction: { policyVersion: 'control-plane-shadow-v1', fields: [], secretRefs: [] },
        });
      }

      return { kind: 'accepted', command: persisted, agentRun, attempt };
    });
    return tx.immediate();
  }

  markRunStarted(context: ControlPlaneRunContext, runnerRunId?: string, requestedAt?: string): void {
    const occurredAt = requestedAt ?? this.runs.get(context.agentRunId)?.startedAt ?? new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.runs.markAttemptRunning(context, runnerRunId, occurredAt);
      this.runs.transition(context, 'running', { at: occurredAt });
      this.commands.markRunning(context.commandId, occurredAt);
      this.appendJournal({
        schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
        eventId: eventId(context.agentRunId, 'started'),
        eventClass: runtimeEventClass(CONTROL_PLANE_EVENT_TYPES.agentRunStarted),
        partitionKey: context.sessionId,
        sessionId: context.sessionId,
        legacySessionId: context.legacySessionId,
        commandId: context.commandId,
        agentRunId: context.agentRunId,
        attemptId: context.attemptId,
        causationId: context.commandId,
        correlationId: context.correlationId,
        type: CONTROL_PLANE_EVENT_TYPES.agentRunStarted,
        occurredAt,
        actor: context.actor,
        payload: { runnerRunId: runnerRunId ?? null },
        idempotencyKey: `agent-run:${context.agentRunId}:started`,
        redaction: { policyVersion: 'control-plane-shadow-v1', fields: [], secretRefs: [] },
      });
    });
    tx.immediate();
  }

  bindCommandExecution(
    context: ControlPlaneCommandContext,
    busId: string,
    occurredAt = new Date().toISOString(),
  ): void {
    const tx = this.db.transaction(() => {
      this.assertCommandContext(context);
      this.commands.bindExecution(context.commandId, { busId }, occurredAt);
    });
    tx.immediate();
  }

  appendToolBoundary(input: {
    context: ControlPlaneRunContext;
    toolUseId: string;
    toolName: string;
    phase: 'started' | 'completed';
    occurredAt?: string;
    payload: Record<string, unknown>;
  }): void {
    if (!this.journalEnabled) return;
    const type = input.phase === 'started'
      ? CONTROL_PLANE_EVENT_TYPES.toolInvocationStarted
      : CONTROL_PLANE_EVENT_TYPES.toolInvocationCompleted;
    const id = eventId(input.context.agentRunId, 'tool', input.toolUseId, input.phase);
    const occurredAt = input.occurredAt ?? this.journal.get(id)?.occurredAt ?? new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.runs.assertContext(input.context, { requireActiveLease: true, at: occurredAt });
      this.appendJournal({
      schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      eventId: id,
      eventClass: runtimeEventClass(type),
      partitionKey: input.context.sessionId,
      sessionId: input.context.sessionId,
      legacySessionId: input.context.legacySessionId,
      commandId: input.context.commandId,
      agentRunId: input.context.agentRunId,
      attemptId: input.context.attemptId,
      toolUseId: input.toolUseId as never,
      causationId: input.context.commandId,
      correlationId: input.context.correlationId,
      type,
      occurredAt,
      actor: input.context.actor,
      payload: { toolName: input.toolName, ...input.payload },
      idempotencyKey: `tool:${input.context.agentRunId}:${input.toolUseId}:${input.phase}`,
      redaction: { policyVersion: 'control-plane-shadow-v1', fields: ['input', 'result'], secretRefs: [] },
      });
    });
    tx.immediate();
  }

  terminalizeCommand(input: {
    context: ControlPlaneCommandContext;
    status: 'succeeded' | 'failed' | 'cancelled';
    reason: string;
    errorRef?: string;
    agentRunId?: string;
    occurredAt?: string;
  }): void {
    const occurredAt = input.occurredAt
      ?? this.commands.get(input.context.commandId)?.completedAt
      ?? new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.assertCommandContext(input.context);
      this.commands.markTerminal(input.context.commandId, input.status, {
        reasonCode: input.reason,
        errorRef: input.errorRef,
        completedAt: occurredAt,
      });
      const type = commandTerminalType(input.status);
      this.appendJournal({
        schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
        eventId: eventId(input.context.commandId, 'terminal'),
        eventClass: runtimeEventClass(type),
        partitionKey: input.context.sessionId,
        sessionId: input.context.sessionId,
        legacySessionId: input.context.legacySessionId,
        commandId: input.context.commandId,
        agentRunId: input.agentRunId as never,
        causationId: input.context.commandId,
        correlationId: input.context.correlationId,
        type,
        occurredAt,
        actor: input.context.actor,
        payload: { status: input.status, reason: input.reason, errorRef: input.errorRef ?? null },
        idempotencyKey: `command:${input.context.commandId}:terminal`,
        redaction: { policyVersion: 'control-plane-shadow-v1', fields: [], secretRefs: [] },
      });
    });
    tx.immediate();
  }

  recoverInterruptedRuns(reason = 'process-restart', occurredAt = new Date().toISOString()): number {
    let recovered = 0;
    for (const attempt of this.runs.listActiveAttempts(10_000)) {
      const run = this.runs.get(attempt.agentRunId);
      if (!run || run.status === 'completed' || run.status === 'failed' || run.status === 'aborted' || run.status === 'interrupted') continue;
      const command = this.commands.get(run.commandId);
      if (!command) continue;
      this.terminalizeRunInternal({
        context: {
          sessionId: run.sessionId,
          legacySessionId: command.legacySessionId,
          commandId: run.commandId,
          agentRunId: run.agentRunId,
          attemptId: attempt.attemptId,
          correlationId: command.correlationId,
          actor: { actorId: 'control-plane-recovery', actorType: 'system', source: 'recovery' },
          executorOwnerId: attempt.executorLease.ownerId,
          fencingEpoch: attempt.executorLease.fencingEpoch,
        },
        status: 'interrupted',
        commandStatus: 'failed',
        reason,
        attemptLeaseStatus: 'fenced',
        occurredAt,
      }, true);
      recovered += 1;
    }
    return recovered;
  }

  terminalizeRun(input: TerminalizeRunInput): void {
    this.terminalizeRunInternal(input, false);
  }

  interruptRun(input: TerminalizeRunInput): void {
    if (input.status !== 'interrupted' || input.commandStatus !== 'failed') {
      throw new Error('Authoritative interruption requires interrupted/failed terminal states');
    }
    this.terminalizeRunInternal({ ...input, attemptLeaseStatus: 'fenced' }, true);
  }

  private terminalizeRunInternal(input: TerminalizeRunInput, recovery: boolean): void {
    const command = this.commands.get(input.context.commandId);
    const terminalizesCommand = command?.agentRunId === input.context.agentRunId;
    const occurredAt = input.occurredAt
      ?? this.runs.get(input.context.agentRunId)?.finishedAt
      ?? command?.completedAt
      ?? new Date().toISOString();
    const tx = this.db.transaction(() => {
      if (recovery) {
        this.runs.recoverInterrupted(input.context, input.reason, occurredAt);
      } else {
        this.runs.transition(input.context, input.status, {
          terminalReason: input.reason,
          transcriptRef: input.transcriptRef,
          errorRef: input.errorRef,
          at: occurredAt,
        });
        this.runs.terminalizeAttempt(
          input.context,
          input.reason,
          input.errorRef,
          occurredAt,
          input.attemptLeaseStatus ?? 'released',
        );
      }
      // A command owns exactly one root AgentRun. Fase-3 child runs share that
      // command as their causal turn (D-018), so child completion/recovery must
      // never terminalize the root command.
      if (terminalizesCommand) {
        this.commands.markTerminal(input.context.commandId, input.commandStatus, {
          reasonCode: input.reason,
          errorRef: input.errorRef,
          completedAt: occurredAt,
        });
      }
      if (input.transcriptRef) {
        this.appendJournal({
          schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
          eventId: eventId(input.context.agentRunId, 'transcript-persisted'),
          eventClass: runtimeEventClass(CONTROL_PLANE_EVENT_TYPES.transcriptPersisted),
          partitionKey: input.context.sessionId,
          sessionId: input.context.sessionId,
          legacySessionId: input.context.legacySessionId,
          commandId: input.context.commandId,
          agentRunId: input.context.agentRunId,
          attemptId: input.context.attemptId,
          causationId: input.context.commandId,
          correlationId: input.context.correlationId,
          type: CONTROL_PLANE_EVENT_TYPES.transcriptPersisted,
          occurredAt,
          actor: input.context.actor,
          payload: { transcriptRef: input.transcriptRef },
          idempotencyKey: `agent-run:${input.context.agentRunId}:transcript-persisted`,
          redaction: { policyVersion: 'control-plane-shadow-v1', fields: [], secretRefs: [] },
        });
      }
      const terminalType = input.status === 'completed'
        ? CONTROL_PLANE_EVENT_TYPES.agentRunCompleted
        : input.status === 'aborted'
          ? CONTROL_PLANE_EVENT_TYPES.agentRunAborted
          : input.status === 'interrupted'
            ? CONTROL_PLANE_EVENT_TYPES.agentRunInterrupted
            : CONTROL_PLANE_EVENT_TYPES.agentRunFailed;
      this.appendJournal({
        schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
        eventId: eventId(input.context.agentRunId, 'terminal'),
        eventClass: runtimeEventClass(terminalType),
        partitionKey: input.context.sessionId,
        sessionId: input.context.sessionId,
        legacySessionId: input.context.legacySessionId,
        commandId: input.context.commandId,
        agentRunId: input.context.agentRunId,
        attemptId: input.context.attemptId,
        causationId: input.context.commandId,
        correlationId: input.context.correlationId,
        type: terminalType,
        occurredAt,
        actor: input.context.actor,
        payload: { status: input.status, reason: input.reason, errorRef: input.errorRef ?? null },
        idempotencyKey: `agent-run:${input.context.agentRunId}:terminal`,
        redaction: { policyVersion: 'control-plane-shadow-v1', fields: [], secretRefs: [] },
      });
      if (terminalizesCommand) {
        const commandType = commandTerminalType(input.commandStatus);
        this.appendJournal({
          schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
          eventId: eventId(input.context.commandId, 'terminal'),
          eventClass: runtimeEventClass(commandType),
          partitionKey: input.context.sessionId,
          sessionId: input.context.sessionId,
          legacySessionId: input.context.legacySessionId,
          commandId: input.context.commandId,
          agentRunId: input.context.agentRunId,
          attemptId: input.context.attemptId,
          causationId: input.context.commandId,
          correlationId: input.context.correlationId,
          type: commandType,
          occurredAt,
          actor: input.context.actor,
          payload: { status: input.commandStatus, reason: input.reason, errorRef: input.errorRef ?? null },
          idempotencyKey: `command:${input.context.commandId}:terminal`,
          redaction: { policyVersion: 'control-plane-shadow-v1', fields: [], secretRefs: [] },
        });
      }
    });
    tx.immediate();
  }
}
