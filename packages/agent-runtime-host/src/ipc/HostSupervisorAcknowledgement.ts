import { create } from '@bufbuild/protobuf';
import { agentV1Supervisor } from '@mcp/agent-runtime-contracts';
import {
  HostSupervisorFactError,
} from '../driver/HostSupervisorFactError.js';
import type {
  HostSupervisorFactHandoff,
} from '../driver/HostSupervisorFactTypes.js';
import {
  encodeManagementFrame,
  managementEnvelopeSha256,
} from './ManagementFrame.js';
import type {
  SupervisorAckReplay,
} from './HostSupervisorReplayHistory.js';

export function encodeSupervisorAcknowledgement(
  handoff: HostSupervisorFactHandoff,
  replay: SupervisorAckReplay,
): Uint8Array {
  const payload = create(agentV1Supervisor.ManagementPayloadSchema, {
    body: {
      case: 'managementAck',
      value: {
        acknowledgedMessageId: replay.inboundMessageId,
        acknowledgedPayloadSha256: replay.inboundPayloadSha256,
        acknowledgedAtUnixMs: replay.acknowledgedAtUnixMs,
      },
    },
  });
  return encodeManagementFrame(
    create(agentV1Supervisor.ManagementFrameHeaderSchema, {
      protocolVersion: handoff.protocolVersion,
      connectionId: handoff.connectionId,
      messageId: replay.outboundMessageId,
      replyToMessageId: replay.inboundMessageId,
      streamSeq: replay.outboundStreamSeq,
      sentAtUnixMs: replay.acknowledgedAtUnixMs,
    }),
    payload,
  );
}

export function managementEnvelopeFingerprint(encoded: Uint8Array): {
  readonly bytes: Uint8Array;
  readonly hex: string;
} {
  const bytes = managementEnvelopeSha256(encoded);
  return { bytes, hex: Buffer.from(bytes).toString('hex') };
}

export function normalizeSupervisorFactFailure(
  cause: unknown,
  fallback: HostSupervisorFactError['code'] = 'invalid_frame',
): HostSupervisorFactError {
  return cause instanceof HostSupervisorFactError
    ? cause
    : new HostSupervisorFactError(
      fallback,
      fallback === 'aborted'
        ? 'management fact processing was aborted'
        : 'management fact processing failed closed',
      { cause },
    );
}
