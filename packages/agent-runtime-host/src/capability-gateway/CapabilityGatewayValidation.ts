import { createHash, timingSafeEqual } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import { clone, create, toBinary } from '@bufbuild/protobuf';
import {
  agentV1Capability,
  agentV1Common,
} from '@mcp/agent-runtime-contracts';
import type { HostDataBoundContext } from '../ipc/HostDataAttemptChannelValidation.js';
import { attemptIdentityEqual } from '../ipc/FrameHeaderValidation.js';
import { CapabilityGatewayError } from './CapabilityGatewayError.js';
import type {
  CapabilityResolution,
  ValidatedCapabilityPrepare,
} from './CapabilityGatewayTypes.js';

const MAX_ID_BYTES = 1_024;
const MAX_NATIVE_READ_BYTES = 64 * 1024 * 1024;

export function validateCapabilityPrepare(
  value: agentV1Capability.CapabilityPrepare,
  context: HostDataBoundContext,
  maximumInputBytes: number,
  nowUnixMs: bigint,
): ValidatedCapabilityPrepare {
  const executionClass = value.executionClass;
  if (
    !value.identity
    || !attemptIdentityEqual(value.identity, context.identity)
    || value.runtimeInstanceId !== context.runtimeInstanceId
    || !idsValid([
      value.operationId,
      value.providerOperationId,
      value.toolUseId,
      value.capabilityId,
      value.capabilityVersion,
      value.idempotencyKey,
    ])
    || executionClass === agentV1Capability.CapabilityExecutionClass.UNSPECIFIED
    || !(executionClass in agentV1Capability.CapabilityExecutionClass)
    || (value.mutates
      && executionClass === agentV1Capability.CapabilityExecutionClass.NATIVE_READ)
    || value.encodedJsonInput.byteLength === 0
    || value.encodedJsonInput.byteLength > maximumInputBytes
    || value.inputSha256.byteLength !== 32
    || value.capabilitySetSha256.byteLength !== 32
    || !sameDigest(value.inputSha256, digest(value.encodedJsonInput))
    || value.deadlineAtUnixMs <= nowUnixMs
  ) throw invalid('CapabilityPrepare authority is invalid');
  try {
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value.encodedJsonInput));
  } catch (cause) {
    throw invalid('CapabilityPrepare input is not UTF-8 JSON', cause);
  }
  return Object.freeze({
    identity: clone(agentV1Common.AttemptIdentitySchema, value.identity),
    runtimeInstanceId: value.runtimeInstanceId,
    operationId: value.operationId,
    providerOperationId: value.providerOperationId,
    toolUseId: value.toolUseId,
    capabilityId: value.capabilityId,
    capabilityVersion: value.capabilityVersion,
    executionClass,
    mutates: value.mutates,
    encodedJsonInput: Uint8Array.from(value.encodedJsonInput),
    inputSha256: Uint8Array.from(value.inputSha256),
    capabilitySetSha256: Uint8Array.from(value.capabilitySetSha256),
    idempotencyKey: value.idempotencyKey,
    deadlineAtUnixMs: value.deadlineAtUnixMs,
  });
}

export function capabilityResolutionToUpdate(
  resolution: CapabilityResolution,
  request: ValidatedCapabilityPrepare,
  nowUnixMs: bigint,
): agentV1Capability.CapabilityUpdate {
  validateResolution(resolution, request, nowUnixMs);
  return create(agentV1Capability.CapabilityUpdateSchema, {
    identity: request.identity,
    runtimeInstanceId: request.runtimeInstanceId,
    operationId: request.operationId,
    toolUseId: request.toolUseId,
    decision: resolution,
  });
}

