import {
asSessionId,
type AgentRun,
type AgentRunAttempt,
type RuntimeEventEnvelopeV1,
type SessionId
} from '@mcp/agent-runtime-contracts';
import {
ControlPlaneFileRepository,
type ControlPlaneEntityDataMap,
type ControlPlaneEntityKind,
type EntityRecord,
type JsonValue,
} from '@mcp/session-storage';
import type {
ControlPlaneCommandContext,
ControlPlaneRunContext,
PersistedSessionCommand,
RuntimeEventAppendInput
} from '@mcp/store/control-plane/index.js';
import { createHash,randomUUID } from 'node:crypto';
import { attemptData,cleanJson,commandData,iso,leaseExpired,persistedAttempt,persistedCommand,persistedRun,runData } from './control-plane-file-shared.js';

import type { ControlPlaneFileContext } from './control-plane-file-context.js';

export const operations = {
async internalRepository(this: ControlPlaneFileContext, sessionId: SessionId | string): Promise<ControlPlaneFileRepository> {
    const key = String(sessionId).toLowerCase();
    const cached = this.internalRepositories.get(key);
    if (cached) return cached;
    const location = await this.internalSessions.getSessionLocation(asSessionId(key));
    if (!location) throw new Error(`Unknown filesystem session ${key}`);
    await this.internalSessions.locator.assertSafeLocation(location, {
      mustExist: true,
    });
    const repository = new ControlPlaneFileRepository({
      sessionRoot: location.bundle_path,
    });
    this.internalRepositories.set(key, repository);
    return repository;
  },

internalEnqueue<T>(this: ControlPlaneFileContext, sessionId: SessionId | string, task: () => Promise<T>): Promise<T> {
    return this.internalSessions.runSessionMutation(sessionId, task);
  },

async internalListAll<K extends ControlPlaneEntityKind>(this: ControlPlaneFileContext,
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
  },

async internalAppendRuntimeEventUnlocked<T>(this: ControlPlaneFileContext,
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
  },

async internalUpdateCommand(this: ControlPlaneFileContext,
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
  },

async internalUpdateRun(this: ControlPlaneFileContext,
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
  },

async internalUpdateAttempt(this: ControlPlaneFileContext,
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
  },

async internalCommand(this: ControlPlaneFileContext,
    repository: ControlPlaneFileRepository,
    commandId: string,
  ): Promise<PersistedSessionCommand | null> {
    return persistedCommand(await repository.get('command', commandId));
  },

async internalRun(this: ControlPlaneFileContext,
    repository: ControlPlaneFileRepository,
    runId: string,
  ): Promise<AgentRun | null> {
    return persistedRun(await repository.get('run', runId));
  },

async internalAttempt(this: ControlPlaneFileContext,
    repository: ControlPlaneFileRepository,
    attemptId: string,
  ): Promise<AgentRunAttempt | null> {
    return persistedAttempt(await repository.get('attempt', attemptId));
  },

async internalAssertCommandContext(this: ControlPlaneFileContext,
    repository: ControlPlaneFileRepository,
    context: ControlPlaneCommandContext,
  ): Promise<PersistedSessionCommand> {
    const command = await this.internalCommand(repository, String(context.commandId));
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
  },

async internalAssertRunContext(this: ControlPlaneFileContext,
    repository: ControlPlaneFileRepository,
    context: ControlPlaneRunContext,
    options: { requireActiveLease?: boolean; at?: string } = {},
  ): Promise<{
    command: PersistedSessionCommand;
    run: AgentRun;
    attempt: AgentRunAttempt;
  }> {
    const command = await this.internalAssertCommandContext(repository, context);
    const run = await this.internalRun(repository, String(context.agentRunId));
    const attempt = await this.internalAttempt(repository, String(context.attemptId));
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
};
