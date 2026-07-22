import { createHash, randomUUID } from 'node:crypto';
import {
  CONTROL_PLANE_SCHEMA_VERSION,
  asAgentRunAttemptId,
  asAgentRunId,
  asCorrelationId,
  asSessionCommandId,
  asSessionId,
  type AgentRunId,
  type SessionCommand,
  type SessionCommandKind,
} from '@mcp/agent-runtime-contracts';
import {
  hashControlPlanePayload,
  type ControlPlaneCommandContext,
  type ControlPlaneRunContext,
  type ControlPlaneStore,
} from '@mcp/store/control-plane/index.js';

const EXECUTOR_LEASE_MS = 10 * 60_000;

export interface CoderControlPlaneShadowMetrics {
  accepted: number;
  existing: number;
  payloadConflicts: number;
  versionConflicts: number;
  runsStarted: number;
  runsTerminalized: number;
  toolBoundaries: number;
  leaseRenewals: number;
  writeErrors: number;
  lifecycleErrors: number;
}

const metrics: CoderControlPlaneShadowMetrics = {
  accepted: 0,
  existing: 0,
  payloadConflicts: 0,
  versionConflicts: 0,
  runsStarted: 0,
  runsTerminalized: 0,
  toolBoundaries: 0,
  leaseRenewals: 0,
  writeErrors: 0,
  lifecycleErrors: 0,
};

export function coderControlPlaneShadowEnabled(): boolean {
  return process.env.CODER_CONTROL_PLANE_SHADOW === '1';
}

export function coderRuntimeJournalShadowEnabled(): boolean {
  return coderControlPlaneShadowEnabled() && process.env.CODER_RUNTIME_JOURNAL_SHADOW === '1';
}

export function snapshotCoderControlPlaneShadowMetrics(): CoderControlPlaneShadowMetrics {
  return { ...metrics };
}

