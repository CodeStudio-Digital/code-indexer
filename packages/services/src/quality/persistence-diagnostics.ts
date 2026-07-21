const MAX_WARNED_FAILURES = 32;
const warnedFailures = new Set<string>();

/** Report a persistence failure once without letting Quality break the run. */
export function warnQualityPersistenceFailure(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const key = `${context}:${message}`;
  if (warnedFailures.has(key)) return;

  warnedFailures.add(key);
  if (warnedFailures.size > MAX_WARNED_FAILURES) {
    const oldest = warnedFailures.values().next().value;
    if (oldest !== undefined) warnedFailures.delete(oldest);
  }
  console.warn(`[quality] ${context} persistence failed: ${message}`);
}
