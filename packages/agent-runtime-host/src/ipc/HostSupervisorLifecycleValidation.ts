import { timingSafeEqual } from 'node:crypto';
import { equals } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';
import {
  HostSupervisorFactError,
} from '../driver/HostSupervisorFactError.js';
import type {
  HostSupervisorFactHandoff,
  SupervisorLifecycleFact,
} from '../driver/HostSupervisorFactTypes.js';
import {
  assertContainmentProof,
} from './ContainmentProofValidation.js';
import {
  assertFrameIdentifier,
  attemptIdentityEqual,
  validateAttemptIdentity,
} from './FrameHeaderValidation.js';

export function validateSupervisorLifecycleFact(
  fact: SupervisorLifecycleFact,
  observedAtUnixMs: bigint,
  handoff: HostSupervisorFactHandoff,
): void {
  try {
    const identity = fact.value.identity;
    if (!identity) throw new RangeError('missing identity');
    validateAttemptIdentity(identity);
    if (!attemptIdentityEqual(identity, handoff.expectedIdentity)) {
      throw new RangeError('fact identity does not match launch');
    }
    switch (fact.case) {
      case 'launchAccepted':
        validateAccepted(fact.value, observedAtUnixMs, handoff);
        break;
      case 'launchRejected':
        validateRejected(fact.value, observedAtUnixMs);
        break;
      case 'attemptProcessSpawned':
        validateSpawned(fact.value, observedAtUnixMs, handoff);
        break;
      case 'attemptContainmentReport':
        validateContainment(fact.value, observedAtUnixMs, handoff);
        break;
      case 'attemptProcessExited':
        validateExited(fact.value, observedAtUnixMs, handoff);
        break;
      case 'attemptProcessReaped':
        validateReaped(fact.value, observedAtUnixMs);
        break;
    }
  } catch (cause) {
    throw new HostSupervisorFactError(
      'invalid_fact',
      `invalid ${fact.case} payload`,
      { cause },
    );
  }
}

function validateAccepted(
  value: agentV1Supervisor.LaunchAccepted,
  observedAt: bigint,
  handoff: HostSupervisorFactHandoff,
): void {
  validText(value.reservationId);
  if (
    !value.reservedBudget
    || !equals(
      agentV1Common.ResourceBudgetSchema,
      value.reservedBudget,
      handoff.expectedResourceBudget,
    )
    || value.hardDeadlineAtUnixMs !== handoff.expectedHardDeadlineAtUnixMs
    || value.acceptedAtUnixMs <= 0n
    || value.acceptedAtUnixMs > observedAt
    || value.hardDeadlineAtUnixMs <= value.acceptedAtUnixMs
  ) throw new RangeError('accepted authority mismatch');
}

function validateRejected(
  value: agentV1Supervisor.LaunchRejected,
  observedAt: bigint,
): void {
  validCode(value.reasonCode);
  if (
    !Number.isInteger(value.reason)
    || value.reason < agentV1Supervisor.LaunchRejectionReason.ADMISSION_CLOSED
    || value.reason
      > agentV1Supervisor.LaunchRejectionReason.DUPLICATE_CONFLICT
    || value.redactedDetail !== undefined
    || value.rejectedAtUnixMs <= 0n
    || value.rejectedAtUnixMs > observedAt
  ) throw new RangeError('invalid rejection');
}

function validateSpawned(
  value: agentV1Supervisor.AttemptProcessSpawned,
  observedAt: bigint,
  handoff: HostSupervisorFactHandoff,
): void {
  validText(value.resourceGroupId);
  validText(value.reservationId);
  const actual = value.runnerProvenance;
  const expected = handoff.expectedRunnerProvenance;
  if (!actual) throw new RangeError('missing runner provenance');
  validText(actual.runtimeInstanceId);
  if (
    !Number.isInteger(actual.pid)
    || actual.pid <= 0
    || actual.pid > 0xffff_ffff
    || actual.buildId !== expected.buildId
    || actual.sourceCommit !== expected.sourceCommit
    || actual.operatingSystem !== expected.operatingSystem
    || actual.architecture !== expected.architecture
    || !sameDigest(actual.binarySha256, expected.binarySha256)
    || !exactUniqueSet(value.endpointIds, handoff.expectedEndpointIds)
    || value.spawnedAtUnixMs <= 0n
    || value.spawnedAtUnixMs > observedAt
  ) throw new RangeError('spawned authority mismatch');
}

