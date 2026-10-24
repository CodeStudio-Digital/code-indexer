import { createHash, randomUUID } from 'node:crypto';
import { commitCoderAttemptPreparation, preparationId } from './coder-attempt-admission.js';
import { commitRuntimeRoute, commitRuntimeRequest, assertNoRuntimeCancellation } from './runtime-attempt-ledger.js';
import { readNativeInbox, type NativeInboxSource, type NativeTreeInboxEntry } from './native-tree-inbox.js';
import { hashControlPlanePayload } from '@mcp/store/control-plane/index.js';
import { resolveNativeChildSessionRoot, parseNativeChildTranscriptRef } from './native-child-storage.js';
import { resolveNativeChildReference, type NativeChildCompletionAuthority } from './native-child-reference-authority.js';
import type { DurableSupervisorFactPort, PreparedDurabilityPort, RuntimeRouteCommit, RuntimeRouteRecord } from '@mcp/agent-runtime-host';
import { assertSupervisorCommitLive, commitSupervisorFact, supervisorFactRecord } from './supervisor-fact-ledger.js';
import { assertPreparedWorkspaceLease, commitNativePreparation, copyNativePreparation, nativeRecordId, validateNativePreparation,
  type NativeAttemptAdmission, type NativeAttemptPreparationInput } from './native-attempt-preparation.js';
import { assertNativeActivationLive, commitNativeActivation, copyPreparedFacts } from './native-attempt-activation.js';
import type { NativeWorkspaceLease } from './native-workspace-leases.js';
import { admitNativeChild, nativeTreeId, type NativeTreeData, type NativeChildRequest, type NativeChildAdmission } from './native-child-admission.js';
import { assertNativeChildCurrent, assertNativeChildPreparation } from './native-child-authority.js';
import {
  CONTROL_PLANE_EVENT_TYPES,
  CONTROL_PLANE_SCHEMA_VERSION,
  agentV1Common,
  agentV1Supervisor,
  asRuntimeEventId,
  asSessionId,
  canTransitionAgentRun,
  runtimeEventClass,
  type AgentRun,
  type AgentRunAttempt,
  type CoderAttemptAdmissionV1,
  type CoderAttemptPreparationV1,
  type RuntimeEventEnvelopeV1,
  type SessionCommandStatus,
  type SessionId,
} from '@mcp/agent-runtime-contracts';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import type { VerifiedRuntimePackage } from '@mcp/agent-runtime-host';
import {
  ControlPlaneFileRepository,
  type ControlPlaneEntityDataMap,
  type ControlPlaneEntityKind,
  type EntityRecord,
  type JsonValue,
} from '@mcp/session-storage';
import type {
  AcceptCommandInput,
  AcceptCommandResult,
  ControlPlaneCommandContext,
  ControlPlaneRunContext,
  PersistedSessionCommand,
  RuntimeEventAppendInput,
  TerminalizeRunInput,
} from '@mcp/store/control-plane/index.js';

export interface FileControlPlaneAuthority {
  readNativeContinuationInbox(owner: ControlPlaneRunContext, source: NativeInboxSource): Promise<NativeTreeInboxEntry[]>;
  readonly journalEnabled: boolean;
  createSupervisorFactPort(context: ControlPlaneRunContext, connectionId: string): DurableSupervisorFactPort;
  admitNativeAttempt(context: ControlPlaneRunContext, input: NativeAttemptPreparationInput): Promise<NativeAttemptAdmission>;
  admitNativeChild(context: ControlPlaneRunContext, input: NativeChildRequest): Promise<NativeChildAdmission>;
  resolveNativeChild(root: ControlPlaneRunContext, agentRunId: string, requireActiveLease?: boolean): Promise<ControlPlaneRunContext>;
  resolveNativeChildTranscript(owner: ControlPlaneRunContext, reference: string, requireActiveOwner?: boolean): Promise<ControlPlaneRunContext>;
  resolveNativeChildCompletion(owner: ControlPlaneRunContext, reference: string): Promise<NativeChildCompletionAuthority>;
  resolveSessionChildTranscript(sessionId: SessionId, reference: string): Promise<ControlPlaneRunContext>;
  assertNativeWorkspaceLease(context: ControlPlaneRunContext, lease: NativeWorkspaceLease): Promise<void>;
  createNativeActivationPort(context: ControlPlaneRunContext, activationNonce: Uint8Array): PreparedDurabilityPort;
  getAttemptState(context: ControlPlaneRunContext, requireActiveLease?: boolean): Promise<{
    command: PersistedSessionCommand; run: AgentRun; attempt: AgentRunAttempt;
  }>;
  getRuntimeRoute(sessionId: SessionId, attemptId: string): Promise<RuntimeRouteRecord | null>;
  commitRuntimeRoute(context: ControlPlaneRunContext, route: RuntimeRouteRecord): Promise<RuntimeRouteCommit>;
  commitRuntimeRequest(context: ControlPlaneRunContext, key: string, payload: unknown): Promise<boolean>;
  admitCoderAttempt(context: ControlPlaneRunContext, preparation: CoderAttemptPreparationV1): Promise<CoderAttemptAdmissionV1>;
  acceptCommand<T>(input: AcceptCommandInput<T>): Promise<AcceptCommandResult>;
  bindCommandExecution(
    context: ControlPlaneCommandContext,
    busId: string,
    occurredAt?: string,
  ): Promise<void>;
  terminalizeCommand(input: {
    context: ControlPlaneCommandContext;
    status: Extract<SessionCommandStatus, 'succeeded' | 'failed' | 'cancelled'>;
    reason: string;
    errorRef?: string;
    result?: unknown;
    occurredAt?: string;
    /** HTTP observer only: an already committed worker terminal wins. */
    preserveExistingTerminal?: boolean;
  }): Promise<void>;
  markRunStarted(
    context: ControlPlaneRunContext,
    runnerRunId?: string,
    requestedAt?: string,
  ): Promise<void>;
  renewAttemptLease(
    context: ControlPlaneRunContext,
    expiresAt: string,
    heartbeatAt?: string,
  ): Promise<void>;
  appendToolBoundary(input: {
    context: ControlPlaneRunContext;
    toolUseId: string;
    toolName: string;
    phase: 'started' | 'completed';
    occurredAt?: string;
    payload?: Record<string, unknown>;
  }): Promise<void>;
  appendRuntimeEvent<T>(input: RuntimeEventAppendInput<T>): Promise<void>;
  terminalizeRun(input: TerminalizeRunInput): Promise<void>;
  interruptRun(input: TerminalizeRunInput): Promise<void>;
  getCommand(
    sessionId: SessionId,
    commandId: string,
  ): Promise<PersistedSessionCommand | null>;
  getRun(
    sessionId: SessionId,
    agentRunId: string,
  ): Promise<AgentRun | null>;
  recordDivergences(
    context: Pick<
      ControlPlaneRunContext,
      | 'sessionId'
      | 'commandId'
      | 'agentRunId'
      | 'correlationId'
      | 'actor'
    >,
    divergences: readonly unknown[],
  ): Promise<void>;
  recoverInterruptedRuns(
    reason?: string,
    occurredAt?: string,
    options?: { nativeOnly?: boolean },
  ): Promise<number>;
}

interface StoredCommandData extends Record<string, unknown> {
  commandType: string;
  status: string;
  inputHash?: string;
  command: PersistedSessionCommand;
}

interface StoredRunData extends Record<string, unknown> {
  status: string;
  run: AgentRun;
}

interface StoredAttemptData extends Record<string, unknown> {
  ordinal: number;
  status: string;
  attempt: AgentRunAttempt;
}

const TERMINAL_COMMAND_STATUSES = new Set<SessionCommandStatus>([
  'succeeded',
  'rejected',
  'cancelled',
  'failed',
]);
const TERMINAL_RUN_STATUSES = new Set<AgentRun['status']>([
  'completed',
  'failed',
  'aborted',
  'interrupted',
]);

function cleanJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(
    createHash('sha256').update(value).digest('hex').slice(0, 32),
    'hex',
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function eventId(...parts: string[]): ReturnType<typeof asRuntimeEventId> {
  return asRuntimeEventId(deterministicUuid(parts.join('\0')));
}

function commandData(
  command: PersistedSessionCommand,
): ControlPlaneEntityDataMap['command'] {
  return cleanJson({
    commandType: command.kind,
    status: command.status,
    inputHash: command.payloadHash,
    command,
  } satisfies StoredCommandData);
}

function runData(run: AgentRun): ControlPlaneEntityDataMap['run'] {
  return cleanJson({
    status: run.status,
    run,
  } satisfies StoredRunData);
}

function attemptData(
  attempt: AgentRunAttempt,
): ControlPlaneEntityDataMap['attempt'] {
  return cleanJson({
    ordinal: attempt.ordinal,
    status: attempt.status,
    attempt,
  } satisfies StoredAttemptData);
}

function persistedCommand(
  record: EntityRecord<ControlPlaneEntityDataMap['command']> | null,
): PersistedSessionCommand | null {
  if (!record) return null;
  const command = (record.data as unknown as StoredCommandData).command;
  return command ? cleanJson(command) : null;
}

function persistedRun(
  record: EntityRecord<ControlPlaneEntityDataMap['run']> | null,
): AgentRun | null {
  if (!record) return null;
  const run = (record.data as unknown as StoredRunData).run;
  return run ? cleanJson(run) : null;
}

function persistedAttempt(
  record: EntityRecord<ControlPlaneEntityDataMap['attempt']> | null,
): AgentRunAttempt | null {
  if (!record) return null;
  const attempt = (record.data as unknown as StoredAttemptData).attempt;
  return attempt ? cleanJson(attempt) : null;
}

function iso(value = new Date().toISOString()): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError(`Invalid control-plane timestamp ${value}`);
  }
  return parsed.toISOString();
}

function leaseExpired(expiresAt: string, at: string): boolean {
  return Date.parse(expiresAt) <= Date.parse(at);
}

/**
 * Host-owned control-plane authority stored inside each session bundle.
 *
 * There is intentionally no SQLite handle, compatibility lookup or persistent
 * global index here. Every operation first resolves the UUID through the
 * in-memory SessionCatalog and then mutates independent JSON records below that
 * bundle.
 */
export class FileControlPlaneStore implements FileControlPlaneAuthority {
  readonly journalEnabled: boolean;

