import {
CONTROL_PLANE_EVENT_TYPES,
CONTROL_PLANE_SCHEMA_VERSION,
canTransitionAgentRun,
runtimeEventClass
} from '@mcp/agent-runtime-contracts';
import type {
ControlPlaneRunContext,
RuntimeEventAppendInput,
TerminalizeRunInput
} from '@mcp/store/control-plane/index.js';
import { cleanJson,eventId,iso } from './control-plane-file-shared.js';

import type { ControlPlaneFileContext } from './control-plane-file-context.js';

export const operations = {
async appendToolBoundary(this: ControlPlaneFileContext, input: {
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
  },

async appendRuntimeEvent<T>(this: ControlPlaneFileContext,
    input: RuntimeEventAppendInput<T>,
  ): Promise<void> {
    await this.internalEnqueue(input.sessionId, async () => {
      const repository = await this.internalRepository(input.sessionId);
      await this.internalAppendRuntimeEventUnlocked(repository, input);
    });
  },

async internalTerminalizeRun(this: ControlPlaneFileContext,
    input: TerminalizeRunInput,
    interrupted: boolean,
  ): Promise<void> {
    await this.internalEnqueue(input.context.sessionId, async () => {
      const repository = await this.internalRepository(input.context.sessionId);
      const { command, run, attempt } = await this.internalAssertRunContext(
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
      const terminalRun = await this.internalUpdateRun(repository, cleanJson({
        ...run,
        status,
        terminalReason: run.terminalReason ?? input.reason,
        transcriptRef: run.transcriptRef ?? input.transcriptRef,
        finishedAt: run.finishedAt ?? at,
        version: run.version + 1,
      }));
      await this.internalUpdateAttempt(
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
      if (command.agentRunId === run.agentRunId) await this.internalUpdateCommand(repository, cleanJson({
        ...command,
        status: input.commandStatus,
        reasonCode: command.reasonCode ?? input.reason,
        errorRef: command.errorRef ?? input.errorRef,
        completedAt: command.completedAt ?? at,
        updatedAt: at,
      }));
      await this.internalAppendRuntimeEventUnlocked(repository, {
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
  },

terminalizeRun(this: ControlPlaneFileContext, input: TerminalizeRunInput): Promise<void> {
    return this.internalTerminalizeRun(input, false);
  },

interruptRun(this: ControlPlaneFileContext, input: TerminalizeRunInput): Promise<void> {
    return this.internalTerminalizeRun(input, true);
  }
};
