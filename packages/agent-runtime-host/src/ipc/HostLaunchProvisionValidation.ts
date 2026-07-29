import {
  agentV1Common,
  unpackProtocolVersion,
} from '@mcp/agent-runtime-contracts';
import { AttemptFrameBootstrapError } from './AttemptFrameBootstrapError.js';
import type {
  AttemptFrameReceiverLimits,
} from './AttemptFrameReceiverTypes.js';
import {
  assertFrameIdentifier,
  validateAttemptIdentity,
} from './FrameHeaderValidation.js';
import type {
  ExpectedRuntimeProvenance,
  HostLaunchProvision,
  PackedProtocolRange,
} from './HostLaunchTypes.js';
import { validateNegotiationPolicy } from './HostNegotiationPolicy.js';

const MIN_LAUNCH_NONCE_BYTES = 16;
const MAX_LAUNCH_NONCE_BYTES = 512;
const MIN_CONNECTION_TOKEN_BYTES = 16;
const MAX_CONNECTION_TOKEN_BYTES = 512;
const MAX_INT64 = (1n << 63n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_REPLAY_ENTRIES = 64;
const MAX_TRACKED_IDENTITIES = 4_096;
const MAX_REPLAY_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_TIMEOUT_MS = 60_000n;

export interface DerivedLaunchLimits {
  readonly receiverLimits: AttemptFrameReceiverLimits;
  readonly maximumResponseTimeoutMs: number;
}

export function validateHostLaunchProvision(
  provision: HostLaunchProvision,
): void {
  validateIdentity(provision.expectedIdentity);
  validateIdentifier(provision.expectedConnectionId, 'invalid_expected_connection');
  validateIdentifier(provision.expectedRuntimeInstanceId, 'invalid_expected_runtime');
  validateNonce(provision.expectedLaunchNonce);
  validateConnectionToken(provision.expectedConnectionSessionToken);
  validateContract(provision);
  validateProvenance(provision.expectedProvenance);
  validateProtocolRange(provision.supportedProtocols);
  if (
    provision.hardDeadlineAtUnixMs <= 0n
    || provision.hardDeadlineAtUnixMs > MAX_INT64
  ) {
    throw bootstrapError(
      'invalid_hard_deadline',
      'launch hard deadline must be a positive int64',
    );
  }
  if (typeof provision.validateAgentHello !== 'function') {
    throw bootstrapError(
      'invalid_expected_provenance',
      'a synchronous AgentHello validator is required',
    );
  }
  deriveLaunchLimits(provision.resourceBudget);
  validateNegotiationPolicy(
    provision.heartbeatPolicy,
    provision.featurePolicy,
    provision.resourceBudget,
  );
}

export function deriveLaunchLimits(
  budget: agentV1Common.ResourceBudget,
): DerivedLaunchLimits {
  validateResourceBudget(budget);
  const maxReplayBytes = Number(
    budget.maxIpcBytes < BigInt(MAX_REPLAY_BYTES)
      ? budget.maxIpcBytes
      : BigInt(MAX_REPLAY_BYTES),
  );
  const maximumResponseTimeoutMs = Number(
    budget.maxWallMs < MAX_RESPONSE_TIMEOUT_MS
      ? budget.maxWallMs
      : MAX_RESPONSE_TIMEOUT_MS,
  );
  return {
    receiverLimits: Object.freeze({
      replayCapacity: Math.min(budget.maxIpcFrames, MAX_REPLAY_ENTRIES),
      totalIdentityCapacity: Math.min(
        budget.maxIpcFrames + 1,
        MAX_TRACKED_IDENTITIES,
      ),
      maxReplayBytes,
    }),
    maximumResponseTimeoutMs,
  };
}

export function validateResourceBudget(
  budget: agentV1Common.ResourceBudget,
): void {
  const bigintLimits = [
    budget.softMemoryBytes,
    budget.hardMemoryBytes,
    budget.cpuTimeMs,
    budget.maxWallMs,
    budget.maxHotTranscriptBytes,
    budget.maxIpcBytes,
    budget.maxSpoolBytes,
    budget.maxArtifactBytes,
    budget.cancelGraceMs,
  ];
  const uint32Limits = [
    budget.maxProcesses,
    budget.maxThreads,
    budget.maxOpenHandles,
    budget.maxIpcFrames,
    budget.maxConcurrentTools,
    budget.maxBlockingTasks,
  ];
  if (
    bigintLimits.some((value) => value <= 0n || value > MAX_UINT64)
    || uint32Limits.some(
      (value) => (
        !Number.isInteger(value)
        || value <= 0
        || value > 0xffff_ffff
      ),
    )
    || budget.softMemoryBytes > budget.hardMemoryBytes
    || budget.maxThreads < budget.maxProcesses
    || budget.maxArtifactBytes > budget.maxSpoolBytes
    || budget.cancelGraceMs > budget.maxWallMs
  ) {
    throw bootstrapError(
      'invalid_resource_budget',
      'launch resource budget is invalid',
    );
  }
}

function validateIdentity(identity: agentV1Common.AttemptIdentity): void {
  try {
    validateAttemptIdentity(identity);
  } catch (cause) {
    throw new AttemptFrameBootstrapError(
      'invalid_expected_identity',
      'launch identity is invalid',
      { cause },
    );
  }
}

function validateIdentifier(
  value: string,
  code: 'invalid_expected_connection' | 'invalid_expected_runtime',
): void {
  try {
    assertFrameIdentifier(value, 'launch identifier');
  } catch (cause) {
    throw new AttemptFrameBootstrapError(code, 'launch identifier is invalid', {
      cause,
    });
  }
}

function validateNonce(nonce: Uint8Array): void {
  if (
    nonce.byteLength < MIN_LAUNCH_NONCE_BYTES
    || nonce.byteLength > MAX_LAUNCH_NONCE_BYTES
  ) {
    throw bootstrapError('invalid_expected_nonce', 'launch nonce is invalid');
  }
}

function validateConnectionToken(token: Uint8Array): void {
  if (
    token.byteLength < MIN_CONNECTION_TOKEN_BYTES
    || token.byteLength > MAX_CONNECTION_TOKEN_BYTES
  ) {
    throw bootstrapError(
      'invalid_expected_connection_token',
      'connection session token is invalid',
    );
  }
}

function validateContract(provision: HostLaunchProvision): void {
  if (
    !provision.expectedContractVersion
    || !Number.isInteger(provision.expectedContractSchemaVersion)
    || provision.expectedContractSchemaVersion <= 0
    || provision.expectedContractSchemaVersion > 0xffff_ffff
  ) {
    throw bootstrapError('invalid_expected_contract', 'launch contract is invalid');
  }
}

function validateProvenance(provenance: ExpectedRuntimeProvenance): void {
  const text = [
    provenance.buildId,
    provenance.sourceCommit,
    provenance.operatingSystem,
    provenance.architecture,
  ];
  if (text.some((value) => !value || Buffer.byteLength(value, 'utf8') > 512)) {
    throw bootstrapError(
      'invalid_expected_provenance',
      'expected runtime provenance is invalid',
    );
  }
  if (
    provenance.binarySha256.byteLength !== 32
    || !Number.isInteger(provenance.pid)
    || provenance.pid <= 0
    || provenance.pid > 0xffff_ffff
  ) {
    throw bootstrapError(
      'invalid_expected_provenance',
      'expected binary digest or PID is invalid',
    );
  }
}

function validateProtocolRange(range: PackedProtocolRange): void {
  try {
    const minimum = unpackProtocolVersion(range.minimum);
    const maximum = unpackProtocolVersion(range.maximum);
    if (
      minimum.major === 0
      || maximum.major === 0
      || range.minimum > range.maximum
    ) throw new RangeError('invalid protocol range');
  } catch (cause) {
    throw new AttemptFrameBootstrapError(
      'invalid_protocol_range',
      'launch protocol range is invalid',
      { cause },
    );
  }
}

function bootstrapError(
  code: ConstructorParameters<typeof AttemptFrameBootstrapError>[0],
  message: string,
): AttemptFrameBootstrapError {
  return new AttemptFrameBootstrapError(code, message);
}
