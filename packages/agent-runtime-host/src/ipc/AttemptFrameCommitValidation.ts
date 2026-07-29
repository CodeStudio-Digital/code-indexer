import type { PendingInbound } from './AttemptFrameTransaction.js';
import {
  pendingMatchesBinding,
  type PendingSnapshot,
} from './AttemptFrameTransaction.js';
import { AttemptFrameReceiverError } from './AttemptFrameReceiverError.js';

export interface PendingReservation {
  readonly token: bigint;
  readonly messageId: string;
  readonly streamSeq: bigint;
  readonly digest: string;
  readonly pending: PendingInbound;
}

export function assertPendingReservation(
  active: PendingReservation | undefined,
  pending: PendingInbound,
  candidate: PendingSnapshot,
  receiverBinding: object,
): asserts active is PendingReservation {
  if (
    !active
    || !pendingMatchesBinding(pending, receiverBinding)
    || candidate.token !== active.token
    || candidate.messageId !== active.messageId
    || candidate.streamSeq !== active.streamSeq
    || Buffer.from(candidate.envelopeDigest).toString('hex') !== active.digest
  ) {
    throw new AttemptFrameReceiverError(
      'invalid_pending',
      'pending token is foreign or stale',
    );
  }
}

export function assertReplayResponseLength(
  responseLength: number | undefined,
  maximumFrameBytes: number,
): void {
  if (
    responseLength !== undefined
    && (responseLength === 0 || responseLength > maximumFrameBytes)
  ) {
    throw new AttemptFrameReceiverError(
      'invalid_replay_response',
      'replay response is empty or exceeds negotiated maximum',
    );
  }
}
