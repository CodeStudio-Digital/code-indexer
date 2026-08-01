import {
  agentV1Supervisor,
  unpackProtocolVersion,
} from '@mcp/agent-runtime-contracts';
import {
  HostSupervisorFactError,
} from '../driver/HostSupervisorFactError.js';
import type {
  HostSupervisorFactHandoff,
  SupervisorLifecycleFact,
} from '../driver/HostSupervisorFactTypes.js';
import {
  assertFrameIdentifier,
  validateAttemptIdentity,
} from './FrameHeaderValidation.js';
import {
  latestLocalPeerTimestamp,
} from './LocalPeerClock.js';
import {
  validateSupervisorLifecycleFact,
} from './HostSupervisorLifecycleValidation.js';
import {
  snapshotSupervisorLaunch,
} from './HostSupervisorLaunchSnapshot.js';
import { MANAGEMENT_FRAME_MAX_BYTES } from './ManagementFrame.js';

const MAX_INT64 = (1n << 63n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;

export function snapshotFactHandoff(
  handoff: HostSupervisorFactHandoff,
): HostSupervisorFactHandoff {
  try {
    const version = unpackProtocolVersion(handoff.protocolVersion);
    assertFrameIdentifier(handoff.connectionId, 'connection_id');
    assertFrameIdentifier(
      handoff.bootstrapInboundMessageId,
      'bootstrap inbound message ID',
    );
    if (
      version.major === 0
      || handoff.committedInboundStreamSeq <= 0n
      || handoff.committedInboundStreamSeq > MAX_UINT64
      || handoff.committedOutboundStreamSeq <= 0n
      || handoff.committedOutboundStreamSeq >= MAX_UINT64
      || !Number.isInteger(handoff.maximumFrameBytes)
      || handoff.maximumFrameBytes <= 0
      || handoff.maximumFrameBytes > MANAGEMENT_FRAME_MAX_BYTES
      || !Number.isInteger(handoff.maximumReplayBytes)
      || handoff.maximumReplayBytes <= 0
      || handoff.maximumReplayBytes > 16 * MANAGEMENT_FRAME_MAX_BYTES
      || !Number.isInteger(handoff.trackedMessageIdCapacity)
      || handoff.trackedMessageIdCapacity < 2
      || handoff.trackedMessageIdCapacity > 4_096
    ) throw new RangeError('invalid management handoff');
    validateAttemptIdentity(handoff.expectedIdentity);
    assertFrameIdentifier(
      handoff.expectedLaunchReplyToMessageId,
      'expected launch message ID',
    );
  } catch (cause) {
    throw new HostSupervisorFactError(
      'invalid_handoff',
      'management fact handoff is invalid',
      { cause },
    );
  }
  try {
    return snapshotSupervisorLaunch(handoff);
  } catch (cause) {
    throw new HostSupervisorFactError(
      'invalid_handoff',
      'management launch expectation is invalid',
      { cause },
    );
  }
}

export function validateSupervisorFact(
  header: agentV1Supervisor.ManagementFrameHeader,
  payload: agentV1Supervisor.ManagementPayload,
  observedAtUnixMs: bigint,
  handoff: HostSupervisorFactHandoff,
): SupervisorLifecycleFact {
  validateFreshSupervisorHeader(header, observedAtUnixMs, handoff);
  const body = payload.body;
  if (
    body.case !== 'launchAccepted'
    && body.case !== 'launchRejected'
    && body.case !== 'attemptProcessSpawned'
    && body.case !== 'attemptContainmentReport'
  ) {
    throw failure('payload_direction', 'payload is not a supervisor lifecycle fact');
  }
  validateReplyShape(body.case, header.replyToMessageId, handoff);
  validateSupervisorLifecycleFact(
    body,
    latestLocalPeerTimestamp(observedAtUnixMs),
    handoff,
  );
  return body;
}

export function validateSupervisorEnvelopeHeader(
  header: agentV1Supervisor.ManagementFrameHeader,
  observedAtUnixMs: bigint,
  handoff: HostSupervisorFactHandoff,
): void {
  validateStructuralHeader(header);
  if (
    observedAtUnixMs <= 0n
    || observedAtUnixMs > MAX_INT64
  ) {
    throw failure('invalid_header', 'management owner clock is invalid');
  }
  const latestPeer = latestLocalPeerTimestamp(observedAtUnixMs);
  if (header.sentAtUnixMs > latestPeer) {
    throw failure(
      'invalid_header',
      'management frame timestamp exceeds owner clock',
      new RangeError(
        `future management frame delta=${
          header.sentAtUnixMs - observedAtUnixMs
        }ms`,
      ),
    );
  }
  if (header.protocolVersion !== handoff.protocolVersion) {
    throw failure('protocol_mismatch', 'management protocol does not match handoff');
  }
  if (header.connectionId !== handoff.connectionId) {
    throw failure('connection_mismatch', 'management connection does not match handoff');
  }
}

function validateFreshSupervisorHeader(
  header: agentV1Supervisor.ManagementFrameHeader,
  observedAtUnixMs: bigint,
  handoff: HostSupervisorFactHandoff,
): void {
  validateSupervisorEnvelopeHeader(header, observedAtUnixMs, handoff);
  try {
    if (
      (
        header.deadlineAtUnixMs !== undefined
        && observedAtUnixMs >= header.deadlineAtUnixMs
      )
    ) throw new RangeError('management frame is not fresh');
  } catch (cause) {
    throw failure('invalid_header', 'management frame header is invalid', cause);
  }
}

function validateReplyShape(
  factCase: SupervisorLifecycleFact['case'],
  replyTo: string | undefined,
  handoff: HostSupervisorFactHandoff,
): void {
  if (factCase === 'launchAccepted' || factCase === 'launchRejected') {
    if (
      !handoff.expectedLaunchReplyToMessageId
      || replyTo !== handoff.expectedLaunchReplyToMessageId
    ) throw failure('invalid_fact', 'launch outcome has no matching request');
    return;
  }
  if (replyTo !== undefined) {
    throw failure('invalid_fact', 'asynchronous lifecycle fact cannot be a reply');
  }
}

function validateStructuralHeader(
  header: agentV1Supervisor.ManagementFrameHeader,
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
      || header.streamSeq > MAX_UINT64
      || header.sentAtUnixMs <= 0n
      || (
        header.deadlineAtUnixMs !== undefined
        && (
          header.deadlineAtUnixMs <= 0n
          || header.deadlineAtUnixMs <= header.sentAtUnixMs
        )
      )
    ) throw new RangeError('invalid management header');
  } catch (cause) {
    throw failure('invalid_header', 'management frame header is invalid', cause);
  }
}

function failure(
  code: HostSupervisorFactError['code'],
  message: string,
  cause?: unknown,
): HostSupervisorFactError {
  return new HostSupervisorFactError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}
