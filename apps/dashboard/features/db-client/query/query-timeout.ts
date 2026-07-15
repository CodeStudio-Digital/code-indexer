/** Query-console limits: enough for reports, bounded enough for a stuck query. */
export const MIN_QUERY_TIMEOUT_SECONDS = 1;
export const MAX_QUERY_TIMEOUT_SECONDS = 60 * 60;
export const DEFAULT_QUERY_TIMEOUT_SECONDS = 60;

/** Convert the text-input value to the millisecond API contract. */
export function queryTimeoutMsFromSeconds(value: string): number | null {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < MIN_QUERY_TIMEOUT_SECONDS || seconds > MAX_QUERY_TIMEOUT_SECONDS) {
    return null;
  }
  return seconds * 1_000;
}