export function resetCoderControlPlaneShadowMetricsForTests(): void {
  for (const key of Object.keys(metrics) as Array<keyof CoderControlPlaneShadowMetrics>) metrics[key] = 0;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function opaqueValueHash(value: unknown): string {
  try {
    return hashControlPlanePayload(value);
  } catch {
    const shape = value === null
      ? 'null'
      : Array.isArray(value)
        ? `array:${value.length}`
        : typeof value === 'object'
          ? `object:${Object.keys(value as object).sort().join(',')}`
          : typeof value;
    return digest(`non-json:${shape}`);
  }
}

function stableCommandKey(input: {
  legacySessionId: number;
  kind: SessionCommandKind;
  idempotencyKey?: string | null;
}): { key: string; digest: string } {
  const key = input.idempotencyKey ?? `server:${randomUUID()}`;
  return {
    key,
    digest: digest(`coder:${input.legacySessionId}:${input.kind}:${key}`),
  };
}

export interface LocalCoderMessageFingerprintInput {
  content?: string;
  attachments?: Array<{ name: string; mediaType: string; base64?: string; text?: string }>;
  resume?: boolean;
  agent?: string | null;
  profile?: string | null;
  planMode?: boolean;
  maxTurns?: number;
  selectedSkillIds?: string[];
  worktree?: { name?: string; branch?: string };
}

export function fingerprintLocalCoderMessage(input: LocalCoderMessageFingerprintInput): Record<string, unknown> {
  return {
    contentHash: digest(input.content ?? ''),
    contentChars: input.content?.length ?? 0,
    attachments: (input.attachments ?? []).map((attachment) => ({
      name: attachment.name,
      mediaType: attachment.mediaType,
      contentHash: digest(attachment.base64 ?? attachment.text ?? ''),
      encodedChars: attachment.base64?.length ?? attachment.text?.length ?? 0,
    })),
    resume: input.resume === true,
    agent: input.agent ?? null,
    profile: input.profile ?? null,
    planMode: input.planMode === true,
    maxTurns: input.maxTurns ?? null,
    selectedSkillIds: [...(input.selectedSkillIds ?? [])].sort(),
    worktree: input.worktree
      ? { name: input.worktree.name ?? null, branch: input.worktree.branch ?? null }
      : null,
  };
}

export interface AcceptLocalCoderCommandInput {
  store?: ControlPlaneStore | null;
  legacySessionId: number;
  kind: SessionCommandKind;
  idempotencyKey?: string | null;
  fingerprint: Record<string, unknown>;
  createRun: boolean;
  linkedAgentRunId?: AgentRunId;
  role: string;
  agentDefinitionId: string;
  requestedProvider?: string;
  requestedModel?: string;
  requestedReasoningEffort?: string;
  requestedPreset?: string;
  requestedCapabilityProfile: string;
  requestedAt?: string;
}

export interface LocalCoderShadowAcceptance {
  outcome: 'accepted' | 'existing' | 'payload_conflict' | 'version_conflict';
  commandContext?: ControlPlaneCommandContext;
  runContext?: ControlPlaneRunContext;
}

export function acceptLocalCoderCommand(
  input: AcceptLocalCoderCommandInput,
): LocalCoderShadowAcceptance | null {
  if (!coderControlPlaneShadowEnabled() || !input.store) return null;

  const requestedAt = input.requestedAt ?? new Date().toISOString();
  const identity = stableCommandKey(input);
  const sessionId = asSessionId(`session:coder:${input.legacySessionId}`);
  const commandId = asSessionCommandId(`command:coder:${identity.digest}`);
  const correlationId = asCorrelationId(`correlation:coder:${identity.digest}`);
  const actor = {
    actorId: 'local-user',
    actorType: 'user' as const,
    source: 'http' as const,
  };
  const command: SessionCommand<Record<string, unknown>> = {
    schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
    commandId,
    idempotencyKey: identity.key,
    kind: input.kind,
    sessionId,
    actor,
    requestedAt,
    correlationId,
    payload: input.fingerprint,
  };
  const agentRunId = asAgentRunId(`agent-run:coder:${identity.digest}`);
  const attemptId = asAgentRunAttemptId(`agent-run-attempt:coder:${identity.digest}:1`);

  try {
    const result = input.store.acceptCommand({
      command,
      payloadHash: hashControlPlanePayload(command.payload),
      legacySessionId: input.legacySessionId,
      linkedAgentRunId: input.linkedAgentRunId,
      run: input.createRun
        ? {
            agentRunId,
            attemptId,
            role: input.role,
            agentDefinitionId: input.agentDefinitionId,
            waitMode: 'foreground',
            requestedProvider: input.requestedProvider,
            requestedModel: input.requestedModel,
            requestedReasoningEffort: input.requestedReasoningEffort,
            requestedPreset: input.requestedPreset,
            requestedCapabilityProfile: input.requestedCapabilityProfile,
            executorOwnerId: `coder-worker:${input.legacySessionId}:${agentRunId}`,
            executorExpiresAt: new Date(Date.parse(requestedAt) + EXECUTOR_LEASE_MS).toISOString(),
          }
        : undefined,
    });

    if (result.kind === 'accepted') metrics.accepted += 1;
    else if (result.kind === 'existing') metrics.existing += 1;
    else if (result.kind === 'payload_conflict') metrics.payloadConflicts += 1;
    else metrics.versionConflicts += 1;

    if (result.kind === 'payload_conflict' || result.kind === 'version_conflict') {
      console.warn('[control-plane-shadow] command divergence', {
        sessionId: input.legacySessionId,
        kind: input.kind,
        outcome: result.kind,
      });
      return { outcome: result.kind };
    }

    const commandContext: ControlPlaneCommandContext = {
      sessionId,
      legacySessionId: input.legacySessionId,
      commandId,
      correlationId,
      actor,
    };
    const runContext = input.createRun
      && result.agentRun
      && result.attempt
      && result.attempt.status !== 'terminal'
      && result.attempt.executorLease.status === 'active'
      ? {
          ...commandContext,
          agentRunId: result.agentRun.agentRunId,
          attemptId: result.attempt.attemptId,
          executorOwnerId: result.attempt.executorLease.ownerId,
          fencingEpoch: result.attempt.executorLease.fencingEpoch,
        }
      : undefined;
    return { outcome: result.kind, commandContext, runContext };
  } catch (error) {
    metrics.writeErrors += 1;
    console.warn(
      `[control-plane-shadow] command mirror failed session=${input.legacySessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export function terminalizeLocalCoderCommand(
  store: ControlPlaneStore | null | undefined,
  acceptance: LocalCoderShadowAcceptance | null,
  input: { status: 'succeeded' | 'failed' | 'cancelled'; reason: string; errorRef?: string },
): void {
  if (!store || !acceptance?.commandContext) return;
  try {
    store.terminalizeCommand({
      context: acceptance.commandContext,
      status: input.status,
      reason: input.reason,
      errorRef: input.errorRef,
    });
  } catch (error) {
    metrics.lifecycleErrors += 1;
    console.warn(
      `[control-plane-shadow] command terminal mirror failed command=${acceptance.commandContext.commandId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function markLocalCoderRunStarted(
  store: ControlPlaneStore | null | undefined,
  context: ControlPlaneRunContext | null | undefined,
  runnerRunId?: string,
): void {
  if (!store || !context) return;
  try {
    store.markRunStarted(context, runnerRunId);
    metrics.runsStarted += 1;
  } catch (error) {
    metrics.lifecycleErrors += 1;
    console.warn(
      `[control-plane-shadow] run-start mirror failed run=${context.agentRunId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function renewLocalCoderRunLease(
  store: ControlPlaneStore | null | undefined,
  context: ControlPlaneRunContext | null | undefined,
  at = new Date().toISOString(),
): void {
  if (!store || !context) return;
  try {
    store.runs.renewAttemptLease(
      context,
      new Date(Date.parse(at) + EXECUTOR_LEASE_MS).toISOString(),
      at,
    );
    metrics.leaseRenewals += 1;
  } catch (error) {
    metrics.lifecycleErrors += 1;
    console.warn(
      `[control-plane-shadow] lease renewal failed run=${context.agentRunId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function mirrorLocalCoderToolBoundary(
  store: ControlPlaneStore | null | undefined,
  context: ControlPlaneRunContext | null | undefined,
  input: {
    phase: 'started' | 'completed';
    toolUseId: string;
    toolName: string;
    value?: unknown;
    durationMs?: number;
  },
): void {
  if (!store || !context || !coderRuntimeJournalShadowEnabled()) return;
  try {
    store.appendToolBoundary({
      context,
      toolUseId: input.toolUseId,
      toolName: input.toolName,
      phase: input.phase,
      payload: {
        valueHash: opaqueValueHash(input.value),
        durationMs: input.durationMs ?? null,
      },
    });
    metrics.toolBoundaries += 1;
  } catch (error) {
    metrics.lifecycleErrors += 1;
    console.warn(
      `[control-plane-shadow] tool boundary mirror failed run=${context.agentRunId} tool=${input.toolName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function terminalStatus(input: {
  event: 'done' | 'error';
  data: unknown;
  mode?: 'normal' | 'worker_crash' | 'worker_start_failure' | 'evicted';
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
  ) {
    return { runStatus: 'interrupted', commandStatus: 'failed', reason, errorRef, leaseStatus: 'fenced' };
  }
  if (reason === 'aborted') {
    return { runStatus: 'aborted', commandStatus: 'cancelled', reason, errorRef, leaseStatus: 'released' };
  }
  const failed = input.event === 'error'
    || ['error', 'recovery_capped', 'doom_loop', 'compact_failure', 'compact_exhausted'].includes(reason);
  return failed
    ? { runStatus: 'failed', commandStatus: 'failed', reason, errorRef, leaseStatus: 'released' }
    : { runStatus: 'completed', commandStatus: 'succeeded', reason, errorRef, leaseStatus: 'released' };
}

export function terminalizeLocalCoderRun(
  store: ControlPlaneStore | null | undefined,
  context: ControlPlaneRunContext | null | undefined,
  input: {
    event: 'done' | 'error';
    data: unknown;
    mode?: 'normal' | 'worker_crash' | 'worker_start_failure' | 'evicted';
  },
): void {
  if (!store || !context) return;
  const terminal = terminalStatus(input);
  try {
    const terminalInput = {
      context,
      status: terminal.runStatus,
      commandStatus: terminal.commandStatus,
      reason: terminal.reason,
      errorRef: terminal.errorRef,
      attemptLeaseStatus: terminal.leaseStatus,
    };
    if (
      input.mode === 'worker_crash'
      || input.mode === 'worker_start_failure'
      || input.mode === 'evicted'
    ) {
      store.interruptRun(terminalInput);
    } else {
      store.terminalizeRun(terminalInput);
    }
    metrics.runsTerminalized += 1;
  } catch (error) {
    metrics.lifecycleErrors += 1;
    console.warn(
      `[control-plane-shadow] run terminal mirror failed run=${context.agentRunId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
