import { clone } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import { assertFrameIdentifier } from '../ipc/FrameHeaderValidation.js';
import {
  earliestLocalPeerTimestamp,
  latestLocalPeerTimestamp,
} from '../ipc/LocalPeerClock.js';
import { HostLifecycleDriverError } from './HostLifecycleDriverError.js';
import type {
  ActiveAttemptAuthorityFacts,
  HostHeartbeatSnapshot,
} from './HostLifecycleTypes.js';

const MAX_OPERATION_IDS = 1_024;

export function validateHeartbeat(
  value: agentV1Runtime.Heartbeat,
  messageId: string,
  headerSentAtUnixMs: bigint,
  observedAtUnixMs: bigint,
  authority: ActiveAttemptAuthorityFacts,
  previous?: HostHeartbeatSnapshot,
): HostHeartbeatSnapshot {
  if (
    value.runtimeInstanceId !== authority.runtimeInstanceId
    || value.phase !== agentV1Runtime.PhysicalAttemptPhase.ACTIVE
    || value.lastAliveAtUnixMs < earliestLocalPeerTimestamp(headerSentAtUnixMs)
    || value.lastAliveAtUnixMs > latestLocalPeerTimestamp(observedAtUnixMs)
    || value.lastProgressAtUnixMs <= 0n
    || value.lastProgressAtUnixMs > value.lastAliveAtUnixMs
    || (previous !== undefined && (
      value.lastAliveAtUnixMs < previous.lastAliveAtUnixMs
      || value.lastProgressAtUnixMs < previous.lastProgressAtUnixMs
      || value.lastEventSeq < previous.lastEventSeq
    ))
  ) throw invalid('heartbeat identity, phase, clock, or progress is invalid');
  validateIds(value.activeProviderOperationIds, 'provider operation');
  validateIds(value.activeCapabilityOperationIds, 'capability operation');
  validateIds(value.activeChildAttemptIds, 'child attempt');
  const resources = value.resources;
  if (
    !resources
    || resources.processCount <= 0
    || resources.peakResidentMemoryBytes < resources.residentMemoryBytes
  ) throw invalid('heartbeat resource sample is missing or contradictory');
  return Object.freeze({
    messageId,
    observedAtUnixMs,
    lastAliveAtUnixMs: value.lastAliveAtUnixMs,
    lastProgressAtUnixMs: value.lastProgressAtUnixMs,
    lastEventSeq: value.lastEventSeq,
    phase: value.phase,
    resources: clone(agentV1Common.ResourceSampleSchema, resources),
  });
}

function validateIds(values: readonly string[], field: string): void {
  if (values.length > MAX_OPERATION_IDS || new Set(values).size !== values.length) {
    throw invalid(`heartbeat ${field} IDs are duplicated or exceed the cap`);
  }
  try {
    for (const value of values) assertFrameIdentifier(value, field);
  } catch (cause) {
    throw invalid(`heartbeat ${field} ID is invalid`, cause);
  }
}

function invalid(message: string, cause?: unknown): HostLifecycleDriverError {
  return new HostLifecycleDriverError(
    'invalid_heartbeat',
    message,
    cause === undefined ? undefined : { cause },
  );
}