function validateResolution(
  resolution: CapabilityResolution,
  request: ValidatedCapabilityPrepare,
  nowUnixMs: bigint,
): void {
  if (resolution.case === 'rejected') {
    const value = resolution.value;
    if (!idsValid([value.decisionId, value.reasonCode, value.policyVersion])
      || !localTimestamp(value.decidedAtUnixMs, nowUnixMs)) {
      throw decision('rejection');
    }
    return;
  }
  if (resolution.case === 'approvalRequired') {
    const value = resolution.value;
    if (!idsValid([
      value.decisionId,
      value.interactionId,
      value.reasonCode,
      value.policyVersion,
    ]) || !localTimestamp(value.decidedAtUnixMs, nowUnixMs)) {
      throw decision('approval');
    }
    return;
  }
  const grant = resolution.value;
  const nativeRead = grant.nativeFilesystemRead;
  const isNativeRead = grant.executionClass
    === agentV1Capability.CapabilityExecutionClass.NATIVE_READ;
  const leaseFields = [
    grant.workspaceLeaseId,
    grant.workspaceLeaseVersion,
    grant.workspaceFencingEpoch,
  ].filter((value) => value !== undefined).length;
  if (
    !idsValid([
      grant.grantId,
      grant.decisionId,
      grant.capabilityId,
      grant.capabilityVersion,
      grant.operationId,
      grant.toolUseId,
      grant.environmentId,
      grant.resourceBindingId,
      grant.policyVersion,
    ])
    || grant.capabilityId !== request.capabilityId
    || grant.capabilityVersion !== request.capabilityVersion
    || grant.operationId !== request.operationId
    || grant.toolUseId !== request.toolUseId
    || grant.executionClass !== request.executionClass
    || grant.mutates !== request.mutates
    || !sameDigest(grant.effectiveInputSha256, request.inputSha256)
    || grant.constraintsSha256.byteLength !== 32
    || grant.nonce.byteLength < 16
    || grant.environmentVersion === 0n
    || grant.issuedAtUnixMs <= 0n
    || grant.issuedAtUnixMs > nowUnixMs + 50n
    || grant.expiresAtUnixMs <= nowUnixMs
    || grant.expiresAtUnixMs > request.deadlineAtUnixMs
    || (leaseFields !== 0 && leaseFields !== 3)
    || grant.workspaceLeaseId === ''
    || grant.workspaceLeaseVersion === 0n
    || grant.workspaceFencingEpoch === 0n
    || (isNativeRead !== (nativeRead !== undefined))
    || (nativeRead !== undefined && (
      !isAbsolute(nativeRead.canonicalRootPath)
      || normalize(nativeRead.canonicalRootPath) !== nativeRead.canonicalRootPath
      || nativeRead.canonicalRootPath.includes('\0')
      || nativeRead.maxReadBytes === 0n
      || nativeRead.maxReadBytes > BigInt(MAX_NATIVE_READ_BYTES)
      || nativeRead.maxOutputBytes === 0n
      || nativeRead.maxOutputBytes > BigInt(MAX_NATIVE_READ_BYTES)
      || !sameDigest(
        grant.constraintsSha256,
        digest(toBinary(
          agentV1Capability.NativeFilesystemReadBindingSchema,
          nativeRead,
        )),
      )
    ))
  ) throw decision('grant');
}

function idsValid(values: readonly string[]): boolean {
  return values.every((value) => value.length > 0
    && value.length <= MAX_ID_BYTES
    && !value.includes('\0'));
}

function localTimestamp(value: bigint, now: bigint): boolean {
  return value >= now - 50n && value <= now + 50n;
}

function digest(value: Uint8Array): Uint8Array {
  return createHash('sha256').update(value).digest();
}

function sameDigest(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === 32
    && right.byteLength === 32
    && timingSafeEqual(left, right);
}

function invalid(message: string, cause?: unknown): CapabilityGatewayError {
  return new CapabilityGatewayError(
    'invalid_prepare',
    message,
    cause === undefined ? undefined : { cause },
  );
}

function decision(kind: string): CapabilityGatewayError {
  return new CapabilityGatewayError('invalid_decision', `invalid capability ${kind}`);
}
