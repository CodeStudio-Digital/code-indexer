import { timingSafeEqual } from 'node:crypto';
import { clone } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Supervisor,
  packProtocolVersion,
} from '@mcp/agent-runtime-contracts';
import { assertFrameIdentifier } from './FrameHeaderValidation.js';
import { HostSupervisorBootstrapError } from './HostSupervisorBootstrapError.js';
import type {
  HostSupervisorBootstrapProvision,
  HostSupervisorPolicySnapshot,
  ValidatedHostSupervisorProvision,
} from './HostSupervisorBootstrapTypes.js';
import {
  matchesManagementToken,
  sealManagementToken,
  sealSupervisorNonce,
} from './ManagementSecretDigest.js';
import { MANAGEMENT_FRAME_MAX_BYTES } from './ManagementFrame.js';

const MAX_POLICY_TEXT_BYTES = 512;
const MAX_ALLOWED_RUNNER_BUILDS = 256;
const MAX_TIMER_MS = 60n * 60n * 1_000n;
const MAX_UINT64 = (1n << 64n) - 1n;

export function validateHostSupervisorProvision(
  provision: HostSupervisorBootstrapProvision,
): ValidatedHostSupervisorProvision {
  let hello: agentV1Supervisor.HostSupervisorHello | undefined;
  let managementTokenDigest: Uint8Array | undefined;
  let supervisorNonceDigest: Uint8Array | undefined;
  try {
    assertFrameIdentifier(provision.expectedConnectionId, 'connection_id');
    if (typeof provision.nowUnixMs !== 'function') throw new RangeError('clock');
    managementTokenDigest = sealManagementToken(
      provision.expectedManagementSessionToken,
    );
    supervisorNonceDigest = sealSupervisorNonce(
      provision.expectedSupervisorLaunchNonce,
    );
    hello = clone(
      agentV1Supervisor.HostSupervisorHelloSchema,
      provision.hostHello,
    );
    const policy = validateHostHello(
      hello,
      provision.expectedConnectionId,
      managementTokenDigest,
    );
    return {
      hello,
      policy,
      managementTokenDigest,
      supervisorNonceDigest,
    };
  } catch (cause) {
    hello?.managementSessionToken.fill(0);
    managementTokenDigest?.fill(0);
    supervisorNonceDigest?.fill(0);
    if (cause instanceof HostSupervisorBootstrapError) throw cause;
    throw failure('host supervisor bootstrap provision is invalid', cause);
  }
}

function validateHostHello(
  hello: agentV1Supervisor.HostSupervisorHello,
  connectionId: string,
  tokenDigest: Uint8Array,
): HostSupervisorPolicySnapshot {
  const selected = hello.selectedProtocol;
  if (!selected) throw new RangeError('selected protocol');
  const protocolVersion = packProtocolVersion(selected);
  if (selected.major === 0 || hello.connectionId !== connectionId) {
    throw new RangeError('selected connection or protocol');
  }
  validText(hello.contractVersion);
  if (
    !Number.isInteger(hello.contractSchemaVersion)
    || hello.contractSchemaVersion <= 0
    || hello.contractSchemaVersion > 0xffff_ffff
  ) throw new RangeError('contract schema');
  validateExpectedProvenance(hello.expectedSupervisorProvenance);
  if (
    hello.allowedRunnerProvenance.length === 0
    || hello.allowedRunnerProvenance.length > MAX_ALLOWED_RUNNER_BUILDS
  ) throw new RangeError('allowed runner provenance');
  hello.allowedRunnerProvenance.forEach(validateExpectedProvenance);
  validateSupervisorLimits(hello.limits);
  validateFrameLimits(hello.frameLimits);
  if (!matchesManagementToken(tokenDigest, hello.managementSessionToken)) {
    throw new RangeError('management token');
  }
  validateContainmentLevel(hello.requiredContainmentLevel);
  if (
    hello.allowedFeatureBits < 0n
    || hello.allowedFeatureBits > MAX_UINT64
  ) throw new RangeError('allowed feature bits');
  return Object.freeze({
    protocolVersion,
    connectionId,
    contractVersion: hello.contractVersion,
    contractSchemaVersion: hello.contractSchemaVersion,
    expectedSupervisorProvenance: clone(
      agentV1Supervisor.ExpectedRuntimeProvenanceSchema,
      hello.expectedSupervisorProvenance!,
    ),
    allowedRunnerProvenance: Object.freeze(
      hello.allowedRunnerProvenance.map((value) => clone(
        agentV1Supervisor.ExpectedRuntimeProvenanceSchema,
        value,
      )),
    ),
    limits: clone(agentV1Supervisor.SupervisorLimitsSchema, hello.limits!),
    frameLimits: clone(agentV1Common.FrameLimitsSchema, hello.frameLimits!),
    requiredContainmentLevel: hello.requiredContainmentLevel,
    allowedFeatureBits: hello.allowedFeatureBits,
  });
}

