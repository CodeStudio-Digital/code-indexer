import { HostDataChannelError } from '../ipc/HostDataChannelError.js';
import { AttemptControlAdapterError } from './AttemptControlAdapterError.js';

export function normalizeShadowAttemptDataFailure(cause: unknown): Error {
  if (
    cause instanceof AttemptControlAdapterError
    || cause instanceof HostDataChannelError
  ) return cause;
  return new AttemptControlAdapterError(
    'invalid_connection',
    'shadow attempt data hydration failed closed',
    { cause },
  );
}
