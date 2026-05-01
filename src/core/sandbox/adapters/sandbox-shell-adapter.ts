/**
 * Adapter presenting an `IShellPort` to coder tools, backed by an
 * `ISandboxDriver.exec` / `run` against a specific container.
 *
 * The tool layer sees the same streaming/truncated result shape; the
 * truncation and timeout policy is enforced by the driver (or the
 * underlying shell port the driver itself is using), so behavior is
 * consistent with the local adapter.
 */

import type {
  IShellPort,
  ShellExecOptions,
  ShellExecResult,
  ShellRunOptions,
} from '../../coder/ports/shell-port.js';
import type { ISandboxDriver } from '../ports/sandbox-driver.js';

export interface SandboxShellAdapterOptions {
  driver: ISandboxDriver;
  containerId: string;
  /**
   * Default workdir for `exec` when the caller doesn't supply one.
   * Usually the sandbox's `/app`.
   */
  defaultCwd: string;
}

export class SandboxShellAdapter implements IShellPort {
  private readonly driver: ISandboxDriver;
  private readonly containerId: string;
  private readonly defaultCwd: string;

  constructor(options: SandboxShellAdapterOptions) {
    this.driver = options.driver;
    this.containerId = options.containerId;
    this.defaultCwd = options.defaultCwd;
  }

  async exec(command: string, options: ShellExecOptions): Promise<ShellExecResult> {
    // The caller's `options.cwd` is host-side when the session is local.
    // In builder mode, the runCoder `toolContext.cwd` is pinned to the
    // container workdir, so the cwd here is already container-valid.
    const r = await this.driver.exec(this.containerId, command, {
      cwd: options.cwd || this.defaultCwd,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      maxOutputBytes: options.maxOutputBytes,
      env: options.env as Record<string, string> | undefined,
      stdin: options.stdin,
    });
    return r;
  }

  async run(program: string, args: string[], options: ShellRunOptions): Promise<ShellExecResult> {
    // `run` has no caller-supplied timeout (mirrors `git_*` local spawnSync
    // semantics). Driver-level `run` now routes through async streaming
    // on the host, so long git operations no longer block the host loop.
    const r = await this.driver.run(this.containerId, program, args, {
      cwd: options.cwd || this.defaultCwd,
      timeoutMs: 120_000,
      env: options.env as Record<string, string> | undefined,
    });
    return r;
  }

  async spawn(
    program: string,
    args: string[],
    options: ShellExecOptions,
  ): Promise<ShellExecResult> {
    // Argv-based streaming invocation inside the container. Shares the
    // driver's `run` plumbing (argv, no shell) but forwards the caller's
    // timeout / abort / maxOutputBytes.
    return await this.driver.run(this.containerId, program, args, {
      cwd: options.cwd || this.defaultCwd,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      maxOutputBytes: options.maxOutputBytes,
      env: options.env as Record<string, string> | undefined,
    });
  }
}
