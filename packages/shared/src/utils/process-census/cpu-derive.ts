/**
 * Rate derivation between two consecutive census frames.
 *
 * Neither platform reports an instantaneous CPU percentage — both expose a
 * monotonic "CPU time consumed since start" counter, so the percentage is the
 * delta of that counter over the wall-clock delta.
 *
 * The single most important rule here is that a value that cannot be derived
 * yet returns `null`, never `0`: a process that just appeared has no previous
 * counter, and rendering it as "0%" would hide a process that is in fact
 * pinning a core. The task manager shows `—` for null.
 */
import type { CensusFrame, DerivedRates, RawProcessRow } from './types.js';

/**
 * Two samples belong to the same process only if their reported start times
 * agree. POSIX `etime` has one-second resolution, so the start time it implies
 * drifts by up to a second between frames — hence a tolerance rather than an
 * equality check. Windows `CreationDate` is exact and always well inside it.
 */
const SAME_PROCESS_TOLERANCE_MS = 2_000;

function sameProcess(prev: RawProcessRow, next: RawProcessRow): boolean {
  if (prev.createdAtMs === 0 || next.createdAtMs === 0) return true; // unknown → trust the pid
  return Math.abs(prev.createdAtMs - next.createdAtMs) <= SAME_PROCESS_TOLERANCE_MS;
}

const NOT_DERIVABLE: DerivedRates = { cpuPercent: null, diskBytesPerSec: null };

/**
 * Derive per-pid CPU and disk rates. `cores` only bounds the CPU clamp: the
 * percentage is relative to ONE core (Electron's `percentCPUUsage` convention),
 * so a 4-thread build legitimately reports 400% on a 4-core box.
 */
export function deriveRates(
  prev: CensusFrame | null,
  next: CensusFrame,
  cores: number,
): Map<number, DerivedRates> {
  const out = new Map<number, DerivedRates>();
  const elapsedMs = prev ? next.at - prev.at : 0;
  if (!prev || elapsedMs <= 0) {
    for (const row of next.rows) out.set(row.pid, NOT_DERIVABLE);
    return out;
  }

  const previousByPid = new Map(prev.rows.map((row) => [row.pid, row]));
  const cpuCeiling = 100 * Math.max(1, cores);

  for (const row of next.rows) {
    const before = previousByPid.get(row.pid);
    if (!before || !sameProcess(before, row)) {
      out.set(row.pid, NOT_DERIVABLE);
      continue;
    }

    const cpuDeltaMs = row.cpuTimeMs - before.cpuTimeMs;
    const cpuPercent = cpuDeltaMs < 0
      // A counter that went backwards means the pid was recycled without the
      // start time catching it. Reporting nothing beats reporting nonsense.
      ? null
      : Math.min(cpuCeiling, Math.round((cpuDeltaMs / elapsedMs) * 1000) / 10);

    const ioNow = (row.readBytes ?? 0) + (row.writeBytes ?? 0);
    const ioBefore = (before.readBytes ?? 0) + (before.writeBytes ?? 0);
    const hasIo = row.readBytes !== undefined || row.writeBytes !== undefined;
    const ioDelta = ioNow - ioBefore;
    const diskBytesPerSec = hasIo && ioDelta >= 0
      ? Math.round((ioDelta / elapsedMs) * 1000)
      : null;

    out.set(row.pid, { cpuPercent, diskBytesPerSec });
  }

  return out;
}
