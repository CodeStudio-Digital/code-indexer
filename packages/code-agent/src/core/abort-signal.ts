/**
 * Runtime guard for AbortSignal values that may have crossed an IPC boundary.
 * Node's structured clone currently turns AbortSignal into a plain object, so
 * a TypeScript annotation alone is not enough before calling EventTarget APIs.
 */
export function asAbortSignal(value: unknown): AbortSignal | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<AbortSignal>;
  return typeof candidate.aborted === 'boolean' &&
    typeof candidate.addEventListener === 'function' &&
    typeof candidate.removeEventListener === 'function'
    ? candidate as AbortSignal
    : undefined;
}
