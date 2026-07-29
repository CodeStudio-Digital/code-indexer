import type { AuthorityClock } from './AttemptClock.js';
import {
  type AttemptFrameReceiver,
  AttemptFrameReceiverError,
} from './AttemptFrameReceiver.js';
import type { DelimitedByteChannel } from './DelimitedByteChannel.js';
import {
  type EstablishedAttemptChannel,
  createEstablishedAttemptChannel,
} from './EstablishedAttemptChannel.js';
import type { OutboundHeaderAuthority } from './OutboundHeaderAuthority.js';

export function handoffEstablishedAttemptChannel(
  transport: DelimitedByteChannel,
  receiver: AttemptFrameReceiver,
  sender: OutboundHeaderAuthority,
  owner: object,
  clock: AuthorityClock,
  hardDeadlineAtUnixMs: bigint,
  maximumPendingMs: number,
  failureObserver?: (cause: unknown) => void,
): EstablishedAttemptChannel {
  transport.claim(owner);
  if (transport.maximumFrameBytes !== receiver.maximumFrameBytes) {
    const error = new AttemptFrameReceiverError(
      'invalid_seed',
      'physical frame cap must equal negotiated maximum',
    );
    transport.fail(error, owner);
    receiver.fail();
    sender.poison();
    throw error;
  }
  return createEstablishedAttemptChannel(
    transport,
    receiver,
    sender,
    owner,
    clock,
    hardDeadlineAtUnixMs,
    maximumPendingMs,
    failureObserver,
  );
}
