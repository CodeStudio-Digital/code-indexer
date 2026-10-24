import {
CONTROL_PLANE_SCHEMA_VERSION,
type AgentRun,
type SessionId
} from '@mcp/agent-runtime-contracts';
import type { RuntimeRouteCommit,RuntimeRouteRecord } from '@mcp/agent-runtime-host';
import type {
ControlPlaneRunContext,
PersistedSessionCommand,
RuntimeEventAppendInput
} from '@mcp/store/control-plane/index.js';
import { createHash } from 'node:crypto';
import { TERMINAL_COMMAND_STATUSES,TERMINAL_RUN_STATUSES,cleanJson,eventId,iso,persistedRun } from './control-plane-file-shared.js';
import { assertNoRuntimeCancellation,commitRuntimeRequest,commitRuntimeRoute } from './runtime-attempt-ledger.js';

import type { ControlPlaneFileContext } from './control-plane-file-context.js';

export const operations = {
async getCommand(this: ControlPlaneFileContext,
    sessionId: SessionId,
    commandId: string,
  ): Promise<PersistedSessionCommand | null> {
    const repository = await this.internalRepository(sessionId);
    return this.internalCommand(repository, commandId);
  },

getAttemptState(this: ControlPlaneFileContext, context: ControlPlaneRunContext, requireActiveLease = true) {
    return this.internalEnqueue(context.sessionId, async () => this.internalAssertRunContext(
      await this.internalRepository(context.sessionId), context, { requireActiveLease },
    ));
  },

async getRuntimeRoute(this: ControlPlaneFileContext, sessionId: SessionId, attemptId: string): Promise<RuntimeRouteRecord | null> {
    const repository = await this.internalRepository(sessionId);
    return (await repository.get('runtimeRoute', attemptId))?.data.route as RuntimeRouteRecord | undefined ?? null;
  },

commitRuntimeRoute(this: ControlPlaneFileContext, context: ControlPlaneRunContext, route: RuntimeRouteRecord): Promise<RuntimeRouteCommit> {
    const copy = cleanJson(route);
    return this.internalEnqueue(context.sessionId, async () => {
      const repository = await this.internalRepository(context.sessionId);
      const { run, attempt, command } = await this.internalAssertRunContext(repository, context);
      await assertNoRuntimeCancellation(repository, context.attemptId);
      if (run.status !== 'starting' || attempt.status !== 'starting') throw new Error('Runtime routing requires a starting attempt');
      if (command.agentRunId !== run.agentRunId && command.agentRunId) {
        const root = await this.internalRun(repository, command.agentRunId);
        const parentRoute = root?.activeAttemptId ? (await repository.get('runtimeRoute', root.activeAttemptId))?.data.route as RuntimeRouteRecord | undefined : undefined;
        if (!parentRoute || parentRoute.runtimeGeneration !== copy.runtimeGeneration) throw new Error('Child runtime must match its root generation');
      }
      return commitRuntimeRoute(repository, context, copy);
    });
  },

commitRuntimeRequest(this: ControlPlaneFileContext, context: ControlPlaneRunContext, key: string, payload: unknown): Promise<boolean> {
    const copy = cleanJson(payload);
    return this.internalEnqueue(context.sessionId, async () => {
      const repository = await this.internalRepository(context.sessionId);
      // Cancellation remains recordable for a current child after its root is
      // cancelled/fenced. It grants no work and must still reach physical Control.
      await this.internalAssertRunContext(repository, context, { requireActiveLease: key !== 'cancel' });
      if (key !== 'cancel') await assertNoRuntimeCancellation(repository, context.attemptId);
      return commitRuntimeRequest(repository, context, key, copy);
    });
  },

async getRun(this: ControlPlaneFileContext,
    sessionId: SessionId,
    agentRunId: string,
  ): Promise<AgentRun | null> {
    const repository = await this.internalRepository(sessionId);
    return this.internalRun(repository, agentRunId);
  },

async recordDivergences(this: ControlPlaneFileContext,
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
  },

recoverInterruptedRuns(this: ControlPlaneFileContext,
    reason = 'process-restart',
    occurredAt = new Date().toISOString(),
  ): Promise<number> {
    this.internalRecoveryPromise ??= this.internalPerformRecovery(reason, occurredAt);
    return this.internalRecoveryPromise;
  },

async internalPerformRecovery(this: ControlPlaneFileContext,
    reason: string,
    occurredAt: string,
  ): Promise<number> {
    await this.internalSessions.ensureCatalog();
    let recovered = 0;
    for (const entry of this.internalSessions.catalog.list()) {
      const sessionId = entry.session.id;
      recovered += await this.internalEnqueue(sessionId, async () => {
        const repository = await this.internalRepository(sessionId);
        const runs = (await this.internalListAll(repository, 'run'))
          .map(persistedRun)
          .filter((run): run is AgentRun => run != null);
        let count = 0;
        for (const run of runs) {
          const at = iso(occurredAt);
          const attempt = run.activeAttemptId
            ? await this.internalAttempt(repository, String(run.activeAttemptId))
            : null;
          if (TERMINAL_RUN_STATUSES.has(run.status)) continue;
          if (attempt && attempt.status !== 'terminal') {
            await this.internalUpdateAttempt(
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
          await this.internalUpdateRun(repository, {
            ...run,
            status: 'interrupted',
            terminalReason: run.terminalReason ?? reason,
            finishedAt: run.finishedAt ?? at,
            version: run.version + 1,
          });
          const command = await this.internalCommand(
            repository,
            String(run.commandId),
          );
          if (
            command &&
            !TERMINAL_COMMAND_STATUSES.has(command.status)
          ) {
            await this.internalUpdateCommand(repository, {
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
};
