import { clone } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';
import type {
  HostSupervisorFactHandoff,
} from '../driver/HostSupervisorFactTypes.js';
import { assertContainmentExpectation } from './ContainmentProofValidation.js';
import { assertFrameIdentifier, validateAttemptIdentity } from './FrameHeaderValidation.js';
import { HostSupervisorBootstrapError } from './HostSupervisorBootstrapError.js';
import type {
  HostSupervisorLaunchOptions,
  HostSupervisorPolicySnapshot,
} from './HostSupervisorBootstrapTypes.js';
import {
  scrubActivationAuthoritySeal,
  validateActivationAuthoritySeal,
} from './ActivationAuthoritySealValidation.js';
import { validateResourceBudget } from './HostLaunchProvisionValidation.js';
import {
  expectedProvenanceEqual,
  validateExpectedProvenance,
} from './HostSupervisorProvisionValidation.js';
import { MANAGEMENT_FRAME_MAX_BYTES } from './ManagementFrame.js';

const MAX_INT64 = (1n << 63n) - 1n;
const MAX_SECRET_BYTES = 4_096;
const MIN_SECRET_BYTES = 16;
const PULSE_FRAME_MAX_BYTES = 4 * 1024;
const CONTROL_FRAME_MAX_BYTES = 256 * 1024;
const DATA_FRAME_MAX_BYTES = 1024 * 1024;

export interface ValidatedSupervisorLaunch {
  readonly launch: agentV1Supervisor.LaunchAttemptProcess;
  readonly handoff: HostSupervisorFactHandoff;
  readonly deadlineAtUnixMs: bigint;
}

export function validateSupervisorLaunch(
  candidate: agentV1Supervisor.LaunchAttemptProcess,
  policy: HostSupervisorPolicySnapshot,
  options: HostSupervisorLaunchOptions,
  observedAtUnixMs: bigint,
  bootstrapInboundMessageId: string,
  launchMessageId: string,
): ValidatedSupervisorLaunch {
  let launch: agentV1Supervisor.LaunchAttemptProcess | undefined;
  try {
    validateLaunchOptions(options, policy);
    launch = clone(agentV1Supervisor.LaunchAttemptProcessSchema, candidate);
    validateLaunchPayload(launch, policy, observedAtUnixMs);
    const responseTimeout = BigInt(options.launchResponseTimeoutMs ?? options.responseTimeoutMs);
    const requestedDeadline = observedAtUnixMs + responseTimeout;
    const authorityDeadline = launch.authorityLeaseExpiresAtUnixMs < launch.hardDeadlineAtUnixMs
      ? launch.authorityLeaseExpiresAtUnixMs : launch.hardDeadlineAtUnixMs;
    return {
      launch,
      deadlineAtUnixMs: requestedDeadline < authorityDeadline
        ? requestedDeadline
        : authorityDeadline,
      handoff: Object.freeze({
        protocolVersion: policy.protocolVersion,
        connectionId: policy.connectionId,
        bootstrapInboundMessageId,
        committedInboundStreamSeq: 1n,
        committedOutboundStreamSeq: 2n,
        maximumFrameBytes: Number(policy.frameLimits.maxFrameBytes),
        maximumReplayBytes: options.maximumReplayBytes,
        trackedMessageIdCapacity: options.trackedMessageIdCapacity,
        expectedIdentity: clone(
          agentV1Common.AttemptIdentitySchema,
          launch.identity!,
        ),
        expectedResourceBudget: clone(
          agentV1Common.ResourceBudgetSchema,
          launch.resourceBudget!,
        ),
        launchObservedAtUnixMs: observedAtUnixMs,
        expectedHardDeadlineAtUnixMs: launch.hardDeadlineAtUnixMs,
        negotiatedMaximumReservedMemoryBytes:
          policy.limits.maxReservedMemoryBytes,
        negotiatedMaximumReservedProcesses:
          policy.limits.maxReservedProcesses,
        expectedRunnerProvenance: clone(
          agentV1Supervisor.ExpectedRuntimeProvenanceSchema,
          launch.expectedRunnerProvenance!,
        ),
        expectedEndpointIds: Object.freeze(
          launch.protectedEndpoints.map((endpoint) => endpoint.endpointId),
        ),
        requiredContainmentLevel: policy.requiredContainmentLevel,
        requiredEnforcedLimits: Object.freeze([
          ...launch.requiredEnforcedLimits,
        ]),
        expectedLaunchReplyToMessageId: launchMessageId,
      }),
    };
  } catch (cause) {
    scrubLaunch(launch);
    if (cause instanceof HostSupervisorBootstrapError) throw cause;
    throw new HostSupervisorBootstrapError(
      'invalid_launch',
      'LaunchAttemptProcess is invalid or exceeds bootstrap authority',
      { cause },
    );
  }
}

