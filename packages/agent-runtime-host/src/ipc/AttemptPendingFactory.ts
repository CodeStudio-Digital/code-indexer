import type { ValidatedAttemptFrame } from './AttemptFrame.js';
import {
  type PendingInbound,
  mintPending,
} from './AttemptFrameTransaction.js';

export function pendingFromValidatedFrame(
  receiverBinding: object,
  token: bigint,
  validated: ValidatedAttemptFrame,
): PendingInbound {
  const header = validated.frame.header!;
  const body = validated.payload.body;
  return mintPending({
    receiverBinding,
    token,
    messageId: validated.messageId,
    streamSeq: header.streamSeq,
    envelopeDigest: validated.envelopeDigest.slice(),
    payloadDigest: validated.payloadDigest.slice(),
    payloadCase: body.case,
    replyToMessageId: header.replyToMessageId,
    deadlineAtUnixMs: header.deadlineAtUnixMs,
    sentAtUnixMs: header.sentAtUnixMs,
    terminalPayloadSha256: body.case === 'terminalProposal'
      ? body.value.terminalPayloadSha256.slice()
      : undefined,
  }, validated);
}
