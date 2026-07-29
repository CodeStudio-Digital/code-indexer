/**
 * Parser for the Windows collector's line protocol.
 *
 * The collector is a long-lived `powershell.exe` running `Get-CimInstance
 * Win32_Process` in a loop (spawning one per tick is impossible: PowerShell
 * startup alone costs ~1.5s, while the query itself is ~104ms). It emits
 * tab-separated records with a sentinel prefix so a frame can be assembled
 * incrementally from a stdout stream that arrives in arbitrary chunks:
 *
 *   #P <pid> <ppid> <exe> <ws> <priv> <kernel100ns> <user100ns> <read> <write> <createdMs>
 *   #C <pid> <commandLine>          — only for pids not seen before
 *   #E <epochMs>                    — closes the frame
 *
 * Anything else (PowerShell warnings, blank lines) is ignored rather than
 * throwing: a diagnostics panel must degrade, never crash the backend.
 */
import type { CensusFrame, RawProcessRow } from './types.js';

/** Windows reports CPU time in 100-nanosecond ticks. */
const TICKS_PER_MS = 10_000;

function num(field: string | undefined): number {
  if (!field) return 0;
  const value = Number(field);
  return Number.isFinite(value) ? value : 0;
}

/** Parse a `#P` record. Returns null when the line is malformed or truncated. */
export function parseWindowsProcessLine(line: string): RawProcessRow | null {
  const f = line.split('\t');
  if (f[0] !== '#P' || f.length < 11) return null;
  const pid = num(f[1]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return {
    pid,
    ppid: num(f[2]),
    exe: f[3] ?? '',
    workingSetBytes: num(f[4]),
    privateBytes: num(f[5]),
    cpuTimeMs: (num(f[6]) + num(f[7])) / TICKS_PER_MS,
    readBytes: num(f[8]),
    writeBytes: num(f[9]),
    createdAtMs: num(f[10]),
  };
}

/**
 * Parse a `#C` record. The command line itself may contain tabs (a quoted
 * argument can), so everything after the pid is rejoined.
 */
export function parseWindowsCommandLine(line: string): { pid: number; command: string } | null {
  const f = line.split('\t');
  if (f[0] !== '#C' || f.length < 3) return null;
  const pid = num(f[1]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, command: f.slice(2).join('\t') };
}

export interface WindowsFrameAssembler {
  /** Feed one complete line; returns a frame only when `#E` closes it. */
  push: (line: string) => CensusFrame | null;
  /** Drop the partially accumulated frame (used when the collector restarts). */
  reset: () => void;
}

/**
 * Accumulate lines into frames. Stateful but I/O-free — the collector owns the
 * stdout splitting, this owns the protocol.
 *
 * A frame that never receives its `#E` (collector killed mid-emission) is
 * simply discarded when the next `#P` block starts a new one, so a truncated
 * tail can never be mistaken for a complete census.
 */
export function createWindowsFrameAssembler(): WindowsFrameAssembler {
  let rows: RawProcessRow[] = [];
  let commandLines = new Map<number, string>();

  const reset = (): void => {
    rows = [];
    commandLines = new Map();
  };

  return {
    reset,
    push(line: string): CensusFrame | null {
      if (line.charCodeAt(0) !== 35 /* '#' */) return null;

      if (line.startsWith('#P\t')) {
        const row = parseWindowsProcessLine(line);
        if (row) rows.push(row);
        return null;
      }

      if (line.startsWith('#C\t')) {
        const entry = parseWindowsCommandLine(line);
        if (entry) commandLines.set(entry.pid, entry.command);
        return null;
      }

      if (line.startsWith('#E\t')) {
        // An `#E` with no rows means the query itself failed inside the loop;
        // emitting an empty frame would read as "the app has no processes".
        if (rows.length === 0) {
          reset();
          return null;
        }
        const at = num(line.split('\t')[1]);
        const frame: CensusFrame = {
          at: at > 0 ? at : Date.now(),
          rows,
          commandLines,
        };
        reset();
        return frame;
      }

      return null;
    },
  };
}
