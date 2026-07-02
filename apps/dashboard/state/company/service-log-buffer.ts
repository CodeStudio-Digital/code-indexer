/**
 * PURE bounded-buffer logic for the live service-log tail (company B6).
 * Kept out of `sandboxSlice.ts` so the append/normalization rules are
 * unit-testable without zustand.
 */

export interface ServiceLogEntry {
  /** Monotonic per-service sequence — stable React key + ordering. */
  seq: number;
  atMs: number;
  stream: string;
  line: string;
}

/** Raw line shape as it arrives on the `sandbox.service.log_batch` SSE event. */
export interface IncomingServiceLogLine {
  atMs?: number;
  stream?: string;
  line?: string;
}

export const SERVICE_LOG_BUFFER_CAP = 500;

/**
 * Appends a batch to a per-service buffer, normalizing defensively
 * (missing fields tolerated, blank lines dropped) and keeping only the
 * newest `cap` entries. Never mutates `prev`.
 */
export function appendServiceLogLines(
  prev: readonly ServiceLogEntry[] | undefined,
  incoming: readonly IncomingServiceLogLine[],
  cap: number = SERVICE_LOG_BUFFER_CAP,
): ServiceLogEntry[] {
  const base = prev ?? [];
  let seq = base.length > 0 ? base[base.length - 1].seq : 0;
  const appended: ServiceLogEntry[] = [];
  for (const raw of incoming) {
    const line = typeof raw?.line === 'string' ? raw.line : '';
    if (line.trim() === '') continue;
    seq += 1;
    appended.push({
      seq,
      atMs: typeof raw.atMs === 'number' && Number.isFinite(raw.atMs) ? raw.atMs : Date.now(),
      stream: typeof raw.stream === 'string' && raw.stream ? raw.stream : 'devserver',
      line,
    });
  }
  if (appended.length === 0) return base.slice();
  const merged = [...base, ...appended];
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}
