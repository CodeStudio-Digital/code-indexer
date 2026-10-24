import {
CONTROL_PLANE_EVENT_TYPES,
CONTROL_PLANE_SCHEMA_VERSION,
canTransitionAgentRun,
runtimeEventClass,
type CoderAttemptAdmissionV1,
type CoderAttemptPreparationV1,
type SessionCommandStatus
} from '@mcp/agent-runtime-contracts';
import type {
ControlPlaneCommandContext,
ControlPlaneRunContext
} from '@mcp/store/control-plane/index.js';
import { commitCoderAttemptPreparation } from './coder-attempt-admission.js';
import { TERMINAL_COMMAND_STATUSES,cleanJson,eventId,iso } from './control-plane-file-shared.js';
import { assertNoRuntimeCancellation } from './runtime-attempt-ledger.js';

import type { ControlPlaneFileContext } from './control-plane-file-context.js';

export const operations = {
async bindCommandExecution(this: ControlPlaneFileContext,
    context: ControlPlaneCommandContext,
    busId: string,
    occurredAt = new Date().toISOString(),
  ): Promise<void> {
    await this.internalEnqueue(context.sessionId, async () => {
      const repository = await this.internalRepository(context.sessionId);
      const current = await this.internalAssertCommandContext(repository, context);
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
      await this.internalUpdateCommand(repository, {
        ...current,
        status: 'running',
        result: { busId },
        updatedAt: iso(occurredAt),
      });
    });
  },

async terminalizeCommand(this: ControlPlaneFileContext, input: {
    context: ControlPlaneCommandContext;
    status: Extract<SessionCommandStatus, 'succeeded' | 'failed' | 'cancelled'>;
    reason: string;
    errorRef?: string;
    result?: unknown;
    occurredAt?: string;
    preserveExistingTerminal?: boolean;
  }): Promise<void> {
    await this.internalEnqueue(input.context.sessionId, async () => {
      const repository = await this.internalRepository(input.context.sessionId);
      const current = await this.internalAssertCommandContext(
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
      const command = await this.internalUpdateCommand(repository, cleanJson({
        ...current,
        status: input.status,
        reasonCode: current.reasonCode ?? input.reason,
        errorRef: current.errorRef ?? input.errorRef,
        result: current.result ?? input.result,
        completedAt: current.completedAt ?? at,
        updatedAt: at,
      }));
      await this.internalAppendRuntimeEventUnlocked(repository, {
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
  },

async admitCoderAttempt(this: ControlPlaneFileContext,
    context: ControlPlaneRunContext,
    preparation: CoderAttemptPreparationV1,
  ): Promise<CoderAttemptAdmissionV1> {
    // Detach caller-owned objects before this operation waits for its turn.
    const facts = cleanJson(preparation);
    return this.internalEnqueue(context.sessionId, async () => {
      const repository = await this.internalRepository(context.sessionId);
      const assertCurrent = async () => {
        const current = await this.internalAssertRunContext(repository, context);
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
        updateRun: (resolved) => this.internalUpdateRun(repository, resolved),
      });
    });
  },

async markRunStarted(this: ControlPlaneFileContext,
    context: ControlPlaneRunContext,
    runnerRunId?: string,
    requestedAt = new Date().toISOString(),
  ): Promise<void> {
    await this.internalEnqueue(context.sessionId, async () => {
      const repository = await this.internalRepository(context.sessionId);
      const { command, run, attempt } = await this.internalAssertRunContext(
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
        await this.internalUpdateRun(repository, {
          ...run,
          status: 'running',
          startedAt: run.startedAt ?? at,
          version: run.version + 1,
        });
      }
      if (attempt.status !== 'running' || attempt.runnerRunId !== runnerRunId) {
        await this.internalUpdateAttempt(
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
        await this.internalUpdateCommand(repository, {
          ...command,
          status: 'running',
          updatedAt: at,
        });
      }
    });
  },

async renewAttemptLease(this: ControlPlaneFileContext,
    context: ControlPlaneRunContext,
    expiresAt: string,
    heartbeatAt = new Date().toISOString(),
  ): Promise<void> {
    await this.internalEnqueue(context.sessionId, async () => {
      const repository = await this.internalRepository(context.sessionId);
      const { attempt } = await this.internalAssertRunContext(repository, context, {
        at: heartbeatAt,
      });
      const at = iso(heartbeatAt);
      await this.internalUpdateAttempt(
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
};
