import type { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import type { OutboundRequestFacts } from './AttemptCorrelationValidation.js';
import { encodeOutboundFrame } from './OutboundHeaderFactory.js';
import { OutboundFrameError } from './OutboundFrameError.js';
import type { OutboundAuthorityState } from './OutboundAuthorityTypes.js';
import {
  type OutboundDisposition,
  type PendingOutbound,
  mintOutboundReservation,
} from './OutboundReservation.js';

const MAX_UINT64 = (1n << 64n) - 1n;

export function prepareOutboundReservation(
  state: OutboundAuthorityState,
  payload: agentV1Runtime.FramePayload,
  disposition: OutboundDisposition,
  replyToMessageId: string | undefined,
  sentAtUnixMs: bigint,
  deadlineAtUnixMs: bigint,
  requestFacts?: OutboundRequestFacts,
): PendingOutbound {
  const streamSeq = state.committedStreamSeq + 1n;
  if (streamSeq > MAX_UINT64) {
    throw new OutboundFrameError('sequence_exhausted', 'outbound sequence exhausted');
  }
  const messageId = `outbound:${state.senderId}:${streamSeq}`;
  const encodedFrame = encodeOutboundFrame(
    state,
    {
      streamSeq,
      messageId,
      replyToMessageId,
      sentAtUnixMs,
      deadlineAtUnixMs,
    },
    payload,
    state.maximumFrameBytes,
  );
  return mintOutboundReservation({
    streamSeq,
    messageId,
    payloadCase: payload.body.case,
    disposition,
    payloadDigest: encodedFrame.payloadDigest,
    sentAtUnixMs,
    requestFacts,
    encoded: encodedFrame.encoded,
  });
}
