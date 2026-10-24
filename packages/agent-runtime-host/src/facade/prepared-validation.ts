import {
  isResolvedAgentRun,
  type AgentRunId,
} from '@mcp/agent-runtime-contracts';
import { AgentRuntimeHostError } from '../errors.js';
import { assertLegacyPreparation } from './legacy-prepared-validation.js';
import type {
  ExecutableAgentAttempt,
  ResumeAgentCommand,
  StartAgentCommand,
} from './types.js';

function reject(detail: string): never {
  throw new AgentRuntimeHostError(
    'prepared_attempt_mismatch',
    `Prepared attempt is not executable: ${detail}`,
  );
}

function unixMs(value: string, field: string): bigint {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) reject(`${field} is not a safe timestamp`);
  return BigInt(parsed);
}

export function assertPreparedAttempt(
  prepared: ExecutableAgentAttempt,
  command: StartAgentCommand | ResumeAgentCommand,
  now: Date,
  expectedAgentRunId?: AgentRunId,
): void {
  assertPreparedAttemptCurrent(prepared, now);
  const { authority, routing, run } = prepared;
  if (
    authority.sessionId !== command.sessionId
    || authority.commandId !== command.commandId
    || authority.correlationId !== command.correlationId
    || routing.eligibility.surface !== command.payload.surface
    || routing.preference !== command.payload.runtimePreference
  ) {
    reject('accepted command does not match prepared authority or routing');
  }
  if (expectedAgentRunId && run.agentRunId !== expectedAgentRunId) {
    reject('resume returned a different AgentRun');
  }
  if (command.kind === 'start') {
    if (command.payload.admittedPreparationRef !== prepared.admission.preparationRef) {
      reject('start command does not reference its prepared input');
    }
  }
}

export function assertPreparedAttemptCurrent(
  prepared: ExecutableAgentAttempt,
  now: Date,
): void {
  const { authority, attempt, routing, run } = prepared;
  if (
    !isResolvedAgentRun(run)
    || run.status !== 'starting'
    || run.activeAttemptId !== attempt.attemptId
    || attempt.status !== 'starting'
    || attempt.agentRunId !== run.agentRunId
    || attempt.executorLease.status !== 'active'
    || !Number.isSafeInteger(attempt.executorLease.fencingEpoch)
    || attempt.executorLease.fencingEpoch <= 0
  ) {
    reject('run, attempt, resolution, or active lease state is inconsistent');
  }
  if (
    authority.sessionId !== run.sessionId
    || authority.commandId !== run.commandId
    || authority.agentRunId !== run.agentRunId
    || authority.attemptId !== attempt.attemptId
    || authority.executorOwnerId !== attempt.executorLease.ownerId
    || authority.fencingEpoch !== BigInt(attempt.executorLease.fencingEpoch)
    || authority.leaseExpiresAtUnixMs
      !== unixMs(attempt.executorLease.expiresAt, 'lease expiry')
    || authority.leaseExpiresAtUnixMs <= BigInt(now.getTime())
    || authority.deadlineAtUnixMs <= BigInt(now.getTime())
  ) {
    reject('authority is stale, expired, or does not match the active lease');
  }
  if (
    routing.sessionId !== run.sessionId
    || routing.agentRunId !== run.agentRunId
    || routing.attemptId !== attempt.attemptId
    || routing.eligibility.provider !== run.effectiveProvider
  ) {
    reject('routing does not match command, run, or effective provider');
  }
  assertLegacyPreparation(prepared);
}