export function scrubLaunch(
  launch: agentV1Supervisor.LaunchAttemptProcess | undefined,
): void {
  launch?.launchNonce.fill(0);
  for (const endpoint of launch?.protectedEndpoints ?? []) {
    endpoint.connectionToken.fill(0);
  }
  scrubActivationAuthoritySeal(launch?.activationAuthoritySeal);
  if (launch) launch.activationAuthoritySeal = undefined;
}

function validateLaunchOptions(
  options: HostSupervisorLaunchOptions,
  policy: HostSupervisorPolicySnapshot,
): void {
  const maximumWriteTimeout = Number(policy.frameLimits.writeTimeoutMs);
  if (
    !Number.isSafeInteger(options.responseTimeoutMs)
    || options.responseTimeoutMs <= 0
    || options.responseTimeoutMs > maximumWriteTimeout
    || (options.launchResponseTimeoutMs !== undefined && (
      !Number.isSafeInteger(options.launchResponseTimeoutMs)
      || options.launchResponseTimeoutMs <= 0 || options.launchResponseTimeoutMs > 60_000))
    || !Number.isInteger(options.maximumReplayBytes)
    || options.maximumReplayBytes <= 0
    || options.maximumReplayBytes > 16 * MANAGEMENT_FRAME_MAX_BYTES
    || !Number.isInteger(options.trackedMessageIdCapacity)
    || options.trackedMessageIdCapacity < 2
    || options.trackedMessageIdCapacity > 4_096
  ) throw new RangeError('launch driver bounds');
}

function validateLaunchPayload(
  launch: agentV1Supervisor.LaunchAttemptProcess,
  policy: HostSupervisorPolicySnapshot,
  observedAtUnixMs: bigint,
): void {
  if (!launch.identity || !launch.resourceBudget) {
    throw new RangeError('launch identity or budget');
  }
  validateAttemptIdentity(launch.identity);
  validateResourceBudget(launch.resourceBudget);
  const budget = launch.resourceBudget;
  if (
    observedAtUnixMs <= 0n
    || observedAtUnixMs > MAX_INT64
    || launch.hardDeadlineAtUnixMs <= observedAtUnixMs
    || launch.hardDeadlineAtUnixMs > MAX_INT64
    || launch.authorityLeaseExpiresAtUnixMs <= observedAtUnixMs
    || launch.authorityLeaseExpiresAtUnixMs > launch.hardDeadlineAtUnixMs
    || budget.hardMemoryBytes > policy.limits.maxReservedMemoryBytes
    || budget.maxProcesses > policy.limits.maxReservedProcesses
    || budget.maxWallMs > launch.hardDeadlineAtUnixMs - observedAtUnixMs
    || !validSecret(launch.launchNonce, 256)
  ) throw new RangeError('launch authority');
  validateEndpoints(launch.protectedEndpoints);
  validateExpectedProvenance(launch.expectedRunnerProvenance);
  validateActivationAuthoritySeal(launch.activationAuthoritySeal);
  if (!policy.allowedRunnerProvenance.some((expected) => (
    expectedProvenanceEqual(expected, launch.expectedRunnerProvenance!)
  ))) throw new RangeError('runner provenance');
  assertFrameIdentifier(launch.idempotencyKey, 'idempotency_key');
  assertContainmentExpectation(
    policy.requiredContainmentLevel,
    launch.requiredEnforcedLimits,
  );
}

function validateEndpoints(
  endpoints: readonly agentV1Supervisor.ProtectedAttemptEndpoint[],
): void {
  if (endpoints.length !== 3) throw new RangeError('protected endpoints');
  const kinds = new Set<agentV1Supervisor.AttemptEndpointKind>();
  const ids = new Set<string>();
  for (const endpoint of endpoints) {
    const maximum = endpointMaximum(endpoint.kind);
    assertFrameIdentifier(endpoint.endpointId, 'endpoint_id');
    assertFrameIdentifier(endpoint.address, 'endpoint_address');
    if (
      maximum === 0
      || kinds.has(endpoint.kind)
      || ids.has(endpoint.endpointId)
      || !validSecret(endpoint.connectionToken, MAX_SECRET_BYTES)
      || endpoint.maxFrameBytes !== BigInt(maximum)
    ) throw new RangeError('protected endpoints');
    kinds.add(endpoint.kind);
    ids.add(endpoint.endpointId);
  }
}

function endpointMaximum(kind: agentV1Supervisor.AttemptEndpointKind): number {
  switch (kind) {
    case agentV1Supervisor.AttemptEndpointKind.CONTROL:
      return CONTROL_FRAME_MAX_BYTES;
    case agentV1Supervisor.AttemptEndpointKind.DATA:
      return DATA_FRAME_MAX_BYTES;
    case agentV1Supervisor.AttemptEndpointKind.RUNNER_PULSE:
      return PULSE_FRAME_MAX_BYTES;
    default:
      return 0;
  }
}

function validSecret(value: Uint8Array, maximum: number): boolean {
  return value.byteLength >= MIN_SECRET_BYTES
    && value.byteLength <= maximum;
}
