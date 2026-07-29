import {
  type BoundedReplayOutcome,
  mintReplayOutcome,
  mintSharedReplayOutcome,
} from './AttemptFrameTransaction.js';
import { AttemptFrameReceiverError } from './AttemptFrameReceiverError.js';

export function acceptedReplayOutcome(
  receiverBinding: object,
): BoundedReplayOutcome {
  return mintReplayOutcome({
    receiverBinding,
    kind: 'accepted',
  });
}

export function responseReplayOutcome(
  receiverBinding: object,
  bytes: Uint8Array,
  maximumFrameBytes: number,
  share: boolean,
): BoundedReplayOutcome {
  if (bytes.byteLength === 0 || bytes.byteLength > maximumFrameBytes) {
    throw new AttemptFrameReceiverError(
      'invalid_replay_response',
      'replay response is empty or exceeds negotiated maximum',
    );
  }
  const value = {
    receiverBinding,
    kind: 'response' as const,
    response: bytes,
  };
  return share
    ? mintSharedReplayOutcome(value)
    : mintReplayOutcome(value);
}
