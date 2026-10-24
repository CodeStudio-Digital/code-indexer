import { randomUUID } from 'node:crypto';
import { asAgentRunId, asAgentRunAttemptId, asCorrelationId, asSessionCommandId, type SessionCommand } from '@mcp/agent-runtime-contracts';
import { hashControlPlanePayload, type ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import type { FileControlPlaneAuthority } from './file-control-plane-store.js';
import type { NativeCoderDevelopmentConfig } from './workers/native-coder-execution.js';
import { readNativeWorktreeTransition } from './workers/native-worktree-transition-recovery.js';

export async function admitNativeWorktreeContinuation(store: FileControlPlaneAuthority,
  config: NativeCoderDevelopmentConfig, transitionId: string, assertOwner: () => void, signal: AbortSignal): Promise<ControlPlaneRunContext> {
  assertOwner(); signal.throwIfAborted();
  const previous = await store.getAttemptState(config.context, false);
  if (previous.run.status !== 'interrupted' || previous.run.terminalReason !== 'workspace_transition'
    || previous.run.parentAgentRunId) throw new Error('Workspace transition requires a closed root attempt');
  const { intent } = await readNativeWorktreeTransition(config, signal);
  if (intent.id !== transitionId) throw new Error('Workspace transition admission differs from its committed result');
  assertOwner(); signal.throwIfAborted();
  const context = { ...config.context, commandId: asSessionCommandId(randomUUID()), correlationId: asCorrelationId(randomUUID()),
    agentRunId: asAgentRunId(randomUUID()), attemptId: asAgentRunAttemptId(randomUUID()), executorOwnerId: `workspace:${randomUUID()}`, fencingEpoch: 1 };
  const command: SessionCommand = { schemaVersion: 1, commandId: context.commandId, sessionId: context.sessionId,
    correlationId: context.correlationId, actor: context.actor, requestedAt: new Date().toISOString(), kind: 'resume',
    idempotencyKey: `workspace:${config.context.attemptId}:${intent.id}`, payload: { sourceAttemptId: config.context.attemptId, transitionId: intent.id } };
  const accepted = await store.acceptCommand({ command, payloadHash: hashControlPlanePayload(command.payload), run: {
    ...context, role: previous.run.role, agentDefinitionId: previous.run.effectivePreset ?? previous.run.role, waitMode: 'foreground',
    requestedProvider: previous.run.effectiveProvider, requestedModel: previous.run.effectiveModel,
    requestedReasoningEffort: previous.run.effectiveReasoningEffort, requestedPreset: previous.run.effectivePreset,
    // The exact previous capability set is resealed by the worker. This label
    // records why a new command exists; it does not broaden the tool catalog.
    requestedCapabilityProfile: 'workspace-continuation',
    executorExpiresAt: new Date(Date.now() + 600_000).toISOString(),
  } });
  // An ACK lost after admission must not manufacture another executor. The
  // caller caches this Promise for transport retries within its live owner.
  if (accepted.kind !== 'accepted') throw new Error('Workspace continuation admission already exists or conflicts; reconcile before relaunch');
  try { assertOwner(); signal.throwIfAborted(); return context; }
  catch (cause) {
    await store.terminalizeRun({ context, status: 'failed', commandStatus: 'failed', reason: 'workspace_transition_admission_cancelled' });
    throw cause;
  }
}
