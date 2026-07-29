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
let tracingCache = false;

export function setElectronProfiler(p: ElectronProfiler | null): void {
  impl = p;
  if (!p) tracingCache = false;
}

export function getElectronProfiler(): ElectronProfiler | null {
  return impl;
}

/**
 * Push the tracing flag in from the owning process.
 *
 * `isTracing()` is the one SYNCHRONOUS method on this interface. Every other
 * method returns a promise, so an out-of-process implementation can forward
 * them over an RPC bridge — but a sync getter cannot be satisfied by an RPC.
 * Rather than widen the signature (which would ripple into every caller for
 * the sake of one boolean), the owner pushes the value on change and a
 * forwarding shim answers `isTracing()` from this cache.
 *
 * No-op for the in-process host, where `impl.isTracing()` is already the truth.
 */
export function setElectronTracingFlag(tracing: boolean): void {
  tracingCache = tracing;
}

/** Last value pushed via `setElectronTracingFlag`. For forwarding shims only. */
export function getCachedElectronTracingFlag(): boolean {
  return tracingCache;
}
