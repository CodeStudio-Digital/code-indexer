import { createHash, randomUUID } from 'node:crypto';
import { commitCoderAttemptPreparation } from './coder-attempt-admission.js';
import { commitRuntimeRoute, commitRuntimeRequest, assertNoRuntimeCancellation } from './runtime-attempt-ledger.js';
import { hashControlPlanePayload } from '@mcp/store/control-plane/index.js';
import type { RuntimeRouteCommit, RuntimeRouteRecord } from '@mcp/agent-runtime-host';
import {
  CONTROL_PLANE_EVENT_TYPES,
  CONTROL_PLANE_SCHEMA_VERSION,
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
  readonly journalEnabled: boolean;
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

  constructor(
    sessions: FsSessionStore,
    options: { journalEnabled?: boolean } = {},
  ) {
    this.#sessions = sessions;
    this.journalEnabled = options.journalEnabled ?? true;
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
  ): Promise<number> {
    this.#recoveryPromise ??= this.#performRecovery(reason, occurredAt);
    return this.#recoveryPromise;
  }

  async #performRecovery(
    reason: string,
    occurredAt: string,
  ): Promise<number> {
    await this.#sessions.ensureCatalog();
    let recovered = 0;
    for (const entry of this.#sessions.catalog.list()) {
      const sessionId = entry.session.id;
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
    return recovered;
  }
}

export type ControlPlaneAuthority = FileControlPlaneAuthority;
