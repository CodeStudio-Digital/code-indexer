import {
  rustHostAttemptAborted,
} from './RustHostAttemptCoordinatorError.js';
import type {
  AuthenticatedAttemptLifecyclePort,
} from './RustHostAttemptCoordinatorTypes.js';

/**
 * Bounds an adapter that settles late after cancellation. A late lifecycle is
 * immediately revoked instead of becoming an orphaned authenticated channel.
 */
export async function openRustAttemptControl<
  T extends AuthenticatedAttemptLifecyclePort,
>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const guarded = operation.then((lifecycle) => {
    if (signal.aborted) {
      lifecycle.abort();
      throw rustHostAttemptAborted(signal.reason);
    }
    return lifecycle;
  });
  if (signal.aborted) {
    void guarded.catch(() => undefined);
    throw rustHostAttemptAborted(signal.reason);
  }
  let listener: (() => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    listener = () => reject(rustHostAttemptAborted(signal.reason));
    signal.addEventListener('abort', listener, { once: true });
  });
  try {
    return await Promise.race([guarded, cancellation]);
  } finally {
    if (listener) signal.removeEventListener('abort', listener);
  }
}
