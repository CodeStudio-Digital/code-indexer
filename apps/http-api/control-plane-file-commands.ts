import {
CONTROL_PLANE_EVENT_TYPES,
CONTROL_PLANE_SCHEMA_VERSION,
runtimeEventClass,
type AgentRun,
type AgentRunAttempt
} from '@mcp/agent-runtime-contracts';
import type {
AcceptCommandInput,
AcceptCommandResult,
PersistedSessionCommand
} from '@mcp/store/control-plane/index.js';
import { attemptData,cleanJson,commandData,eventId,persistedCommand,runData } from './control-plane-file-shared.js';

import type { ControlPlaneFileContext } from './control-plane-file-context.js';

export const operations = {
async acceptCommand<T>(this: ControlPlaneFileContext,
    input: AcceptCommandInput<T>,
  ): Promise<AcceptCommandResult> {
    // Retry a failed catalog initialization, but never race a restart scan.
    if (this.internalRecoveryRequest) await this.recoverInterruptedRuns();
    return this.internalEnqueue(input.command.sessionId, async () => {
      await this.internalEnsureSessionRecovered(input.command.sessionId);
      const repository = await this.internalRepository(input.command.sessionId);
      const aliases = new Set([
        input.command.kind,
        ...(input.idempotencyKindAliases ?? []),
      ]);
      const commands = await this.internalListAll(repository, 'command');
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
          ? (await this.internalRun(repository, String(existing.agentRunId))) ?? undefined
          : undefined;
        const attempt = agentRun?.activeAttemptId
          ? (await this.internalAttempt(repository, String(agentRun.activeAttemptId))) ??
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
        const linked = await this.internalRun(repository, String(input.linkedAgentRunId));
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
        await this.internalUpdateCommand(repository, command);
      }

      await this.internalAppendRuntimeEventUnlocked(repository, {
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
};
