/**
 * First-run preflight contract — what the host checks before container-backed
 * features (sandboxes) can work. The dashboard wizard renders these results;
 * the api-bus `system` namespace mirrors this shape on the wire (kept
 * structurally identical so the handler returns this object verbatim).
 */
import type { IShellPort } from '@mcp/code-agent/ports/shell-port.js';

export type CheckId =
  | 'podman'
  | 'podman-machine'
  | 'wsl2'
  | 'git'
  | 'disk'
  | 'sandbox-image';

export type CheckStatus = 'ok' | 'missing' | 'warn' | 'error';

/**
 * One preflight result. `label`/`message` are English fallbacks — the UI
 * re-labels by `id` via i18n; `remediation` keys an action button (e.g.
 * 'install-podman' → "Open download page", 'init-machine' → machine setup).
 */
export interface CheckResult {
  id: CheckId;
  label: string;
  status: CheckStatus;
  /** A failed blocking check sets `report.blocked` (gates the wizard's Continue). */
  blocking: boolean;
  message: string;
  remediation?: string;
  /** Free-form extras: versions, machine name, freeBytes, image tag, … */
  detail?: Record<string, unknown>;
}

export interface PreflightReport {
  platform: NodeJS.Platform;
  /** No blocking failures — safe to proceed. */
  ok: boolean;
  /** At least one blocking check failed (Podman missing/errored). */
  blocked: boolean;
  checks: CheckResult[];
  generatedAt: string;
}

export interface PreflightDeps {
  /** SQLite db path; its dirname is the data dir used by the disk check. */
  dbPath: string;
  /** Override the shell (tests). Defaults to the local shell adapter. */
  shell?: IShellPort;
}
