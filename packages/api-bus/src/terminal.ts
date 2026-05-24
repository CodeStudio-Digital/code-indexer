import type { ApiContext, AsyncStream } from './common.js';

/**
 * Embedded terminal — backed by node-pty. In the IDE workspace, the
 * BottomPanel mounts an xterm.js wrapper that pipes stdin/stdout via
 * this API. Streaming output is a MessagePort in Electron (substitutes
 * the legacy WebSocket /ws/terminal/:sessionId endpoint).
 *
 * Three targets supported:
 *  - `sandbox`: `podman exec` into the container of a company session
 *  - `host`:    operator's local shell (gated by MCP_HOST_TERMINAL_ENABLED=1)
 *  - `project`: NEW (Dia 10) — shell rooted at the project's root_path,
 *               for the IDE workspace's bottom-panel terminal
 */

export type TerminalTarget =
  | { kind: 'sandbox'; sessionId: number }
  | { kind: 'host' }
  | { kind: 'project'; projectId: number };

export interface TerminalSpawnInput {
  target: TerminalTarget;
  /** Terminal columns. Default 80. */
  cols?: number;
  /** Terminal rows. Default 24. */
  rows?: number;
  /** Shell override. Defaults: PowerShell on Windows, bash elsewhere. */
  shell?: string;
  /** Initial cwd override. Defaults to the target's natural root. */
  cwd?: string;
  /** Env vars merged on top of the inherited environment. */
  env?: Record<string, string>;
}

export interface TerminalSpawnResult {
  terminalId: string;
  pid: number;
  shell: string;
  cwd: string;
}

export type TerminalOutputChunk =
  | { type: 'data'; data: string }
  | { type: 'exit'; code: number | null; signal: string | null };

export interface TerminalApi {
  spawn(input: TerminalSpawnInput, ctx: ApiContext): Promise<TerminalSpawnResult>;

  /** Stream stdout/stderr from a spawned terminal until exit. */
  output(input: { terminalId: string }, ctx: ApiContext): AsyncStream<TerminalOutputChunk>;

  write(input: { terminalId: string; data: string }, ctx: ApiContext): Promise<void>;
  resize(input: { terminalId: string; cols: number; rows: number }, ctx: ApiContext): Promise<void>;
  kill(input: { terminalId: string; signal?: string }, ctx: ApiContext): Promise<void>;

  /**
   * Pre-flight diagnose — checks gating/feature flags BEFORE attempting to
   * spawn. Mirrors the legacy /api/terminal/diagnose endpoint. Returns
   * `{ ok: true }` or `{ ok: false, reason }` without throwing.
   */
  diagnose(input: { target: TerminalTarget }, ctx: ApiContext): Promise<{ ok: true } | { ok: false; reason: string }>;
}
