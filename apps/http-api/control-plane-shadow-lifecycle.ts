import type { ControlPlaneAuthority } from './file-control-plane-store.js';
import { type ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import { CONTROL_PLANE_SCHEMA_VERSION, asRuntimeEventId, classifyCoderTerminalOutcome, runtimeEventClass, type ControlPlaneEventType } from '@mcp/agent-runtime-contracts';
import { type LocalCoderShadowAcceptance } from './control-plane-shadow-commands.js';
import { measureAppend, metrics, recordMirrored, enqueueShadowWrite } from './control-plane-shadow-queue.js';
import { EXECUTOR_LEASE_MS, opaqueValueHash, stableUuid, digest } from './control-plane-shadow-fingerprint.js';

export async function bindLocalCommandBus(
  store: ControlPlaneAuthority | null | undefined,
  acceptance: LocalCoderShadowAcceptance | null,
  busId: string,
): Promise<boolean> {
  if (!store || !acceptance?.commandContext) return false;
  try {
    await measureAppend(
      () => store.bindCommandExecution(acceptance.commandContext!, busId),
      'bindCommandExecution',
    );
    acceptance.commandStatus = 'running';
    acceptance.executionBusId = busId;
    return true;
  } catch (error) {
    metrics.writeErrors += 1;
    console.warn(
      `[control-plane] command bus binding failed command=${acceptance.commandContext.commandId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

export async function terminalizeLocalCoderCommand(
  store: ControlPlaneAuthority | null | undefined,
  acceptance: LocalCoderShadowAcceptance | null,
  input: { status: 'succeeded' | 'failed' | 'cancelled'; reason: string; errorRef?: string },
): Promise<void> {
  // Command terminal state is part of idempotency authority, not a shadow
  // projection. Callers await it so a racing retry observes terminal state
  // before any side-effect path can be re-entered.
  if (!store || !acceptance?.commandContext) return;
  try {
    await measureAppend(() => store.terminalizeCommand({
      context: acceptance.commandContext!,
      status: input.status,
      reason: input.reason,
      errorRef: input.errorRef,
      // Check under the authority queue, not in a preceding snapshot read:
      // the worker may commit its terminal between that read and this write.
      preserveExistingTerminal: true,
    }), 'terminalizeCommand');
    const current = acceptance.runContext
      ? (await store.getAttemptState(acceptance.runContext, false)).command : undefined;
    if (current && current.commandId !== acceptance.commandContext.commandId) throw new Error('Terminal command identity differs');
    acceptance.commandStatus = current?.status ?? input.status;
    acceptance.commandReasonCode = current?.reasonCode ?? input.reason;
    recordMirrored('A');
  } catch (error) {
    metrics.lifecycleErrors += 1;
    console.warn(
      `[control-plane] command terminalization failed command=${acceptance.commandContext.commandId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function markLocalCoderRunStarted(
  store: ControlPlaneAuthority | null | undefined,
  context: ControlPlaneRunContext | null | undefined,
  runnerRunId?: string,
): Promise<void> {
  if (!store || !context) return;
  // This transition establishes runner_run_id → AgentRun resolution used by
  // child fencing. It is authority, not observational journal traffic, so it
  // must be committed before a following tool/subagent event can overtake it.
  try {
    await measureAppend(
      () => store.markRunStarted(context, runnerRunId),
      'markRunStarted',
    );
    metrics.runsStarted += 1;
    recordMirrored('C');
  } catch (error) {
    metrics.lifecycleErrors += 1;
    console.warn(
      `[control-plane-agent-run] start failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function renewLocalCoderRunLease(
  store: ControlPlaneAuthority | null | undefined,
  context: ControlPlaneRunContext | null | undefined,
  at = new Date().toISOString(),
): Promise<boolean> {
  if (!store || !context) return false;
  try {
    await measureAppend(() => store.renewAttemptLease(
        context,
        new Date(Date.parse(at) + EXECUTOR_LEASE_MS).toISOString(),
        at,
      ), 'renewAttemptLease');
    metrics.leaseRenewals += 1;
    return true;
  } catch (error) {
    metrics.lifecycleErrors += 1;
    console.warn(
      `[control-plane-agent-run] lease renewal failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

export function mirrorLocalCoderToolBoundary(
  store: ControlPlaneAuthority | null | undefined,
  context: ControlPlaneRunContext | null | undefined,
  input: {
    phase: 'started' | 'completed';
    toolUseId: string;
    toolName: string;
    value?: unknown;
    durationMs?: number;
  },
): Promise<void> {
  if (!store || !context) return Promise.resolve();
  // Reduce before enqueueing: the backlog must never retain raw tool input or
  // result objects, even transiently. This mirrors ClaudeOpen's hook/event
  // boundary, where transport carries metadata rather than capability data.
  const valueHash = opaqueValueHash(input.value);
  const durationMs = input.durationMs ?? null;
  const phase = input.phase;
  const toolUseId = input.toolUseId;
  const toolName = input.toolName;
  return enqueueShadowWrite(`tool-${input.phase}`, async () => {
    await store.appendToolBoundary({
      context,
      toolUseId,
      toolName,
      phase,
      payload: {
        valueHash,
        durationMs,
      },
    });
    metrics.toolBoundaries += 1;
    recordMirrored('B');
  });
}

/**
 * Generic lifecycle mirror for the extended A–C runner vocabulary (approvals,
 * interactions, provider/compaction transitions, workflow/agents/worktree).
 * Payloads must already be reduced to ids/hashes/counts by the caller — the
 * redaction metadata records exactly which keys were projected.
 */
export function mirrorLocalCoderLifecycleEvent(
  store: ControlPlaneAuthority | null | undefined,
  context: ControlPlaneRunContext | null | undefined,
  input: {
    type: ControlPlaneEventType;
    payload: Record<string, unknown>;
    idempotencyKey?: string;
    occurredAt?: string;
  },
): Promise<void> {
  if (!store || !context) return Promise.resolve();
  // Compute hashes before enqueueing so the closure holds only the redacted,
  // bounded projection and stable identity — never the raw worker payload.
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const eventClass = runtimeEventClass(input.type);
  const eventKey = input.idempotencyKey ?? opaqueValueHash(input.payload);
  return enqueueShadowWrite(`lifecycle:${input.type}`, async () => {
    await store.appendRuntimeEvent({
        schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
        eventId: asRuntimeEventId(
          stableUuid(`evt:${context.agentRunId}:${input.type}:${eventKey}`),
        ),
        eventClass,
        partitionKey: context.sessionId,
        sessionId: context.sessionId,
        commandId: context.commandId,
        agentRunId: context.agentRunId,
        attemptId: context.attemptId,
        causationId: context.commandId,
        correlationId: context.correlationId,
        type: input.type,
        occurredAt,
        actor: context.actor,
        payload: input.payload,
        idempotencyKey: `lifecycle:${context.agentRunId}:${input.type}:${eventKey}`,
        redaction: { policyVersion: 'control-plane-shadow-v1', fields: Object.keys(input.payload), secretRefs: [] },
    });
    recordMirrored(eventClass);
  });
}

function terminalStatus(input: {
  event: 'done' | 'error';
  data: unknown;
  mode?: 'normal' | 'worker_crash' | 'worker_start_failure' | 'evicted' | 'authority_lost';
}): {
  runStatus: 'completed' | 'failed' | 'aborted' | 'interrupted';
  commandStatus: 'succeeded' | 'failed' | 'cancelled';
  reason: string;
  errorRef?: string;
  leaseStatus: 'released' | 'fenced';
} {
  const data = input.data && typeof input.data === 'object'
    ? input.data as Record<string, unknown>
    : {};
  const reason = typeof data.reason === 'string'
    ? data.reason
    : input.mode === 'worker_crash'
      ? 'worker-crashed'
      : input.mode === 'worker_start_failure'
        ? 'worker-runFresh-failed'
      : input.mode === 'evicted'
        ? 'worker-evicted'
        : input.mode === 'authority_lost'
          ? 'control-plane-authority-lost'
        : input.event === 'error'
          ? 'error'
          : 'completed';
  const rawError = typeof data.error === 'string'
    ? data.error
    : typeof data.message === 'string'
      ? data.message
      : undefined;
  const errorRef = rawError ? `error:sha256:${digest(rawError)}` : undefined;

  if (
    input.mode === 'worker_crash'
    || input.mode === 'worker_start_failure'
    || input.mode === 'evicted'
    || input.mode === 'authority_lost'
  ) {
    return { runStatus: 'interrupted', commandStatus: 'failed', reason, errorRef, leaseStatus: 'fenced' };
  }
  const terminal = classifyCoderTerminalOutcome({
    event: input.event,
    reason,
    error: data.error,
    message: data.message,
  });
  if (terminal.classification === 'cancelled') {
    return { runStatus: 'aborted', commandStatus: 'cancelled', reason, errorRef, leaseStatus: 'released' };
  }
  if (terminal.classification === 'interrupted') {
    return { runStatus: 'interrupted', commandStatus: 'failed', reason, errorRef, leaseStatus: 'released' };
  }
  if (terminal.classification === 'failed') {
    return { runStatus: 'failed', commandStatus: 'failed', reason, errorRef, leaseStatus: 'released' };
  }
  return { runStatus: 'completed', commandStatus: 'succeeded', reason, errorRef, leaseStatus: 'released' };
}

export async function terminalizeLocalCoderRun(
  store: ControlPlaneAuthority | null | undefined,
  context: ControlPlaneRunContext | null | undefined,
  input: {
    event: 'done' | 'error';
    data: unknown;
    mode?: 'normal' | 'worker_crash' | 'worker_start_failure' | 'evicted' | 'authority_lost';
  },
): Promise<void> {
  if (!store || !context) return;
  const terminal = terminalStatus(input);
  const terminalInput = {
      context,
      status: terminal.runStatus,
      commandStatus: terminal.commandStatus,
      reason: terminal.reason,
      errorRef: terminal.errorRef,
      attemptLeaseStatus: terminal.leaseStatus,
  };
  // Run + command terminal state is idempotency authority. CoderWorkerPool
  // marks/publishes the bus terminal first, then callers await this authority
  // commit before admitting a retry.
  try {
    await measureAppend(async () => {
      if (
        input.mode === 'worker_crash'
        || input.mode === 'worker_start_failure'
        || input.mode === 'evicted'
        || input.mode === 'authority_lost'
      ) {
        await store.interruptRun(terminalInput);
      } else {
        await store.terminalizeRun(terminalInput);
      }
    }, 'terminalizeRun');
    metrics.runsTerminalized += 1;
    recordMirrored('A');
    recordMirrored('C');
  } catch (error) {
    metrics.lifecycleErrors += 1;
    console.warn(
      `[control-plane-agent-run] terminalization failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
