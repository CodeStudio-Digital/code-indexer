/**
 * Bridge for Electron-only profiling capabilities (contentTracing + renderer
 * CDP), which CANNOT be imported into this transport-agnostic package (it also
 * runs headless). The Electron main process registers an implementation at boot
 * via `setElectronProfiler`; the perf routes read it via `getElectronProfiler`
 * and return 501 when absent (headless / web deploy). Mirrors `getPerfSampler`.
 */

export interface ElectronProfiler {
  /** Begin a whole-app Perfetto/chrome-tracing recording (main+renderer+gpu+workers). */
  startFullTrace(): Promise<void>;
  /** Stop and flush the recording; resolves to the trace file path (Chromium JSON). */
  stopFullTrace(): Promise<{ path: string }>;
  /** Record for `durationMs` then stop — convenience for a fixed-window capture. */
  fullTrace(durationMs: number): Promise<{ path: string }>;
  /** Whether a full trace is currently recording. */
  isTracing(): boolean;
  /** Capture a renderer-process V8 CPU profile (.cpuprofile JSON) via CDP. */
  rendererProfile(durationMs: number): Promise<object>;
}

let impl: ElectronProfiler | null = null;

export function setElectronProfiler(p: ElectronProfiler | null): void {
  impl = p;
}

export function getElectronProfiler(): ElectronProfiler | null {
  return impl;
}
