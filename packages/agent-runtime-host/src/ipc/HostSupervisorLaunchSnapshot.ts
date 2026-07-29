import { clone } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';
import type {
  HostSupervisorFactHandoff,
} from '../driver/HostSupervisorFactTypes.js';
import {
  assertContainmentExpectation,
} from './ContainmentProofValidation.js';
import { assertFrameIdentifier } from './FrameHeaderValidation.js';
import { validateResourceBudget } from './HostLaunchProvisionValidation.js';

const MAX_INT64 = (1n << 63n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;

export function snapshotSupervisorLaunch(
  handoff: HostSupervisorFactHandoff,
): HostSupervisorFactHandoff {
  validateResourceBudget(handoff.expectedResourceBudget);
  validateBudgetAuthority(handoff);
  validateExpectedProvenance(handoff.expectedRunnerProvenance);
  validateEndpointIds(handoff.expectedEndpointIds);
  assertContainmentExpectation(
    handoff.requiredContainmentLevel,
    handoff.requiredEnforcedLimits,
  );
  return Object.freeze({
    ...handoff,
    expectedIdentity: clone(
      agentV1Common.AttemptIdentitySchema,
      handoff.expectedIdentity,
    ),
    expectedResourceBudget: clone(
      agentV1Common.ResourceBudgetSchema,
      handoff.expectedResourceBudget,
    ),
    expectedRunnerProvenance: clone(
      agentV1Supervisor.ExpectedRuntimeProvenanceSchema,
      handoff.expectedRunnerProvenance,
    ),
    expectedEndpointIds: Object.freeze([...handoff.expectedEndpointIds]),
    requiredEnforcedLimits: Object.freeze([
      ...handoff.requiredEnforcedLimits,
    ]),
  });
}

function validateBudgetAuthority(
  handoff: HostSupervisorFactHandoff,
): void {
  const budget = handoff.expectedResourceBudget;
  const observedAt = handoff.launchObservedAtUnixMs;
  const deadline = handoff.expectedHardDeadlineAtUnixMs;
  const memoryCap = handoff.negotiatedMaximumReservedMemoryBytes;
  const processCap = handoff.negotiatedMaximumReservedProcesses;
  if (
    observedAt <= 0n
    || observedAt > MAX_INT64
    || deadline <= observedAt
    || deadline > MAX_INT64
    || memoryCap <= 0n
    || memoryCap > MAX_UINT64
    || !Number.isInteger(processCap)
    || processCap <= 0
    || processCap > 0xffff_ffff
    || budget.hardMemoryBytes > memoryCap
    || budget.maxProcesses > processCap
    || budget.maxWallMs > deadline - observedAt
  ) throw new RangeError('launch budget authority is invalid');
}

function validateExpectedProvenance(
  value: agentV1Supervisor.ExpectedRuntimeProvenance,
): void {
  validText(value.buildId);
  validText(value.sourceCommit);
  validText(value.operatingSystem);
  validText(value.architecture);
  if (value.binarySha256.byteLength !== 32) {
    throw new RangeError('expected runner digest is invalid');
  }
}

function validateEndpointIds(values: readonly string[]): void {
  if (values.length !== 3 || new Set(values).size !== values.length) {
    throw new RangeError('expected endpoint IDs are invalid');
  }
  for (const value of values) validText(value);
}

function validText(value: string): void {
  assertFrameIdentifier(value, 'management launch expectation');
}
