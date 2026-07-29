/** Runs every revocation action while preserving the caller's first failure. */
export function bestEffortAttemptCleanup(
  actions: readonly (() => void)[],
): void {
  for (const action of actions) {
    try {
      action();
    } catch {
      // Teardown is exhaustive; the coordinator retains the initiating cause.
    }
  }
}