  readonly #sessions: FsSessionStore;
  readonly #repositories = new Map<string, ControlPlaneFileRepository>();
  #recoveryPromise: Promise<number> | null = null;
  readonly #nativeRecovery?: {
    isPresent(): Promise<boolean>;
    sessionIds?(): Promise<ReadonlySet<string>>;
    load(): Promise<{ rootPath: string; runtimePackage: VerifiedRuntimePackage }>;
  };

  constructor(
    sessions: FsSessionStore,
    options: { journalEnabled?: boolean; nativeRecovery?: {
      isPresent(): Promise<boolean>;
      sessionIds?(): Promise<ReadonlySet<string>>;
      load(): Promise<{ rootPath: string; runtimePackage: VerifiedRuntimePackage }>;
    } } = {},
  ) {
    this.#sessions = sessions;
    this.journalEnabled = options.journalEnabled ?? true;
    this.#nativeRecovery = options.nativeRecovery;
  }

  async #repository(sessionId: SessionId | string): Promise<ControlPlaneFileRepository> {
    const key = String(sessionId).toLowerCase();
    const cached = this.#repositories.get(key);
    if (cached) return cached;
    const location = await this.#sessions.getSessionLocation(asSessionId(key));
    if (!location) throw new Error(`Unknown filesystem session ${key}`);
    await this.#sessions.locator.assertSafeLocation(location, {
      mustExist: true,
    });
    const repository = new ControlPlaneFileRepository({
      sessionRoot: location.bundle_path,
    });
    this.#repositories.set(key, repository);
    return repository;
  }

  #enqueue<T>(sessionId: SessionId | string, task: () => Promise<T>): Promise<T> {
    return this.#sessions.runSessionMutation(sessionId, task);
  }

  async #listAll<K extends ControlPlaneEntityKind>(
    repository: ControlPlaneFileRepository,
    kind: K,
  ): Promise<Array<EntityRecord<ControlPlaneEntityDataMap[K]>>> {
    const items: Array<EntityRecord<ControlPlaneEntityDataMap[K]>> = [];
    let cursor: string | undefined;
    do {
      const page = await repository.list(kind, {
        cursor,
        limit: 1_000,
        order: 'asc',
      });
      items.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return items;
  }

  async #appendRuntimeEventUnlocked<T>(
    repository: ControlPlaneFileRepository,
    input: RuntimeEventAppendInput<T>,
  ): Promise<void> {
    if (!this.journalEnabled) return;
    const recordedAt = iso(input.recordedAt ?? new Date().toISOString());
    const envelope: RuntimeEventEnvelopeV1<T> = cleanJson({
      ...input,
      globalSeq: 0,
      recordedAt,
      payloadHash:
        input.payloadHash ??
        createHash('sha256').update(JSON.stringify(input.payload)).digest('hex'),
    });
    await repository.appendEvent({
      id: String(input.eventId),
      operationId: String(input.eventId),
      createdAt: input.occurredAt,
      updatedAt: recordedAt,
      relations: cleanJson({
        session: input.sessionId,
        ...(input.commandId ? { command: input.commandId } : {}),
        ...(input.agentRunId ? { run: input.agentRunId } : {}),
        ...(input.attemptId ? { attempt: input.attemptId } : {}),
      }),
      data: cleanJson({
        eventType: input.type,
        payload: cleanJson(input.payload) as unknown as JsonValue,
        envelope,
      }),
    });
  }

  async #updateCommand(
    repository: ControlPlaneFileRepository,
    command: PersistedSessionCommand,
  ): Promise<PersistedSessionCommand> {
    await repository.update('command', String(command.commandId), {
      operationId: randomUUID(),
      updatedAt: command.updatedAt,
      relations: cleanJson({
        session: command.sessionId,
        ...(command.agentRunId ? { run: command.agentRunId } : {}),
      }),
      data: commandData(command),
    });
    return command;
  }

  async #updateRun(
    repository: ControlPlaneFileRepository,
    run: AgentRun,
  ): Promise<AgentRun> {
    await repository.update('run', String(run.agentRunId), {
      operationId: randomUUID(),
      updatedAt:
        run.finishedAt ?? run.startedAt ?? run.createdAt,
      relations: cleanJson({
        session: run.sessionId,
        command: run.commandId,
        ...(run.parentAgentRunId ? { parent: run.parentAgentRunId } : {}),
      }),
      data: runData(run),
    });
    return run;
  }

  async #updateAttempt(
    repository: ControlPlaneFileRepository,
    attempt: AgentRunAttempt,
    sessionId: SessionId,
  ): Promise<AgentRunAttempt> {
    await repository.update('attempt', String(attempt.attemptId), {
      operationId: randomUUID(),
      updatedAt:
        attempt.finishedAt ??
        attempt.executorLease.heartbeatAt ??
        attempt.startedAt,
      relations: {
        session: sessionId,
        run: attempt.agentRunId,
      },
      data: attemptData(attempt),
    });
    return attempt;
  }

  async #command(
    repository: ControlPlaneFileRepository,
    commandId: string,
  ): Promise<PersistedSessionCommand | null> {
    return persistedCommand(await repository.get('command', commandId));
  }

  async #run(
    repository: ControlPlaneFileRepository,
    runId: string,
  ): Promise<AgentRun | null> {
    return persistedRun(await repository.get('run', runId));
  }

  async #attempt(
    repository: ControlPlaneFileRepository,
    attemptId: string,
  ): Promise<AgentRunAttempt | null> {
    return persistedAttempt(await repository.get('attempt', attemptId));
  }

  async #assertCommandContext(
    repository: ControlPlaneFileRepository,
    context: ControlPlaneCommandContext,
  ): Promise<PersistedSessionCommand> {
    const command = await this.#command(repository, String(context.commandId));
    if (
      !command ||
      command.sessionId !== context.sessionId ||
      command.correlationId !== context.correlationId
    ) {
      throw new Error(
        `Command ${context.commandId} does not match its control-plane context`,
      );
    }
    return command;
  }

  async #assertRunContext(
    repository: ControlPlaneFileRepository,
    context: ControlPlaneRunContext,
    options: { requireActiveLease?: boolean; at?: string } = {},
  ): Promise<{
    command: PersistedSessionCommand;
    run: AgentRun;
    attempt: AgentRunAttempt;
  }> {
    const command = await this.#assertCommandContext(repository, context);
    const run = await this.#run(repository, String(context.agentRunId));
    const attempt = await this.#attempt(repository, String(context.attemptId));
    if (!run || !attempt) {
      throw new Error(`Missing run/attempt for ${context.agentRunId}`);
    }
    if (
      run.sessionId !== context.sessionId ||
      run.commandId !== context.commandId ||
      run.activeAttemptId !== context.attemptId ||
      attempt.agentRunId !== context.agentRunId ||
      attempt.executorLease.ownerId !== context.executorOwnerId ||
      attempt.executorLease.fencingEpoch !== context.fencingEpoch
    ) {
      throw new Error(`Run ${context.agentRunId} is fenced or context-mismatched`);
    }
    const directRoot = command.agentRunId === context.agentRunId;
    const childOfRoot =
      command.agentRunId != null &&
      (run.parentAgentRunId === command.agentRunId ||
        run.ownerAgentRunId === command.agentRunId);
    if (!directRoot && !childOfRoot) {
      throw new Error(`Run ${context.agentRunId} is not linked to its command`);
    }
    if (options.requireActiveLease !== false) {
      const at = iso(options.at ?? new Date().toISOString());
      if (
        attempt.status === 'terminal' ||
        attempt.executorLease.status !== 'active' ||
        leaseExpired(attempt.executorLease.expiresAt, at)
      ) {
        throw new Error(`Run ${context.agentRunId} executor lease is not active`);
      }
      if (!directRoot && command.agentRunId) {
        const root = await this.#run(repository, command.agentRunId);
        const rootRoute = root?.activeAttemptId ? (await repository.get('runtimeRoute', root.activeAttemptId))?.data.route as RuntimeRouteRecord | undefined : undefined;
        const ownRoute = (await repository.get('runtimeRoute', attempt.attemptId))?.data.route as RuntimeRouteRecord | undefined;
        if (rootRoute?.runtimeGeneration === 'rust_v1' || ownRoute?.runtimeGeneration === 'rust_v1') {
          await assertNativeChildCurrent(repository, context, { command, run, attempt });
        }
      }
    }
    return { command, run, attempt };
  }

  async acceptCommand<T>(
    input: AcceptCommandInput<T>,
  ): Promise<AcceptCommandResult> {
    if (this.#recoveryPromise) await this.#recoveryPromise;
    return this.#enqueue(input.command.sessionId, async () => {
      const repository = await this.#repository(input.command.sessionId);
      const aliases = new Set([
        input.command.kind,
        ...(input.idempotencyKindAliases ?? []),
      ]);
      const commands = await this.#listAll(repository, 'command');
      const existing = commands
        .map(persistedCommand)
        .find(
          (candidate) =>
            candidate != null &&
            aliases.has(candidate.kind) &&
            candidate.idempotencyKey === input.command.idempotencyKey,
        );
      if (existing) {
        if (existing.payloadHash !== input.payloadHash) {
          return { kind: 'payload_conflict', command: existing };
        }
        const agentRun = existing.agentRunId
          ? (await this.#run(repository, String(existing.agentRunId))) ?? undefined
          : undefined;
        const attempt = agentRun?.activeAttemptId
          ? (await this.#attempt(repository, String(agentRun.activeAttemptId))) ??
            undefined
          : undefined;
        return { kind: 'existing', command: existing, agentRun, attempt };
      }

      const currentVersion = commands.reduce(
        (max, record) =>
          Math.max(max, persistedCommand(record)?.sessionVersion ?? 0),
        0,
      );
      if (
        input.command.expectedSessionVersion !== undefined &&
        input.command.expectedSessionVersion !== currentVersion
      ) {
        return {
          kind: 'version_conflict',
          expected: input.command.expectedSessionVersion,
          actual: currentVersion,
        };
      }
      if (input.linkedAgentRunId) {
        const linked = await this.#run(repository, String(input.linkedAgentRunId));
        if (!linked || linked.sessionId !== input.command.sessionId) {
          throw new Error(
            `Linked AgentRun ${input.linkedAgentRunId} does not belong to session ${input.command.sessionId}`,
          );
        }
      }

      const now = new Date().toISOString();
      const linkedRunId = input.run?.agentRunId ?? input.linkedAgentRunId;
      let command: PersistedSessionCommand = cleanJson({
        commandId: input.command.commandId,
        schemaVersion: input.command.schemaVersion,
        sessionId: input.command.sessionId,
        idempotencyKey: input.command.idempotencyKey,
        kind: input.command.kind,
        payloadHash: input.payloadHash,
        status: 'accepted',
        actor: input.command.actor,
        expectedSessionVersion: input.command.expectedSessionVersion,
        sessionVersion: currentVersion + 1,
        correlationId: input.command.correlationId,
        agentRunId: linkedRunId,
        requestedAt: input.command.requestedAt,
        deadlineAt: input.command.deadlineAt,
        createdAt: now,
        updatedAt: now,
      });
      await repository.createCommand({
        id: String(command.commandId),
        operationId: String(command.commandId),
        createdAt: now,
        relations: cleanJson({
          session: command.sessionId,
          ...(linkedRunId ? { run: linkedRunId } : {}),
        }),
        data: commandData(command),
      });

      let agentRun: AgentRun | undefined;
      let attempt: AgentRunAttempt | undefined;
      if (input.run) {
        agentRun = cleanJson({
          agentRunId: input.run.agentRunId,
          specVersion: 1,
          sessionId: input.command.sessionId,
          commandId: input.command.commandId,
          ownerAgentRunId: input.run.ownerAgentRunId,
          parentAgentRunId: input.run.parentAgentRunId,
          spawnDepth: input.run.spawnDepth ?? 0,
          role: input.run.role,
          status: 'starting',
          effectiveProvider: input.run.effectiveProvider,
          effectiveModel: input.run.effectiveModel,
          effectiveReasoningEffort: input.run.effectiveReasoningEffort,
          effectivePreset: input.run.effectivePreset,
          downgradeReasons: input.run.downgradeReasons ?? [],
          capabilitySetRef: input.run.capabilitySetRef,
          environmentId: input.run.environmentId,
          activeAttemptId: input.run.attemptId,
          presetResolutionRef: input.run.presetResolutionRef,
          policySnapshotRef: input.run.policySnapshotRef,
          createdAt: now,
          version: 1,
        });
        attempt = cleanJson({
          attemptId: input.run.attemptId,
          agentRunId: input.run.agentRunId,
          ordinal: 1,
          trigger: input.command.kind === 'resume' ? 'resume' : 'initial',
          executorLease: {
            ownerId: input.run.executorOwnerId,
            fencingEpoch: 1,
            status: 'active',
            acquiredAt: now,
            heartbeatAt: now,
            expiresAt: input.run.executorExpiresAt,
          },
          status: 'starting',
          providerRequestRefs: [],
          startedAt: now,
          version: 1,
        });
        await repository.createRun({
          id: String(agentRun.agentRunId),
          operationId: String(agentRun.agentRunId),
          createdAt: now,
          relations: {
            session: command.sessionId,
            command: command.commandId,
            ...(agentRun.parentAgentRunId
              ? { parent: agentRun.parentAgentRunId }
              : {}),
          },
          data: runData(agentRun),
        });
        await repository.createAttempt({
          id: String(attempt.attemptId),
          operationId: String(attempt.attemptId),
          createdAt: now,
          relations: {
            session: command.sessionId,
            run: agentRun.agentRunId,
          },
          data: attemptData(attempt),
        });
        command = {
          ...command,
          agentRunId: agentRun.agentRunId,
          updatedAt: now,
        };
        await this.#updateCommand(repository, command);
      }

      await this.#appendRuntimeEventUnlocked(repository, {
        schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
        eventId: eventId(String(command.commandId), 'accepted'),
        eventClass: runtimeEventClass(
          CONTROL_PLANE_EVENT_TYPES.commandAccepted,
        ),
        partitionKey: command.sessionId,
        sessionId: command.sessionId,
        commandId: command.commandId,
        agentRunId: linkedRunId,
        attemptId: input.run?.attemptId,
        correlationId: command.correlationId,
        type: CONTROL_PLANE_EVENT_TYPES.commandAccepted,
        occurredAt: command.requestedAt,
        actor: command.actor,
        payload: {
          kind: command.kind,
          sessionVersion: command.sessionVersion,
        },
        idempotencyKey: `command:${command.commandId}:accepted`,
        redaction: {
          policyVersion: 'control-plane-fs-v1',
          fields: ['payload'],
          secretRefs: [],
        },
      });
      return { kind: 'accepted', command, agentRun, attempt };
    });
  }

  async bindCommandExecution(
    context: ControlPlaneCommandContext,
    busId: string,
    occurredAt = new Date().toISOString(),
  ): Promise<void> {
    await this.#enqueue(context.sessionId, async () => {
      const repository = await this.#repository(context.sessionId);
      const current = await this.#assertCommandContext(repository, context);
      const existingBus =
        current.result &&
        typeof current.result === 'object' &&
        typeof (current.result as { busId?: unknown }).busId === 'string'
          ? (current.result as { busId: string }).busId
          : undefined;
      if (current.status === 'running' && existingBus === busId) return;
      // Worker admission can durably activate before HTTP binds its SSE bus.
      // Allow the first binding in either state; never replace an existing bus.
      if (existingBus || (current.status !== 'accepted' && current.status !== 'running')) {
        throw new Error(
          `Command ${context.commandId} cannot bind from ${current.status}`,
        );
      }
      await this.#updateCommand(repository, {
        ...current,
        status: 'running',
        result: { busId },
        updatedAt: iso(occurredAt),
      });
    });
  }

  async terminalizeCommand(input: {
    context: ControlPlaneCommandContext;
    status: Extract<SessionCommandStatus, 'succeeded' | 'failed' | 'cancelled'>;
    reason: string;
    errorRef?: string;
    result?: unknown;
    occurredAt?: string;
    preserveExistingTerminal?: boolean;
  }): Promise<void> {
    await this.#enqueue(input.context.sessionId, async () => {
      const repository = await this.#repository(input.context.sessionId);
      const current = await this.#assertCommandContext(
        repository,
        input.context,
      );
      if (input.preserveExistingTerminal && TERMINAL_COMMAND_STATUSES.has(current.status)) return;
      if (
        TERMINAL_COMMAND_STATUSES.has(current.status) &&
        current.status !== input.status
      ) {
        throw new Error(
          `Command ${input.context.commandId} already terminal as ${current.status}`,
        );
      }
      if (current.reasonCode && current.reasonCode !== input.reason) {
        throw new Error(`Command ${input.context.commandId} reason differs`);
      }
      const at = iso(input.occurredAt ?? new Date().toISOString());
      const command = await this.#updateCommand(repository, cleanJson({
        ...current,
        status: input.status,
        reasonCode: current.reasonCode ?? input.reason,
        errorRef: current.errorRef ?? input.errorRef,
        result: current.result ?? input.result,
        completedAt: current.completedAt ?? at,
        updatedAt: at,
      }));
      await this.#appendRuntimeEventUnlocked(repository, {
        schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
        eventId: eventId(
          String(command.commandId),
          'terminal',
          input.status,
        ),
        eventClass: runtimeEventClass(
          input.status === 'succeeded'
            ? CONTROL_PLANE_EVENT_TYPES.commandSucceeded
            : input.status === 'cancelled'
              ? CONTROL_PLANE_EVENT_TYPES.commandCancelled
              : CONTROL_PLANE_EVENT_TYPES.commandFailed,
        ),
        partitionKey: command.sessionId,
        sessionId: command.sessionId,
        commandId: command.commandId,
        agentRunId: command.agentRunId,
        correlationId: command.correlationId,
        type:
          input.status === 'succeeded'
            ? CONTROL_PLANE_EVENT_TYPES.commandSucceeded
            : input.status === 'cancelled'
              ? CONTROL_PLANE_EVENT_TYPES.commandCancelled
              : CONTROL_PLANE_EVENT_TYPES.commandFailed,
        occurredAt: at,
        actor: command.actor,
        payload: { reason: input.reason },
        idempotencyKey: `command:${command.commandId}:terminal`,
        redaction: {
          policyVersion: 'control-plane-fs-v1',
          fields: [],
          secretRefs: [],
        },
      });
    });
  }

  async admitCoderAttempt(
    context: ControlPlaneRunContext,
    preparation: CoderAttemptPreparationV1,
  ): Promise<CoderAttemptAdmissionV1> {
    // Detach caller-owned objects before this operation waits for its turn.
    const facts = cleanJson(preparation);
    return this.#enqueue(context.sessionId, async () => {
      const repository = await this.#repository(context.sessionId);
      const assertCurrent = async () => {
        const current = await this.#assertRunContext(repository, context);
        await assertNoRuntimeCancellation(repository, context.attemptId);
        if (current.run.status !== 'starting' || current.attempt.status !== 'starting'
          || TERMINAL_COMMAND_STATUSES.has(current.command.status)) {
          throw new Error('Attempt admission requires an active starting run and command');
        }
        return current;
      };
      const { run, command } = await assertCurrent();
      if (command.agentRunId !== run.agentRunId && run.ownerAgentRunId) {
        const root = await this.#run(repository, run.ownerAgentRunId);
        const route = root?.activeAttemptId ? (await repository.get('runtimeRoute', root.activeAttemptId))?.data.route as RuntimeRouteRecord | undefined : undefined;
        if (route?.runtimeGeneration === 'rust_v1') throw new Error('Native tree cannot admit a legacy child');
      }
      if (await repository.get('nativePreparation', nativeRecordId(context.attemptId, 'prepare'))) {
        throw new Error('Attempt already has a native preparation');
      }
      return commitCoderAttemptPreparation({
        repository, context, preparation: facts, run, assertCurrent,
        updateRun: (resolved) => this.#updateRun(repository, resolved),
      });
    });
  }

  async markRunStarted(
    context: ControlPlaneRunContext,
    runnerRunId?: string,
    requestedAt = new Date().toISOString(),
  ): Promise<void> {
    await this.#enqueue(context.sessionId, async () => {
      const repository = await this.#repository(context.sessionId);
      const { command, run, attempt } = await this.#assertRunContext(
        repository,
        context,
      );
      await assertNoRuntimeCancellation(repository, context.attemptId);
      if (attempt.runnerRunId && runnerRunId && attempt.runnerRunId !== runnerRunId) {
        throw new Error(`Attempt ${attempt.attemptId} is already bound to a different runner`);
      }
      const at = iso(requestedAt);
      if (run.status !== 'running') {
        if (!canTransitionAgentRun(run.status, 'running')) {
          throw new Error(
            `Run ${run.agentRunId} cannot transition ${run.status} -> running`,
          );
        }
        await this.#updateRun(repository, {
          ...run,
          status: 'running',
          startedAt: run.startedAt ?? at,
          version: run.version + 1,
        });
      }
      if (attempt.status !== 'running' || attempt.runnerRunId !== runnerRunId) {
        await this.#updateAttempt(
          repository,
          {
            ...attempt,
            status: 'running',
            runnerRunId: attempt.runnerRunId ?? runnerRunId,
            executorLease: {
              ...attempt.executorLease,
              heartbeatAt: at,
            },
            version: attempt.version + 1,
          },
          context.sessionId,
        );
      }
      if (command.status === 'accepted') {
        await this.#updateCommand(repository, {
          ...command,
          status: 'running',
          updatedAt: at,
        });
      }
    });
  }

  async renewAttemptLease(
    context: ControlPlaneRunContext,
    expiresAt: string,
    heartbeatAt = new Date().toISOString(),
  ): Promise<void> {
    await this.#enqueue(context.sessionId, async () => {
      const repository = await this.#repository(context.sessionId);
      const { attempt } = await this.#assertRunContext(repository, context, {
        at: heartbeatAt,
      });
      const at = iso(heartbeatAt);
      await this.#updateAttempt(
        repository,
        {
          ...attempt,
          executorLease: {
            ...attempt.executorLease,
            heartbeatAt: at,
            expiresAt: iso(expiresAt),
          },
          version: attempt.version + 1,
        },
        context.sessionId,
      );
    });
  }

  async appendToolBoundary(input: {
    context: ControlPlaneRunContext;
    toolUseId: string;
    toolName: string;
    phase: 'started' | 'completed';
    occurredAt?: string;
    payload?: Record<string, unknown>;
  }): Promise<void> {
    const at = iso(input.occurredAt ?? new Date().toISOString());
    await this.appendRuntimeEvent({
      schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      eventId: eventId(
        String(input.context.agentRunId),
        'tool',
        input.toolUseId,
        input.phase,
      ),
      eventClass: runtimeEventClass(
        input.phase === 'started'
          ? CONTROL_PLANE_EVENT_TYPES.toolInvocationStarted
          : CONTROL_PLANE_EVENT_TYPES.toolInvocationCompleted,
      ),
      partitionKey: input.context.sessionId,
      sessionId: input.context.sessionId,
      commandId: input.context.commandId,
      agentRunId: input.context.agentRunId,
      attemptId: input.context.attemptId,
      causationId: input.context.commandId,
      correlationId: input.context.correlationId,
      type:
        input.phase === 'started'
          ? CONTROL_PLANE_EVENT_TYPES.toolInvocationStarted
          : CONTROL_PLANE_EVENT_TYPES.toolInvocationCompleted,
      occurredAt: at,
      actor: input.context.actor,
      payload: {
        toolUseId: input.toolUseId,
        toolName: input.toolName,
        ...(input.payload ?? {}),
      },
      idempotencyKey: `tool:${input.toolUseId}:${input.phase}`,
      redaction: {
        policyVersion: 'control-plane-fs-v1',
        fields: Object.keys(input.payload ?? {}),
        secretRefs: [],
      },
    });
  }

  async appendRuntimeEvent<T>(
    input: RuntimeEventAppendInput<T>,
  ): Promise<void> {
    await this.#enqueue(input.sessionId, async () => {
      const repository = await this.#repository(input.sessionId);
      await this.#appendRuntimeEventUnlocked(repository, input);
    });
  }

  async #terminalizeRun(
    input: TerminalizeRunInput,
    interrupted: boolean,
  ): Promise<void> {
    await this.#enqueue(input.context.sessionId, async () => {
      const repository = await this.#repository(input.context.sessionId);
      const { command, run, attempt } = await this.#assertRunContext(
        repository,
        input.context,
        { requireActiveLease: false },
      );
      const status = interrupted ? 'interrupted' : input.status;
      if (!canTransitionAgentRun(run.status, status)) {
        throw new Error(
          `Run ${run.agentRunId} cannot transition ${run.status} -> ${status}`,
        );
      }
      const at = iso(input.occurredAt ?? new Date().toISOString());
      const terminalRun = await this.#updateRun(repository, cleanJson({
        ...run,
        status,
        terminalReason: run.terminalReason ?? input.reason,
        transcriptRef: run.transcriptRef ?? input.transcriptRef,
        finishedAt: run.finishedAt ?? at,
        version: run.version + 1,
      }));
      await this.#updateAttempt(
        repository,
        cleanJson({
          ...attempt,
          status: 'terminal',
          terminalReason: attempt.terminalReason ?? input.reason,
          errorRef: attempt.errorRef ?? input.errorRef,
          executorLease: {
            ...attempt.executorLease,
            status:
              input.attemptLeaseStatus ??
              (interrupted ? 'fenced' : 'released'),
            releasedAt: attempt.executorLease.releasedAt ?? at,
            heartbeatAt: at,
          },
          finishedAt: attempt.finishedAt ?? at,
          version: attempt.version + 1,
        }),
        input.context.sessionId,
      );
      // A child shares its root command. Its own terminal must not close the
      // user command while the parent or another sibling is still running.
      if (command.agentRunId === run.agentRunId) await this.#updateCommand(repository, cleanJson({
        ...command,
        status: input.commandStatus,
        reasonCode: command.reasonCode ?? input.reason,
        errorRef: command.errorRef ?? input.errorRef,
        completedAt: command.completedAt ?? at,
        updatedAt: at,
      }));
      await this.#appendRuntimeEventUnlocked(repository, {
        schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
        eventId: eventId(String(terminalRun.agentRunId), 'terminal'),
        eventClass: runtimeEventClass(
          status === 'completed'
            ? CONTROL_PLANE_EVENT_TYPES.agentRunCompleted
            : status === 'aborted'
              ? CONTROL_PLANE_EVENT_TYPES.agentRunAborted
              : status === 'interrupted'
                ? CONTROL_PLANE_EVENT_TYPES.agentRunInterrupted
                : CONTROL_PLANE_EVENT_TYPES.agentRunFailed,
        ),
        partitionKey: terminalRun.sessionId,
        sessionId: terminalRun.sessionId,
        commandId: terminalRun.commandId,
        agentRunId: terminalRun.agentRunId,
        attemptId: input.context.attemptId,
        causationId: terminalRun.commandId,
        correlationId: input.context.correlationId,
        type:
          status === 'completed'
            ? CONTROL_PLANE_EVENT_TYPES.agentRunCompleted
            : status === 'aborted'
              ? CONTROL_PLANE_EVENT_TYPES.agentRunAborted
              : status === 'interrupted'
                ? CONTROL_PLANE_EVENT_TYPES.agentRunInterrupted
                : CONTROL_PLANE_EVENT_TYPES.agentRunFailed,
        occurredAt: at,
        actor: input.context.actor,
        payload: { status, reason: input.reason },
        idempotencyKey: `agent-run:${terminalRun.agentRunId}:terminal`,
        redaction: {
          policyVersion: 'control-plane-fs-v1',
          fields: [],
          secretRefs: [],
        },
      });
    });
  }

  terminalizeRun(input: TerminalizeRunInput): Promise<void> {
    return this.#terminalizeRun(input, false);
  }

  interruptRun(input: TerminalizeRunInput): Promise<void> {
    return this.#terminalizeRun(input, true);
  }

  async getCommand(
    sessionId: SessionId,
    commandId: string,
  ): Promise<PersistedSessionCommand | null> {
    const repository = await this.#repository(sessionId);
    return this.#command(repository, commandId);
  }

  getAttemptState(context: ControlPlaneRunContext, requireActiveLease = true) {
    return this.#enqueue(context.sessionId, async () => this.#assertRunContext(
      await this.#repository(context.sessionId), context, { requireActiveLease },
    ));
  }

  admitNativeChild(context: ControlPlaneRunContext, input: NativeChildRequest): Promise<NativeChildAdmission> {
    const parent = cleanJson(context), request = cleanJson(input);
    return this.#enqueue(parent.sessionId, async () => {
      const repository = await this.#repository(parent.sessionId);
      const source = request.resumeFromRef ? await resolveNativeChildReference(repository, parent, request.resumeFromRef,
        (candidate, requireActiveLease) => this.#assertRunContext(repository, candidate, { requireActiveLease })) : undefined;
      if (source) {
        const previous = await this.#assertRunContext(repository, source, { requireActiveLease: false });
        if (previous.run.status === 'completed' && request.continuationPurpose !== 'followup') throw new Error('Completed native children cannot be resumed');
        if (previous.run.effectiveProvider !== request.provider || previous.run.effectiveModel !== request.model) {
          throw new Error('Native child continuation cannot change its configured provider');
        }
      }
      return admitNativeChild(repository, parent, request, () => this.#assertRunContext(repository, parent), source);
    });
  }

  /** Resolves only an exact child reserved by this worker's root attempt.
   * Callers never supply executor IDs, epochs, a session path or another tree. */
  resolveNativeChild(root: ControlPlaneRunContext, agentRunId: string, requireActiveLease = true): Promise<ControlPlaneRunContext> {
    const owner = cleanJson(root);
    return this.#enqueue(owner.sessionId, async () => {
      const repository = await this.#repository(owner.sessionId);
      const state = await this.#assertRunContext(repository, owner, { requireActiveLease });
      if (state.command.agentRunId !== owner.agentRunId || state.run.spawnDepth !== 0) throw new Error('Native child lookup requires its root owner');
      const data = (await repository.get('nativeTree', nativeTreeId(owner.attemptId)))?.data as unknown as NativeTreeData | undefined;
      if (data?.checkpointType !== 'native-tree-v1' || data.rootAttemptId !== owner.attemptId || data.rootAgentRunId !== owner.agentRunId
        || !Array.isArray(data.children) || data.children.length > 255) throw new Error('Native child lookup has no owned reservation');
      const receipt = data.children.find(child => child.context.agentRunId === agentRunId);
      if (!receipt || receipt.context.sessionId !== owner.sessionId || receipt.context.commandId !== owner.commandId
        || receipt.context.executorOwnerId !== owner.executorOwnerId || receipt.context.correlationId !== owner.correlationId) {
        throw new Error('Native child lookup belongs to another tree');
      }
      await this.#assertRunContext(repository, receipt.context, { requireActiveLease });
      return cleanJson(receipt.context);
    });
  }

  assertNativeWorkspaceLease(context: ControlPlaneRunContext, lease: NativeWorkspaceLease): Promise<void> {
    const owner = cleanJson(context), grant = cleanJson(lease);
    return this.#enqueue(owner.sessionId, async () => {
      const repository = await this.#repository(owner.sessionId);
      await this.#assertRunContext(repository, owner);
      await assertPreparedWorkspaceLease(repository, owner, grant);
      await this.#assertRunContext(repository, owner);
    });
  }

  /** UI history: the caller must own the session, but needs no execution lease.
   * Resolve the reader identity from durable records, never from the worker. */
  resolveSessionChildTranscript(sessionId: SessionId, reference: string): Promise<ControlPlaneRunContext> {
    const target = parseNativeChildTranscriptRef(reference);
    if (target.sessionId !== sessionId) return Promise.reject(new Error('Native transcript belongs to another session'));
    return this.#enqueue(sessionId, async () => {
      const repository = await this.#repository(sessionId);
      const tree = (await repository.get('nativeTree', nativeTreeId(target.rootAttemptId)))?.data as unknown as NativeTreeData | undefined;
      if (tree?.checkpointType !== 'native-tree-v1' || tree.rootAttemptId !== target.rootAttemptId) throw new Error('Native transcript has no durable tree');
      const run = await this.#run(repository, tree.rootAgentRunId);
      const attempt = run?.activeAttemptId ? await this.#attempt(repository, run.activeAttemptId) : undefined;
      const command = run ? await this.#command(repository, run.commandId) : undefined;
      if (!run || !attempt || !command || run.parentAgentRunId || command.agentRunId !== run.agentRunId) {
        throw new Error('Native transcript has no durable session root');
      }
      const owner: ControlPlaneRunContext = { sessionId, commandId: command.commandId, correlationId: command.correlationId,
        actor: command.actor, agentRunId: run.agentRunId, attemptId: attempt.attemptId,
        executorOwnerId: attempt.executorLease.ownerId, fencingEpoch: attempt.executorLease.fencingEpoch };
      return resolveNativeChildReference(repository, owner, reference,
        (candidate, requireActiveLease) => this.#assertRunContext(repository, candidate, { requireActiveLease }), false);
    });
  }

  resolveNativeChildTranscript(context: ControlPlaneRunContext, reference: string, requireActiveOwner = true): Promise<ControlPlaneRunContext> {
    const owner = cleanJson(context);
    return this.#enqueue(owner.sessionId, async () => {
      const repository = await this.#repository(owner.sessionId);
      return resolveNativeChildReference(repository, owner, reference,
        (candidate, requireActiveLease) => this.#assertRunContext(repository, candidate, { requireActiveLease }), requireActiveOwner);
    });
  }

  readNativeContinuationInbox(context: ControlPlaneRunContext, input: NativeInboxSource): Promise<NativeTreeInboxEntry[]> {
    const owner = cleanJson(context), source = cleanJson(input);
    return this.#enqueue(owner.sessionId, async () => {
      const repository = await this.#repository(owner.sessionId);
      const current = await this.#assertRunContext(repository, owner);
      let previous: ControlPlaneRunContext;
      if ('reference' in source) {
        previous = await resolveNativeChildReference(repository, owner, source.reference,
          (candidate, requireActiveLease) => this.#assertRunContext(repository, candidate, { requireActiveLease }));
      } else {
        if (current.run.spawnDepth !== 0 || current.command.agentRunId !== owner.agentRunId
          || !/^[a-f0-9-]{36}$/i.test(source.agentRunId) || !/^[a-f0-9-]{36}$/i.test(source.attemptId)) {
          throw new Error('Native inbox root recovery requires its current session root');
        }
        const run = await this.#run(repository, source.agentRunId), attempt = await this.#attempt(repository, source.attemptId);
        const command = run ? await this.#command(repository, run.commandId) : undefined;
        if (!run || !attempt || !command || run.parentAgentRunId || run.spawnDepth !== 0 || run.sessionId !== owner.sessionId
          || run.activeAttemptId !== attempt.attemptId || attempt.agentRunId !== run.agentRunId || command.agentRunId !== run.agentRunId
          || hashControlPlanePayload(command.actor) !== hashControlPlanePayload(owner.actor)
          || !['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status) || attempt.attemptId === owner.attemptId) {
          throw new Error('Native inbox recovery source is not a terminal root in this session');
        }
        previous = { sessionId: owner.sessionId, commandId: command.commandId, correlationId: command.correlationId,
          actor: command.actor, agentRunId: run.agentRunId, attemptId: attempt.attemptId,
          executorOwnerId: attempt.executorLease.ownerId, fencingEpoch: attempt.executorLease.fencingEpoch };
      }
      await this.#assertRunContext(repository, previous, { requireActiveLease: false });
      const inbox = await readNativeInbox(repository, previous);
      await this.#assertRunContext(repository, owner);
      return inbox;
    });
  }

  resolveNativeChildCompletion(context: ControlPlaneRunContext, reference: string): Promise<NativeChildCompletionAuthority> {
    const owner = cleanJson(context);
    return this.#enqueue(owner.sessionId, async () => {
      const repository = await this.#repository(owner.sessionId);
      const child = await resolveNativeChildReference(repository, owner, reference,
        (candidate, requireActiveLease) => this.#assertRunContext(repository, candidate, { requireActiveLease }));
      const { run, attempt, command } = await this.#assertRunContext(repository, child, { requireActiveLease: false });
      const { supervisorFactId } = await import('./supervisor-fact-ledger.js');
      const fact = await repository.get('supervisorFact', supervisorFactId(child.attemptId, 'attemptProcessReaped'));
      let physicalReaped = false;
      if (fact) {
        if (fact.relations.attempt !== child.attemptId || fact.relations.session !== child.sessionId
          || fact.data.checkpointType !== 'supervisor-fact-v1' || fact.data.factCase !== 'attemptProcessReaped'
          || typeof fact.data.encodedPayload !== 'string' || fact.data.encodedPayload.length > 128 * 1024) {
          throw new Error('Native child cleanup receipt has foreign authority');
        }
        const bytes = Buffer.from(fact.data.encodedPayload, 'base64');
        if (createHash('sha256').update(bytes).digest('hex') !== fact.data.contentSha256) throw new Error('Native child cleanup receipt digest differs');
        const body = fromBinary(agentV1Supervisor.ManagementPayloadSchema, bytes).body;
        const expected = create(agentV1Common.AttemptIdentitySchema, { ...child, fencingEpoch: BigInt(child.fencingEpoch),
          rootAgentRunId: command.agentRunId!, parentAgentRunId: run.parentAgentRunId, ownerAgentRunId: run.ownerAgentRunId });
        if (body.case !== 'attemptProcessReaped' || !body.value.identity
          || !Buffer.from(toBinary(agentV1Common.AttemptIdentitySchema, body.value.identity))
            .equals(toBinary(agentV1Common.AttemptIdentitySchema, expected))) throw new Error('Native child cleanup identity differs');
        physicalReaped = true;
      }
      // Startup fencing/physical recovery alone does not attest Host effects.
      // Normal facade completion releases this lease only after Host drain.
      const reason = run.terminalReason ?? '';
      const hostDrained = attempt.status === 'terminal' && attempt.executorLease.status === 'released'
        && attempt.terminalReason === reason && !['outcome_unknown', 'native_host_cleanup_failed', 'native_attempt_failed'].includes(reason);
      return { context: child, status: run.status, reason, physicalReaped, hostDrained };
    });
  }

  admitNativeAttempt(context: ControlPlaneRunContext, input: NativeAttemptPreparationInput): Promise<NativeAttemptAdmission> {
    const owner = cleanJson(context); const copy = copyNativePreparation(input);
    return this.#enqueue(owner.sessionId, async () => {
      const repository = await this.#repository(owner.sessionId);
      const assertCurrent = async () => {
        const state = await this.#assertRunContext(repository, owner);
        await assertNoRuntimeCancellation(repository, owner.attemptId);
        const child = state.command.agentRunId !== state.run.agentRunId;
        if (state.run.status !== 'starting' || state.attempt.status !== 'starting'
          || (child ? state.command.status !== 'running' : state.command.status !== 'accepted')) {
          throw new Error('Native preparation requires an accepted starting attempt');
        }
        return state;
      };
      const { command, run, attempt } = await assertCurrent();
      if (await repository.get('attemptPreparation', preparationId(owner.attemptId))) {
        throw new Error('Attempt already has a legacy preparation');
      }
      const spec = validateNativePreparation(copy, owner, run, attempt, command.agentRunId!);
      if (command.agentRunId !== run.agentRunId) await assertNativeChildPreparation(repository, owner, { command, run, attempt }, spec);
      const admission = await commitNativePreparation(repository, owner, copy, run, attempt, spec,
        (resolved) => this.#updateRun(repository, resolved));
      await assertCurrent();
      return admission;
    });
  }

  createNativeActivationPort(context: ControlPlaneRunContext, activationNonce: Uint8Array): PreparedDurabilityPort {
    const owner = cleanJson(context); const nonce = Uint8Array.from(activationNonce);
    if (nonce.length !== 32) throw new Error('Native activation nonce must contain 32 bytes');
    return { commitPrepared: (value, control) => {
      const facts = copyPreparedFacts(value);
      return this.#enqueue(owner.sessionId, async () => {
        const repository = await this.#repository(owner.sessionId);
        const assertCurrent = async () => {
          const state = await this.#assertRunContext(repository, owner);
          await assertNoRuntimeCancellation(repository, owner.attemptId);
          assertNativeActivationLive(control);
          if (!['starting', 'running'].includes(state.run.status) || !['accepted', 'running'].includes(state.command.status)) {
            throw new Error('Native activation authority no longer permits execution');
          }
          return state;
        };
        await assertCurrent();
        return commitNativeActivation({ repository, context: owner, nonce, facts, control, assertCurrent,
          projectRunning: async (runtimeInstanceId, runVersion, attemptVersion) => {
            const state = await assertCurrent();
            if ((state.run.status === 'starting' ? state.run.version + 1 : state.run.version) !== runVersion
              || (state.attempt.status === 'starting' ? state.attempt.version + 1 : state.attempt.version) !== attemptVersion
              || (state.attempt.runnerRunId && state.attempt.runnerRunId !== runtimeInstanceId)) {
              throw new Error('Native activation versions or process were superseded');
            }
            const at = new Date().toISOString();
            if (state.run.status === 'starting') await this.#updateRun(repository,
              { ...state.run, status: 'running', startedAt: at, version: runVersion });
            assertNativeActivationLive(control);
            if (state.attempt.status === 'starting') await this.#updateAttempt(repository,
              { ...state.attempt, status: 'running', runnerRunId: runtimeInstanceId, version: attemptVersion }, owner.sessionId);
            assertNativeActivationLive(control);
            if (state.command.status === 'accepted') await this.#updateCommand(repository,
              { ...state.command, status: 'running', updatedAt: at });
          },
        });
      });
    } };
  }

  createSupervisorFactPort(context: ControlPlaneRunContext, connectionId: string): DurableSupervisorFactPort {
    const owner = cleanJson(context);
    if (!connectionId || connectionId.length > 512) throw new Error('Invalid supervisor connection identity');
    return { commit: (fact, binding, control) => {
      if (binding.connectionId !== connectionId) return Promise.reject(new Error('Supervisor connection changed'));
      const record = supervisorFactRecord(fact, binding, control);
      const identity = fact.value.identity && { ...fact.value.identity };
      const cleanup = fact.case === 'attemptProcessExited' || fact.case === 'attemptProcessReaped';
      return this.#enqueue(owner.sessionId, async () => {
        assertSupervisorCommitLive(control);
        const repository = await this.#repository(owner.sessionId);
        // Physical cleanup remains recordable after logical terminalization;
        // it cannot authorize work, alter routing, or reactivate a lease.
        const state = await this.#assertRunContext(repository, owner, { requireActiveLease: !cleanup });
        if (!identity || identity.sessionId !== owner.sessionId || identity.commandId !== owner.commandId
          || identity.agentRunId !== owner.agentRunId || identity.attemptId !== owner.attemptId
          || identity.executorOwnerId !== owner.executorOwnerId || identity.fencingEpoch !== BigInt(owner.fencingEpoch)
          || identity.correlationId !== owner.correlationId || identity.rootAgentRunId !== state.command.agentRunId
          || (identity.parentAgentRunId ?? undefined) !== state.run.parentAgentRunId
          || (identity.ownerAgentRunId ?? undefined) !== state.run.ownerAgentRunId) {
          throw new Error('Supervisor fact differs from its durable attempt authority');
        }
        if (!cleanup) await assertNoRuntimeCancellation(repository, owner.attemptId);
        await commitSupervisorFact(repository, owner, record, control);
      });
    } };
  }

  /** Runs in the product writer queue and reads through the native OS lock.
   * Cleanup can be reconciled after expiry, without reviving attempt authority. */
  reconcileNativeSupervisor(context: ControlPlaneRunContext, native: { rootPath: string; runtimePackage: VerifiedRuntimePackage }) {
    const owner = cleanJson(context);
    return this.#enqueue(owner.sessionId, async () => {
      const repository = await this.#repository(owner.sessionId);
      const state = await this.#assertRunContext(repository, owner, { requireActiveLease: false });
      const { supervisorFactId } = await import('./supervisor-fact-ledger.js');
      const spawned = await repository.get('supervisorFact', supervisorFactId(owner.attemptId, 'attemptProcessSpawned'));
      if (typeof spawned?.data.connectionId !== 'string') throw new Error('Native recovery lacks durable spawn authority');
      const { inspectNativeSupervisorLifecycleEvidence } = await import('@mcp/agent-runtime-host');
      const rootPath = state.run.parentAgentRunId ? await resolveNativeChildSessionRoot(native.rootPath, owner) : native.rootPath;
      const entry = await inspectNativeSupervisorLifecycleEvidence(native.runtimePackage, { rootPath,
        connectionId: spawned.data.connectionId, sessionId: owner.sessionId, attemptId: owner.attemptId });
      if (!entry) throw new Error('Native recovery has no durable physical cleanup evidence');
      const expectedIdentity = create(agentV1Common.AttemptIdentitySchema, { ...owner, fencingEpoch: BigInt(owner.fencingEpoch),
        rootAgentRunId: state.command.agentRunId!, parentAgentRunId: state.run.parentAgentRunId, ownerAgentRunId: state.run.ownerAgentRunId });
      const { commitNativeSupervisorRecovery } = await import('./native-supervisor-recovery.js');
      return commitNativeSupervisorRecovery(repository, owner, expectedIdentity, entry);
    });
  }

  async getRuntimeRoute(sessionId: SessionId, attemptId: string): Promise<RuntimeRouteRecord | null> {
    const repository = await this.#repository(sessionId);
    return (await repository.get('runtimeRoute', attemptId))?.data.route as RuntimeRouteRecord | undefined ?? null;
  }

  commitRuntimeRoute(context: ControlPlaneRunContext, route: RuntimeRouteRecord): Promise<RuntimeRouteCommit> {
    const copy = cleanJson(route);
    return this.#enqueue(context.sessionId, async () => {
      const repository = await this.#repository(context.sessionId);
      const { run, attempt, command } = await this.#assertRunContext(repository, context);
      await assertNoRuntimeCancellation(repository, context.attemptId);
      if (run.status !== 'starting' || attempt.status !== 'starting') throw new Error('Runtime routing requires a starting attempt');
      if (command.agentRunId !== run.agentRunId && command.agentRunId) {
        const root = await this.#run(repository, command.agentRunId);
        const parentRoute = root?.activeAttemptId ? (await repository.get('runtimeRoute', root.activeAttemptId))?.data.route as RuntimeRouteRecord | undefined : undefined;
        if (!parentRoute || parentRoute.runtimeGeneration !== copy.runtimeGeneration) throw new Error('Child runtime must match its root generation');
        if (copy.runtimeGeneration === 'rust_v1' && (copy.runtimeBuildId !== parentRoute.runtimeBuildId
          || copy.runtimeBinarySha256 !== parentRoute.runtimeBinarySha256 || copy.protocolVersion !== parentRoute.protocolVersion)) {
          throw new Error('Native child must use the same runtime build as its root');
        }
      }
      return commitRuntimeRoute(repository, context, copy);
    });
  }

  commitRuntimeRequest(context: ControlPlaneRunContext, key: string, payload: unknown): Promise<boolean> {
    const copy = cleanJson(payload);
    return this.#enqueue(context.sessionId, async () => {
      const repository = await this.#repository(context.sessionId);
      // Cancellation remains recordable for a current child after its root is
      // cancelled/fenced. It grants no work and must still reach physical Control.
      await this.#assertRunContext(repository, context, { requireActiveLease: key !== 'cancel' });
      if (key !== 'cancel') await assertNoRuntimeCancellation(repository, context.attemptId);
      return commitRuntimeRequest(repository, context, key, copy);
    });
  }

  async getRun(
    sessionId: SessionId,
    agentRunId: string,
  ): Promise<AgentRun | null> {
    const repository = await this.#repository(sessionId);
    return this.#run(repository, agentRunId);
  }

  async recordDivergences(
    context: Pick<
      ControlPlaneRunContext,
      | 'sessionId'
      | 'commandId'
      | 'agentRunId'
      | 'correlationId'
      | 'actor'
    >,
    divergences: readonly unknown[],
  ): Promise<void> {
    await Promise.all(
      divergences.map((divergence, index) =>
        this.appendRuntimeEvent({
          schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
          eventId: eventId(
            String(context.agentRunId),
            'divergence',
            String(index),
            createHash('sha256')
              .update(JSON.stringify(divergence))
              .digest('hex'),
          ),
          eventClass: 'D',
          partitionKey: context.sessionId,
          sessionId: context.sessionId,
          commandId: context.commandId,
          agentRunId: context.agentRunId,
          correlationId: context.correlationId,
          type: 'control-plane.divergence',
          occurredAt: new Date().toISOString(),
          actor: context.actor,
          payload: cleanJson(divergence),
          idempotencyKey: `divergence:${context.agentRunId}:${index}`,
          redaction: {
            policyVersion: 'control-plane-fs-v1',
            fields: [],
            secretRefs: [],
          },
        } as RuntimeEventAppendInput<unknown>),
      ),
    );
  }

  recoverInterruptedRuns(
    reason = 'process-restart',
    occurredAt = new Date().toISOString(),
    options: { nativeOnly?: boolean } = {},
  ): Promise<number> {
    this.#recoveryPromise ??= this.#performRecovery(reason, occurredAt, options.nativeOnly === true);
    return this.#recoveryPromise;
  }

  async #performRecovery(
    reason: string,
    occurredAt: string,
    nativeOnly: boolean,
  ): Promise<number> {
    if (nativeOnly && !await this.#nativeRecovery?.isPresent()) return 0;
    const nativeSessions = nativeOnly ? await this.#nativeRecovery?.sessionIds?.() : undefined;
    await this.#sessions.ensureCatalog();
    const nativeCandidates: ControlPlaneRunContext[] = [];
    let recovered = 0;
    for (const entry of this.#sessions.catalog.list()) {
      const sessionId = entry.session.id;
      if (nativeSessions && !nativeSessions.has(sessionId)) continue;
      recovered += await this.#enqueue(sessionId, async () => {
        const repository = await this.#repository(sessionId);
        const runs = (await this.#listAll(repository, 'run'))
          .map(persistedRun)
          .filter((run): run is AgentRun => run != null);
        let count = 0;
        for (const run of runs) {
          const at = iso(occurredAt);
          const attempt = run.activeAttemptId
            ? await this.#attempt(repository, String(run.activeAttemptId))
            : null;
          const route = attempt ? await repository.get('runtimeRoute', String(run.activeAttemptId)) : null;
          const native = (route?.data.route as { runtimeGeneration?: string } | undefined)?.runtimeGeneration === 'rust_v1';
          if (nativeOnly && !native) continue;
          if (native && attempt && this.#nativeRecovery
            && !await repository.get('checkpoint', nativeRecordId(attempt.attemptId, 'physical-recovery'))) {
            const command = await this.#command(repository, String(run.commandId));
            if (command) nativeCandidates.push({ sessionId: run.sessionId, commandId: run.commandId,
              agentRunId: run.agentRunId, attemptId: attempt.attemptId, correlationId: command.correlationId,
              actor: command.actor, executorOwnerId: attempt.executorLease.ownerId, fencingEpoch: attempt.executorLease.fencingEpoch });
          }
          if (TERMINAL_RUN_STATUSES.has(run.status)) continue;
          if (attempt && attempt.status !== 'terminal') {
            await this.#updateAttempt(
              repository,
              {
                ...attempt,
                status: 'terminal',
                terminalReason: attempt.terminalReason ?? reason,
                executorLease: {
                  ...attempt.executorLease,
                  status: 'fenced',
                  heartbeatAt: at,
                  releasedAt: attempt.executorLease.releasedAt ?? at,
                },
                finishedAt: attempt.finishedAt ?? at,
                version: attempt.version + 1,
              },
              sessionId,
            );
          }
          await this.#updateRun(repository, {
            ...run,
            status: 'interrupted',
            terminalReason: run.terminalReason ?? reason,
            finishedAt: run.finishedAt ?? at,
            version: run.version + 1,
          });
          const command = await this.#command(
            repository,
            String(run.commandId),
          );
          if (
            command &&
            !TERMINAL_COMMAND_STATUSES.has(command.status)
          ) {
            await this.#updateCommand(repository, {
              ...command,
              status: 'failed',
              reasonCode: command.reasonCode ?? reason,
              completedAt: command.completedAt ?? at,
              updatedAt: at,
            });
          }
          count += 1;
        }
        return count;
      });
    }
    if (nativeCandidates.length && this.#nativeRecovery) {
      let native: { rootPath: string; runtimePackage: VerifiedRuntimePackage };
      try { native = await this.#nativeRecovery.load(); }
      catch (cause) {
        // Logical fencing already completed. Missing native binaries must not
        // prevent unrelated legacy commands; native admission verifies its own
        // package and retained physical ownership still blocks unsafe reuse.
        console.warn(`[native-recovery] package unavailable; physical ownership retained: ${cause instanceof Error ? cause.message : String(cause)}`);
        return recovered;
      }
      for (const context of nativeCandidates) {
        try { await this.reconcileNativeSupervisor(context, native); }
        catch (cause) {
          // No invented reap receipt, workspace release or automatic restart.
          // Missing physical evidence stays unresolved for explicit recovery.
          console.warn(`[native-recovery] physical evidence unresolved attempt=${context.attemptId}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
    }
    return recovered;
  }
}

export type ControlPlaneAuthority = FileControlPlaneAuthority;
