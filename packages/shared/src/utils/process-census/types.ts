/**
 * Shared shapes for the OS-level process census that backs the task manager.
 *
 * The census exists because `app.getAppMetrics()` only sees processes Electron
 * itself created (main, renderers, GPU, utility). Everything the IDE spawns
 * through `child_process` / node-pty — terminals, their grandchildren
 * (`npm run dev` → vite → esbuild, `winpty-agent.exe`), LSP servers, `git`,
 * debug adapters, MCP stdio servers — is invisible to it.
 *
 * Every module in this folder is PURE: no spawning, no timers, no platform
 * checks. The platform-specific collectors live in the http-api and feed these
 * parsers raw stdout, which is what makes the arithmetic testable.
 */

/** One process as reported by the platform collector, before any derivation. */
export interface RawProcessRow {
  pid: number;
  /** Parent pid. 0 when the platform reports none. */
  ppid: number;
  /** Executable name (`node.exe`, `git`), NOT the full path. */
  exe: string;
  /** Resident/working-set bytes — what Task Manager's "Memory" column shows. */
  workingSetBytes: number;
  /** Private (non-shared) bytes. Windows only; `ps` has no equivalent. */
  privateBytes?: number;
  /** Total CPU time consumed since start (kernel + user), in milliseconds. */
  cpuTimeMs: number;
  /** Cumulative I/O bytes. Windows only. */
  readBytes?: number;
  writeBytes?: number;
  /**
   * Process start time, epoch ms. Guards against PID reuse: a recycled pid
   * that kept its old CPU counter would otherwise report an absurd delta.
   * `0` when the platform did not report one.
   */
  createdAtMs: number;
}

/**
 * One complete collector emission. `commandLines` is separate from the rows
 * because on Windows it is fetched only for pids seen for the first time
 * (~322ms/154KB for a full scan vs ~104ms/19KB without it), and cached by the
 * collector across frames.
 */
export interface CensusFrame {
  /** Epoch ms the frame was assembled. Drives every per-second rate. */
  at: number;
  rows: RawProcessRow[];
  commandLines: Map<number, string>;
}

/** Per-pid rates derived from two consecutive frames. */
export interface DerivedRates {
  /**
   * Percent of ONE core, so a busy multi-threaded process can exceed 100 —
   * the same convention as Electron's `percentCPUUsage`, which the existing
   * perf panel already renders. `null` means "not derivable yet" (first frame
   * for this pid, or the pid was reused), never `0`.
   */
  cpuPercent: number | null;
  /** Combined read+write bytes per second, or `null` when not derivable. */
  diskBytesPerSec: number | null;
}
