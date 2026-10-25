import type { ControlPlaneAuthority } from './file-control-plane-store.js';
import { CONTROL_PLANE_SCHEMA_VERSION, asAgentRunAttemptId, asAgentRunId, asCorrelationId, asSessionCommandId, asSessionId, type AgentRunId, type SessionCommand, type SessionCommandKind, type SessionCommandStatus } from '@mcp/agent-runtime-contracts';
import { hashControlPlanePayload, type ControlPlaneCommandContext, type ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import { randomUUID } from 'node:crypto';
import { stableCommandKey, stableUuid, EXECUTOR_LEASE_MS, digest } from './control-plane-shadow-fingerprint.js';
import { measureAppend, metrics, recordMirrored } from './control-plane-shadow-queue.js';

interface AcceptLocalCoderCommandInput {
  store?: ControlPlaneAuthority | null;
  sessionId: ReturnType<typeof asSessionId>;
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
  actor?: SessionCommand['actor'];
}

export interface LocalCoderShadowAcceptance {
  outcome: 'accepted' | 'existing' | 'payload_conflict' | 'version_conflict';
  commandStatus?: SessionCommandStatus;
  /** Durable terminal reason, used to replay typed outcomes such as ACK loss. */
  commandReasonCode?: string;
  /** Durable correlation used to prove that a live worker bus owns this command. */
  agentRunId?: AgentRunId;
  executionBusId?: string;
  commandContext?: ControlPlaneCommandContext;
  runContext?: ControlPlaneRunContext;
}

function commandExecutionBusId(command: { result?: unknown }): string | undefined {
  if (!command.result || typeof command.result !== 'object') return undefined;
  const busId = (command.result as { busId?: unknown }).busId;
  return typeof busId === 'string' && busId.length > 0 ? busId : undefined;
}

export async function acceptLocalCoderCommand(
  input: AcceptLocalCoderCommandInput,
): Promise<LocalCoderShadowAcceptance | null> {
  // The command ledger is the idempotency authority, independently from the
  // diagnostic shadow flags. Journal/AgentRun projections remain separately
  // gated by their callers and the filesystem authority's journal setting.
  if (!input.store) return null;

  const requestedAt = input.requestedAt ?? new Date().toISOString();
  const identity = stableCommandKey(input);
  const sessionId = input.sessionId;
  const commandId = asSessionCommandId(
    stableUuid(`command:coder:${identity.digest}`),
  );
  const correlationId = asCorrelationId(
    stableUuid(`correlation:coder:${identity.digest}`),
  );
  const actor = input.actor ?? {
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
  const agentRunId = asAgentRunId(
    stableUuid(`agent-run:coder:${identity.digest}`),
  );
  const attemptId = asAgentRunAttemptId(
    stableUuid(`agent-run-attempt:coder:${identity.digest}:1`),
  );

  try {
    const result = await measureAppend(() => input.store!.acceptCommand({
      command,
      payloadHash: hashControlPlanePayload(command.payload),
      // Before this contract was stabilized, the first POST /messages was
      // persisted as `start` and later messages as `send_message`. Canonical
      // non-resume requests are now always `send_message`, but an old first
      // message must still win the same idempotency key during rolling upgrade.
      idempotencyKindAliases: input.kind === 'send_message' ? ['start'] : undefined,
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
            executorOwnerId: `coder-worker:${input.sessionId}:${agentRunId}`,
            executorExpiresAt: new Date(Date.parse(requestedAt) + EXECUTOR_LEASE_MS).toISOString(),
          }
        : undefined,
    }), 'acceptCommand');

    if (result.kind === 'accepted') {
      metrics.accepted += 1;
      recordMirrored('A', input.createRun ? 2 : 1);
    }
    else if (result.kind === 'existing') metrics.existing += 1;
    else if (result.kind === 'payload_conflict') metrics.payloadConflicts += 1;
    else metrics.versionConflicts += 1;

    if (result.kind === 'payload_conflict' || result.kind === 'version_conflict') {
      console.warn('[control-plane] command rejected', {
        sessionId: input.sessionId,
        kind: input.kind,
        outcome: result.kind,
      });
      return {
        outcome: result.kind,
        ...('command' in result ? { commandStatus: result.command.status } : {}),
        ...('command' in result && result.command.reasonCode
          ? { commandReasonCode: result.command.reasonCode }
          : {}),
        ...('command' in result && result.command.agentRunId
          ? { agentRunId: result.command.agentRunId }
          : {}),
        ...('command' in result && commandExecutionBusId(result.command)
          ? { executionBusId: commandExecutionBusId(result.command) }
          : {}),
      };
    }

    // A compatibility alias may return an older `start` row whose generated
    // command/correlation ids differ from the new `send_message` identity.
    // Every follow-up write must target the persisted winner, never the
    // uninserted canonical candidate.
    const persistedCommand = result.command;
    const commandContext: ControlPlaneCommandContext = {
      sessionId: persistedCommand.sessionId,
      commandId: persistedCommand.commandId,
      correlationId: persistedCommand.correlationId,
      actor: persistedCommand.actor,
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
    return {
      outcome: result.kind,
      commandStatus: result.command.status,
      ...(result.command.reasonCode ? { commandReasonCode: result.command.reasonCode } : {}),
      ...(result.command.agentRunId ? { agentRunId: result.command.agentRunId } : {}),
      ...(commandExecutionBusId(result.command)
        ? { executionBusId: commandExecutionBusId(result.command) }
        : {}),
      commandContext,
      runContext,
    };
  } catch (error) {
    metrics.writeErrors += 1;
    console.warn(
      `[control-plane] command accept failed session=${input.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export async function acceptLocalCompanyCommand(input: {
  store?: ControlPlaneAuthority | null;
  companySessionId: string;
  kind: Extract<SessionCommandKind, 'start' | 'resume'>;
  idempotencyKey?: string | null;
  fingerprint: Record<string, unknown>;
  requestedAt?: string;
}): Promise<LocalCoderShadowAcceptance | null> {
  if (!input.store) return null;
  const requestedAt = input.requestedAt ?? new Date().toISOString();
  const key = input.idempotencyKey ?? `server:${randomUUID()}`;
  const identity = digest(`company:${input.companySessionId}:${input.kind}:${key}`);
  const sessionId = asSessionId(input.companySessionId);
  const commandId = asSessionCommandId(
    stableUuid(`command:company:${identity}`),
  );
  const correlationId = asCorrelationId(
    stableUuid(`correlation:company:${identity}`),
  );
  const actor = {
    actorId: 'local-user',
    actorType: 'user' as const,
    source: 'company' as const,
  };
  const command: SessionCommand<Record<string, unknown>> = {
    schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
    commandId,
    idempotencyKey: key,
    kind: input.kind,
    sessionId,
    actor,
    requestedAt,
    correlationId,
    payload: input.fingerprint,
  };
  try {
    const result = await measureAppend(() => input.store!.acceptCommand({
      command,
      payloadHash: hashControlPlanePayload(command.payload),
    }), 'acceptCommand');
    if (result.kind === 'payload_conflict' || result.kind === 'version_conflict') {
      return {
        outcome: result.kind,
        ...('command' in result ? { commandStatus: result.command.status } : {}),
        ...('command' in result && result.command.reasonCode
          ? { commandReasonCode: result.command.reasonCode }
          : {}),
      };
    }
    const commandContext: ControlPlaneCommandContext = {
      sessionId,
      commandId,
      correlationId,
      actor,
    };
    return {
      outcome: result.kind,
      commandStatus: result.command.status,
      ...(result.command.reasonCode ? { commandReasonCode: result.command.reasonCode } : {}),
      ...(commandExecutionBusId(result.command)
        ? { executionBusId: commandExecutionBusId(result.command) }
        : {}),
      commandContext,
    };
  } catch (error) {
    metrics.writeErrors += 1;
    console.warn(
      `[control-plane] company command accept failed session=${input.companySessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
