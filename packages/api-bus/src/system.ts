import type { ApiContext, AsyncStream } from './common.js';

/**
 * `system` namespace — host-level diagnostics + remediation for the desktop
 * shell. Backs the first-run preflight wizard (Podman / machine / WSL2 / git /
 * disk / sandbox image). Mirrors the @mcp/services preflight report shape on
 * the wire (kept structurally identical so the handler returns it verbatim).
 */

export type PreflightCheckStatus = 'ok' | 'missing' | 'warn' | 'error';

export interface PreflightCheck {
  id: string;
  label: string;
  status: PreflightCheckStatus;
  /** A failed blocking check sets `report.blocked` (gates the wizard's Continue). */
  blocking: boolean;
  message: string;
  /** Stable hint key the UI maps to an action button (e.g. 'install-podman'). */
  remediation?: string;
  detail?: Record<string, unknown>;
}

export interface PreflightReport {
  platform: string;
  ok: boolean;
  blocked: boolean;
  checks: PreflightCheck[];
  generatedAt: string;
}

/** Progress frames for the guided Podman-machine setup (init + start). */
export type MachineSetupEvent =
  | { event: 'start'; data: { platform: string } }
  | { event: 'phase'; data: { phase: string; label: string } }
  | { event: 'log'; data: { stream: 'stdout' | 'stderr'; chunk: string } }
  | { event: 'done'; data: { ok: true } }
  | { event: 'error'; data: { message: string; stderrTail?: string } };

export interface SystemApi {
  /** Run every first-run host check and return a report. */
  preflight(input: void, ctx: ApiContext): Promise<PreflightReport>;

  /**
   * Create (if needed) + start the Podman machine on Windows/macOS; no-op on
   * Linux. Streams init/start output. The `Stream` suffix makes the Electron
   * IPC bridge auto-bind it as a MessagePort stream (see handlers-mount).
   */
  podmanMachineSetupStream(input: void, ctx: ApiContext): AsyncStream<MachineSetupEvent>;
}