function validateContainment(
  value: agentV1Supervisor.AttemptContainmentReport,
  observedAt: bigint,
  handoff: HostSupervisorFactHandoff,
): void {
  validText(value.runtimeInstanceId);
  if (
    !value.requestedBudget
    || !equals(
      agentV1Common.ResourceBudgetSchema,
      value.requestedBudget,
      handoff.expectedResourceBudget,
    )
    || value.reportedAtUnixMs <= 0n
    || value.reportedAtUnixMs > observedAt
  ) throw new RangeError('containment authority mismatch');
  assertContainmentProof(value.effectiveContainment, {
    requiredLevel: handoff.requiredContainmentLevel,
    requiredLimits: handoff.requiredEnforcedLimits,
  });
}

function validateExited(
  value: agentV1Supervisor.AttemptProcessExited,
  observedAt: bigint,
  handoff: HostSupervisorFactHandoff,
): void {
  const actual = value.runnerProvenance;
  const expected = handoff.expectedRunnerProvenance;
  if (!actual || !value.finalResources) {
    throw new RangeError('exit fact lacks provenance or resources');
  }
  validText(actual.runtimeInstanceId);
  if (
    actual.pid <= 0
    || actual.buildId !== expected.buildId
    || actual.sourceCommit !== expected.sourceCommit
    || actual.operatingSystem !== expected.operatingSystem
    || actual.architecture !== expected.architecture
    || !sameDigest(actual.binarySha256, expected.binarySha256)
    || value.cause < agentV1Supervisor.PhysicalExitCause.COOPERATIVE
    || value.cause > agentV1Supervisor.PhysicalExitCause.HOST_DISCONNECTED
    || value.exitedAtUnixMs <= 0n
    || value.exitedAtUnixMs > observedAt
    || value.finalResources.peakResidentMemoryBytes
      < value.finalResources.residentMemoryBytes
  ) throw new RangeError('exit fact authority mismatch');
}

function validateReaped(
  value: agentV1Supervisor.AttemptProcessReaped,
  observedAt: bigint,
): void {
  validText(value.runtimeInstanceId);
  validText(value.resourceGroupId);
  const kinds = new Set<agentV1Supervisor.ReleasedResourceKind>();
  for (const resource of value.releasedResources) {
    validText(resource.resourceId);
    if (
      resource.kind === agentV1Supervisor.ReleasedResourceKind.UNSPECIFIED
      || resource.releasedCount <= 0n
      || kinds.has(resource.kind)
    ) throw new RangeError('invalid released resource');
    kinds.add(resource.kind);
  }
  if (
    !kinds.has(agentV1Supervisor.ReleasedResourceKind.PROCESS)
    || !kinds.has(agentV1Supervisor.ReleasedResourceKind.RESOURCE_GROUP)
    || value.reapedAtUnixMs <= 0n
    || value.reapedAtUnixMs > observedAt
  ) throw new RangeError('reap fact authority mismatch');
}

function exactUniqueSet(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  try {
    for (const value of actual) validText(value);
  } catch {
    return false;
  }
  const values = new Set(actual);
  return actual.length === expected.length
    && values.size === actual.length
    && expected.every((value) => values.has(value));
}

function sameDigest(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === 32
    && right.byteLength === 32
    && timingSafeEqual(left, right);
}

function validCode(value: string): void {
  validText(value);
  if (
    Buffer.byteLength(value, 'utf8') > 128
    || !/^[A-Za-z0-9._:-]+$/u.test(value)
  ) throw new RangeError('invalid reason code');
}

function validText(value: string): void {
  assertFrameIdentifier(value, 'management lifecycle fact');
}
