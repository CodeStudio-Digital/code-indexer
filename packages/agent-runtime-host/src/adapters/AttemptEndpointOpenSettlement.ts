import { AttemptControlAdapterError } from './AttemptControlAdapterError.js';
import type {
  AuthenticatedAttemptConnectionOwner,
  ProtectedAttemptEndpointKind,
} from './ProtectedAttemptEndpoint.js';

/**
 * Cancellation never abandons a late physical connection. A result settling
 * after cancellation is synchronously transferred to the native reaper.
 */
export async function awaitAuthenticatedAttemptConnection<
  K extends ProtectedAttemptEndpointKind,
>(
  operation: Promise<AuthenticatedAttemptConnectionOwner<K>>,
  signal: AbortSignal,
  revoke: (
    owner: AuthenticatedAttemptConnectionOwner<K>,
    cause?: unknown,
  ) => unknown,
): Promise<AuthenticatedAttemptConnectionOwner<K>> {
  const guarded = operation.then((owner) => {
    if (signal.aborted) {
      revoke(owner, signal.reason);
      throw aborted(signal.reason);
    }
    return owner;
  });
  if (signal.aborted) {
    void guarded.catch(() => undefined);
    throw aborted(signal.reason);
  }
  let listener: (() => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    listener = () => reject(aborted(signal.reason));
    signal.addEventListener('abort', listener, { once: true });
  });
  try {
    return await Promise.race([guarded, cancellation]);
  } finally {
    if (listener) signal.removeEventListener('abort', listener);
  }
}

function aborted(cause?: unknown): AttemptControlAdapterError {
  return new AttemptControlAdapterError(
    'aborted',
    'physical attempt endpoint open was aborted',
    cause === undefined ? undefined : { cause },
  );
}
