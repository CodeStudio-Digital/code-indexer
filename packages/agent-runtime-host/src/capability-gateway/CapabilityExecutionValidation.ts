import { createHash, timingSafeEqual } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import {
  agentV1Capability,
} from '@mcp/agent-runtime-contracts';
import type { HostDataBoundContext } from '../ipc/HostDataAttemptChannelValidation.js';
import { attemptIdentityEqual } from '../ipc/FrameHeaderValidation.js';
import { CapabilityGatewayError } from './CapabilityGatewayError.js';
import type {
  HostCapabilityExecutionOutcome,
  ValidatedCapabilityPrepare,
} from './CapabilityGatewayTypes.js';

export function validateCapabilityExecute(
  value: agentV1Capability.CapabilityExecute,
  context: HostDataBoundContext,
  request: ValidatedCapabilityPrepare,
  grant: agentV1Capability.SealedExecutionGrant,
  nowUnixMs: bigint,
): void {
  if (
    !value.identity
    || !attemptIdentityEqual(value.identity, context.identity)
    || value.runtimeInstanceId !== context.runtimeInstanceId
    || value.operationId !== request.operationId
    || value.toolUseId !== request.toolUseId
    || value.grantId !== grant.grantId
    || request.executionClass
      !== agentV1Capability.CapabilityExecutionClass.HOST_CAPABILITY
    || grant.executionClass
      !== agentV1Capability.CapabilityExecutionClass.HOST_CAPABILITY
    || value.deadlineAtUnixMs !== request.deadlineAtUnixMs
    || value.deadlineAtUnixMs <= nowUnixMs
    || grant.expiresAtUnixMs <= nowUnixMs
    || value.effectiveInputSha256.byteLength !== 32
    || !timingSafeEqual(value.effectiveInputSha256, request.inputSha256)
  ) throw new CapabilityGatewayError(
    'invalid_prepare',
    'CapabilityExecute authority is invalid',
  );
}

export function executionResult(
  request: ValidatedCapabilityPrepare,
  grant: agentV1Capability.SealedExecutionGrant,
  context: HostDataBoundContext,
  outcome: HostCapabilityExecutionOutcome,
  maximumOutputBytes: number,
): agentV1Capability.CapabilityExecutionResult {
  return create(agentV1Capability.CapabilityExecutionResultSchema, {
    identity: request.identity,
    runtimeInstanceId: context.runtimeInstanceId,
    operationId: request.operationId,
    toolUseId: request.toolUseId,
    grantId: grant.grantId,
    outcome: mapOutcome(outcome, maximumOutputBytes),
  });
}

export function ambiguousExecutionResult(
  request: ValidatedCapabilityPrepare,
  grant: agentV1Capability.SealedExecutionGrant,
  context: HostDataBoundContext,
): agentV1Capability.CapabilityExecutionResult {
  return executionResult(request, grant, context, {
    case: 'outcomeUnknown',
    reasonCode: 'host_executor_result_ambiguous',
    durationMs: 0n,
  }, 1);
}

function mapOutcome(
  outcome: HostCapabilityExecutionOutcome,
  maximumOutputBytes: number,
): agentV1Capability.CapabilityExecutionResult['outcome'] {
  if (outcome.case !== 'succeeded') {
    if (!identifier(outcome.reasonCode) || !validDuration(outcome.durationMs)) {
      throw invalidOutcome();
    }
    const value = create(agentV1Capability.CapabilityExecutionFailureSchema, {
      reasonCode: outcome.reasonCode,
      durationMs: outcome.durationMs,
    });
    return outcome.case === 'outcomeUnknown'
      ? { case: 'outcomeUnknown', value }
      : { case: outcome.case, value };
  }
  if (
    !identifier(outcome.schemaId)
    || !Number.isSafeInteger(outcome.schemaVersion)
    || outcome.schemaVersion <= 0
    || outcome.encodedResult.byteLength === 0
    || outcome.encodedResult.byteLength > maximumOutputBytes
    || outcome.bytesRead < 0n
    || !validDuration(outcome.durationMs)
  ) throw invalidOutcome();
  const encodedResult = Uint8Array.from(outcome.encodedResult);
  return {
    case: 'succeeded',
    value: create(agentV1Capability.CapabilityExecutionSucceededSchema, {
      schemaId: outcome.schemaId,
      schemaVersion: outcome.schemaVersion,
      encodedResult,
      resultSha256: createHash('sha256').update(encodedResult).digest(),
      bytesRead: outcome.bytesRead,
      bytesEmitted: BigInt(encodedResult.byteLength),
      truncated: outcome.truncated,
      durationMs: outcome.durationMs,
    }),
  };
}

function identifier(value: string): boolean {
  return value.length > 0 && value.length <= 1_024 && !value.includes('\0');
}

function validDuration(value: bigint): boolean {
  return value >= 0n && value <= 24n * 60n * 60n * 1_000n;
}

function invalidOutcome(): CapabilityGatewayError {
  return new CapabilityGatewayError(
    'invalid_decision',
    'Host capability execution outcome is invalid',
  );
}
