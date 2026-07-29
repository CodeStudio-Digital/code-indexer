import {
  rustHostManagementSequenceFailure,
} from './RustHostAttemptCoordinatorError.js';
import type {
  AuthenticatedAttemptLifecyclePort,
} from './RustHostAttemptCoordinatorTypes.js';

export function callOwnedAttemptLifecycle<T>(
  lifecycle: AuthenticatedAttemptLifecyclePort,
  operation: (value: AuthenticatedAttemptLifecyclePort) => T,
  fail: (cause: unknown) => void,
): T {
  try {
    const result = operation(lifecycle);
    if (lifecycle.isFailed) {
      throw rustHostManagementSequenceFailure(
        'active lifecycle authority failed',
      );
    }
    return result;
  } catch (cause) {
    fail(cause);
    throw cause;
  }
}
