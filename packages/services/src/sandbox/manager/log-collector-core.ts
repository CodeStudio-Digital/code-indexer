/**
 * PURE core of the per-service log collector (company B4) — no I/O, no
 * timers, no driver. `log-collector.ts` orchestrates the container exec
 * calls and feeds raw bytes/strings through these helpers, so all the
 * fiddly edge cases (byte offsets, truncation resets, carry of partial
 * lines, `docker logs --timestamps` dedup) are unit-testable without a
 * container runtime.
 */

export type CollectedStream = 'devserver' | 'container';

export interface CollectedLogLine {
  atMs: number;
  serviceId: string;
  stream: CollectedStream;
  line: string;
}

/** Hard cap per stored line (chars ≈ bytes for the ASCII-dominated dev logs). */
export const MAX_LINE_CHARS = 2_048;

/** Truncates one line to the 2KB cap, marking the cut with an ellipsis. */
export function truncateLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return `${line.slice(0, MAX_LINE_CHARS - 1)}…`;
}

export interface CarrySplit {
  lines: string[];
  carry: string;
}

/**
 * Splits `carry + chunk` on newlines; the trailing partial line (no `\n`
 * yet) becomes the next `carry` so a line written across two collection
 * ticks is emitted exactly once, whole. Empty lines are dropped — they
 * carry no signal and would waste ring-buffer rows.
 */
export function splitWithCarry(carry: string, chunk: string): CarrySplit {
  const combined = carry + chunk;
  const parts = combined.split('\n');
  const nextCarry = parts.pop() ?? '';
  return {
    lines: parts.map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== ''),
    carry: nextCarry,
  };
}

export interface ReadPlan {
  /** Byte offset to start reading from (0-based). */
  start: number;
  /** Bytes to read this tick (0 = nothing new). */
  take: number;
  /** True when the file shrank under the cursor (dev-server restart / log rotation). */
  reset: boolean;
}

/**
 * Plans the next incremental read given the remembered byte offset and
 * the file's current size. A file smaller than the cursor means it was
 * truncated/recreated — restart from 0 (bounded by `maxChunk`).
 */
export function planIncrementalRead(offset: number, size: number, maxChunk: number): ReadPlan {
  if (size < offset) {
    return { start: 0, take: Math.min(size, maxChunk), reset: true };
  }
  return { start: offset, take: Math.min(size - offset, maxChunk), reset: false };
}

/**
 * First-sight cursor for a file we have never read: seed a bounded tail
 * (`seedBytes`) instead of 0, so a service that has been running for a
 * while contributes recent context without replaying megabytes of
 * history into the ring buffer.
 */
export function seedOffset(size: number, seedBytes: number): number {
  return Math.max(0, size - seedBytes);
}

export interface ContainerParseResult {
  entries: Array<{ atMs: number; line: string }>;
  /** Highest timestamp seen (epoch ms) — the next call's dedup floor. */
  lastTs: number;
}

/**
 * Parses `docker/podman logs --timestamps` output (the format
 * `CliOciDriver.getContainerLogs` already returns) and keeps only lines
 * STRICTLY newer than `lastTs` — that is the dedup mechanism, since the
 * driver has no `--since` parameter. Millisecond-precision ties are
 * dropped by design (they were already collected in the batch that set
 * `lastTs`, because persistence happens before the floor advances).
 * The `--- stderr ---` separator the driver inserts is skipped; lines
 * without a parseable timestamp are only accepted on the first pass
 * (`lastTs === 0`), stamped with `nowMs`.
 */
export function parseContainerLogs(
  raw: string,
  lastTs: number,
  nowMs: number,
): ContainerParseResult {
  const entries: Array<{ atMs: number; line: string }> = [];
  let maxTs = lastTs;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '' || line.trim() === '--- stderr ---') continue;
    const m = /^(\d{4}-\d{2}-\d{2}T\S+)\s(.*)$/.exec(line);
    if (!m) {
      if (lastTs === 0) entries.push({ atMs: nowMs, line });
      continue;
    }
    const ts = Date.parse(m[1]);
    if (!Number.isFinite(ts)) {
      if (lastTs === 0) entries.push({ atMs: nowMs, line });
      continue;
    }
    if (ts <= lastTs) continue;
    entries.push({ atMs: ts, line: m[2] });
    if (ts > maxTs) maxTs = ts;
  }
  return { entries, lastTs: maxTs };
}
