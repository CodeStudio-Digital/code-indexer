/**
 * Parser for the POSIX collector's `ps` output.
 *
 * Command: `ps -eo pid=,ppid=,rss=,time=,etime=,comm=,args=`
 * (`time`/`etime` rather than the procps-only `cputime`/`etimes`, so the same
 * invocation works on macOS BSD `ps`.)
 *
 * Unlike Windows, `ps` is cheap enough (10-20ms) to run once per tick, and it
 * hands back the full command line for free — there is no per-pid cache here.
 *
 * The elapsed time is converted into a start timestamp so PID-reuse detection
 * works exactly like on Windows. Note it only has second resolution, which is
 * why `cpu-derive` compares start times with a tolerance instead of `===`.
 */
import type { CensusFrame, RawProcessRow } from './types.js';

// pid ppid rss time etime comm args… — `args` is last precisely because it is
// the only field that can contain spaces.
const ROW_RE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/;

/**
 * Parse `[[dd-]hh:]mm:ss` — the shape `ps` uses for both CPU time and elapsed
 * time. Returns null for anything else (a `-` placeholder, a stray header).
 */
export function parsePsDurationMs(text: string): number | null {
  const [dayPart, clockPart] = text.includes('-') ? text.split('-', 2) : [null, text];
  const days = dayPart === null ? 0 : Number(dayPart);
  if (!Number.isFinite(days) || days < 0) return null;

  const parts = (clockPart ?? '').split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  let seconds = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isFinite(value) || value < 0) return null;
    seconds = seconds * 60 + value;
  }
  return Math.round((days * 86_400 + seconds) * 1000);
}

/** Parse one `ps` line. Returns null for headers, blanks and malformed rows. */
export function parsePosixRow(
  line: string,
  at: number,
): { row: RawProcessRow; command: string } | null {
  const m = ROW_RE.exec(line);
  if (!m) return null;
  const pid = Number(m[1]);
  if (!Number.isInteger(pid) || pid <= 0) return null;

  const cpuTimeMs = parsePsDurationMs(m[4] ?? '');
  const elapsedMs = parsePsDurationMs(m[5] ?? '');
  if (cpuTimeMs === null) return null;

  return {
    row: {
      pid,
      ppid: Number(m[2]) || 0,
      exe: m[6] ?? '',
      // `ps` reports RSS in kilobytes.
      workingSetBytes: (Number(m[3]) || 0) * 1024,
      cpuTimeMs,
      createdAtMs: elapsedMs === null ? 0 : at - elapsedMs,
    },
    command: (m[7] ?? '').trim(),
  };
}

/** Parse a full `ps` stdout into a frame stamped with the collection time. */
export function parsePosixFrame(stdout: string, at: number): CensusFrame {
  const rows: RawProcessRow[] = [];
  const commandLines = new Map<number, string>();
  for (const line of stdout.split('\n')) {
    const parsed = parsePosixRow(line, at);
    if (!parsed) continue;
    rows.push(parsed.row);
    if (parsed.command) commandLines.set(parsed.row.pid, parsed.command);
  }
  return { at, rows, commandLines };
}