function validateSupervisorLimits(
  limits: agentV1Supervisor.SupervisorLimits | undefined,
): void {
  if (
    !limits
    || !inUint32Range(limits.maxActiveAttempts, 1, 4_096)
    || !inUint32Range(limits.maxPendingLaunches, 1, 4_096)
    || limits.maxReservedMemoryBytes <= 0n
    || limits.maxReservedMemoryBytes > (1n << 50n)
    || !inUint32Range(
      limits.maxReservedProcesses,
      limits.maxActiveAttempts,
      65_536,
    )
    || !inBigintRange(limits.hostDisconnectGraceMs, 1n, MAX_TIMER_MS)
    || !inBigintRange(limits.runnerPulseTimeoutMs, 1n, MAX_TIMER_MS)
  ) throw new RangeError('supervisor limits');
}

function validateFrameLimits(
  limits: agentV1Common.FrameLimits | undefined,
): void {
  if (
    !limits
    || !inBigintRange(
      limits.maxFrameBytes,
      1n,
      BigInt(MANAGEMENT_FRAME_MAX_BYTES),
    )
    || !inBigintRange(limits.maxChunkBytes, 1n, limits.maxFrameBytes)
    || !inBigintRange(limits.maxInFlightFrames, 1n, 1_024n)
    || limits.maxInFlightBytes < limits.maxFrameBytes
    || limits.maxInFlightBytes > 8n * 1024n * 1024n
    || !inBigintRange(limits.readTimeoutMs, 1n, MAX_TIMER_MS)
    || !inBigintRange(limits.writeTimeoutMs, 1n, MAX_TIMER_MS)
    || limits.transportCrc32c
  ) throw new RangeError('frame limits');
}

export function expectedProvenanceMatches(
  expected: agentV1Supervisor.ExpectedRuntimeProvenance,
  actual: agentV1Common.RuntimeProvenance,
): boolean {
  return (
    expected.buildId === actual.buildId
    && expected.sourceCommit === actual.sourceCommit
    && expected.operatingSystem === actual.operatingSystem
    && expected.architecture === actual.architecture
    && sameBytes(expected.binarySha256, actual.binarySha256)
  );
}

export function expectedProvenanceEqual(
  left: agentV1Supervisor.ExpectedRuntimeProvenance,
  right: agentV1Supervisor.ExpectedRuntimeProvenance,
): boolean {
  return (
    left.buildId === right.buildId
    && left.sourceCommit === right.sourceCommit
    && left.operatingSystem === right.operatingSystem
    && left.architecture === right.architecture
    && sameBytes(left.binarySha256, right.binarySha256)
  );
}

export function validateExpectedProvenance(
  value: agentV1Supervisor.ExpectedRuntimeProvenance | undefined,
): asserts value is agentV1Supervisor.ExpectedRuntimeProvenance {
  if (!value) throw new RangeError('provenance');
  [
    value.buildId,
    value.sourceCommit,
    value.operatingSystem,
    value.architecture,
  ].forEach(validText);
  if (value.binarySha256.byteLength !== 32) {
    throw new RangeError('provenance digest');
  }
}

function validateContainmentLevel(value: agentV1Common.ContainmentLevel): void {
  if (
    value !== agentV1Common.ContainmentLevel.HARD_AGGREGATE
    && value !== agentV1Common.ContainmentLevel.HARD_PROCESS
    && value !== agentV1Common.ContainmentLevel.MONITORED
  ) throw new RangeError('containment level');
}

function validText(value: string): void {
  if (
    value.trim().length === 0
    || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > MAX_POLICY_TEXT_BYTES
  ) throw new RangeError('policy text');
}

function inUint32Range(value: number, minimum: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function inBigintRange(value: bigint, minimum: bigint, maximum: bigint): boolean {
  return value >= minimum && value <= maximum;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.byteLength > 0
    && timingSafeEqual(left, right);
}

function failure(message: string, cause: unknown): HostSupervisorBootstrapError {
  return new HostSupervisorBootstrapError(
    'invalid_provision',
    message,
    { cause },
  );
}
