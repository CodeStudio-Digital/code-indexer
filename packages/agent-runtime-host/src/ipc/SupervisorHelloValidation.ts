import {
  agentV1Common,
  agentV1Supervisor,
  packProtocolVersion,
  unpackProtocolVersion,
} from '@mcp/agent-runtime-contracts';
import { assertFrameIdentifier } from './FrameHeaderValidation.js';
import { HostSupervisorBootstrapError } from './HostSupervisorBootstrapError.js';
import type {
  HostSupervisorPolicySnapshot,
} from './HostSupervisorBootstrapTypes.js';
import {
  expectedProvenanceMatches,
} from './HostSupervisorProvisionValidation.js';
import {
  matchesSupervisorNonce,
} from './ManagementSecretDigest.js';

const MAX_INT64 = (1n << 63n) - 1n;

export function validateSupervisorBootstrapFrame(
  header: agentV1Supervisor.ManagementFrameHeader,
  payload: agentV1Supervisor.ManagementPayload,
  policy: HostSupervisorPolicySnapshot,
  supervisorNonceDigest: Uint8Array,
  observedAtUnixMs: bigint,
): string {
  validateHeader(header, policy, observedAtUnixMs);
  if (payload.body.case !== 'supervisorHello') {
    throw failure(
      'wrong_bootstrap_payload',
      'the second management frame must be SupervisorHello',
    );
  }
  validateSupervisorHello(
    payload.body.value,
    policy,
    supervisorNonceDigest,
  );
  return header.messageId;
}

function validateHeader(
  header: agentV1Supervisor.ManagementFrameHeader,
  policy: HostSupervisorPolicySnapshot,
  observedAtUnixMs: bigint,
): void {
  try {
    const version = unpackProtocolVersion(header.protocolVersion);
    assertFrameIdentifier(header.connectionId, 'connection_id');
    assertFrameIdentifier(header.messageId, 'message_id');
    if (header.replyToMessageId !== undefined) {
      assertFrameIdentifier(header.replyToMessageId, 'reply_to_message_id');
    }
    if (
      version.major === 0
      || header.streamSeq <= 0n
      || header.sentAtUnixMs <= 0n
      || (
        header.deadlineAtUnixMs !== undefined
        && (
          header.deadlineAtUnixMs <= 0n
          || header.deadlineAtUnixMs <= header.sentAtUnixMs
        )
      )
      || observedAtUnixMs <= 0n
      || observedAtUnixMs > MAX_INT64
    ) throw new RangeError('header');
  } catch (cause) {
    throw failure('invalid_header', 'SupervisorHello header is invalid', cause);
  }
  if (header.streamSeq !== 1n) {
    throw failure('invalid_header', 'SupervisorHello must own stream sequence 1');
  }
  if (header.protocolVersion !== policy.protocolVersion) {
    throw failure('protocol_mismatch', 'SupervisorHello protocol mismatches selection');
  }
  if (header.connectionId !== policy.connectionId) {
    throw failure('connection_mismatch', 'SupervisorHello connection mismatches provision');
  }
  if (
    header.deadlineAtUnixMs !== undefined
    && observedAtUnixMs >= header.deadlineAtUnixMs
  ) throw failure('invalid_header', 'SupervisorHello deadline has expired');
}

function validateSupervisorHello(
  hello: agentV1Supervisor.SupervisorHello,
  policy: HostSupervisorPolicySnapshot,
  supervisorNonceDigest: Uint8Array,
): void {
  const range = hello.supportedProtocols;
  try {
    if (!range?.minimum || !range.maximum) throw new RangeError('range');
    const minimum = packProtocolVersion(range.minimum);
    const maximum = packProtocolVersion(range.maximum);
    if (
      range.minimum.major === 0
      || range.maximum.major === 0
      || minimum > maximum
      || policy.protocolVersion < minimum
      || policy.protocolVersion > maximum
    ) throw new RangeError('range');
  } catch (cause) {
    throw failure('protocol_mismatch', 'SupervisorHello protocol range is invalid', cause);
  }
  if (
    hello.contractVersion !== policy.contractVersion
    || hello.contractSchemaVersion !== policy.contractSchemaVersion
  ) throw failure('contract_mismatch', 'SupervisorHello contract mismatches selection');
  if (
    !hello.provenance
    || !runtimeProvenanceValid(hello.provenance)
    || !expectedProvenanceMatches(
      policy.expectedSupervisorProvenance,
      hello.provenance,
    )
  ) throw failure('provenance_mismatch', 'SupervisorHello provenance mismatches launch');
  if (!matchesSupervisorNonce(supervisorNonceDigest, hello.launchNonce)) {
    throw failure('nonce_mismatch', 'SupervisorHello nonce mismatches launch receipt');
  }
  if ((policy.allowedFeatureBits & ~hello.supportedFeatureBits) !== 0n) {
    throw failure('feature_mismatch', 'SupervisorHello lacks selected features');
  }
  if (!containmentSatisfies(policy.requiredContainmentLevel, hello.containment)) {
    throw failure('containment_mismatch', 'SupervisorHello containment is insufficient');
  }
}

function runtimeProvenanceValid(value: agentV1Common.RuntimeProvenance): boolean {
  const text = [
    value.buildId,
    value.sourceCommit,
    value.runtimeInstanceId,
    value.operatingSystem,
    value.architecture,
  ];
  return text.every((item) => (
    item.trim().length > 0
    && !item.includes('\0')
    && Buffer.byteLength(item, 'utf8') <= 512
  )) && value.binarySha256.byteLength === 32
    && Number.isInteger(value.pid)
    && value.pid > 0
    && value.pid <= 0xffff_ffff;
}

function containmentSatisfies(
  required: agentV1Common.ContainmentLevel,
  actual: agentV1Common.ContainmentCapabilities | undefined,
): boolean {
  if (!actual) return false;
  if (required === agentV1Common.ContainmentLevel.MONITORED) return true;
  if (
    required === agentV1Common.ContainmentLevel.HARD_AGGREGATE
    || required === agentV1Common.ContainmentLevel.HARD_PROCESS
  ) {
    return actual.processTree
      && actual.memoryLimit
      && actual.cpuLimit
      && actual.processCountLimit;
  }
  return false;
}

function failure(
  code: HostSupervisorBootstrapError['code'],
  message: string,
  cause?: unknown,
): HostSupervisorBootstrapError {
  return new HostSupervisorBootstrapError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}
