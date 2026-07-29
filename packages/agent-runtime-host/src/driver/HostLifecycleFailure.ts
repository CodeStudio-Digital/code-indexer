import { AttemptFrameReceiverError } from '../ipc/AttemptFrameReceiver.js';
import { DelimitedChannelError } from '../ipc/DelimitedByteChannel.js';

export function canonicalLifecycleFailure(cause: unknown): unknown {
  if (
    cause instanceof DelimitedChannelError
    && cause.code === 'transport_error'
    && cause.cause instanceof AttemptFrameReceiverError
    && cause.cause.code === 'deadline_expired'
  ) {
    return cause.cause;
  }
  return cause;
}
