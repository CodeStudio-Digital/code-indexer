import { DEFAULT_MAX_OUTPUT_BYTES, BoundedUtf8Capture } from './shell-output.js';
export { formatBoundedBuffers, boundUtf8OutputDetailed, boundUtf8Output, BoundedUtf8Capture } from './shell-output.js';
/**
 * Shell port — abstracts away process execution used by coder tools
 * (`run_command`, `git_*`).
 *
 * Motivation: same as the filesystem port. `run_command` today calls
 * `child_process.spawn` with a platform-specific shell, streams stdout/
 * stderr with truncation, handles timeouts and abort signals. `git.ts`
 * calls `spawnSync` for synchronous inspection commands. In builder mode
 * we need to redirect all of that to a container `exec`, without
 * bifurcating every tool.
 *
 * Design:
 *   - Two methods: `exec` (shell-parsed command string) and `run`
 *     (direct argv, no shell). This mirrors the two distinct ways tools
 *     invoke subprocesses today and preserves their semantics:
 *       * `exec` → `run_command`: user-provided command line, shell does
 *         metachar parsing (redirection, globbing, quoting). Risks RCE,
 *         which is why there's a plan-mode allowlist in the tool layer.
 *       * `run`  → `git_*`: structured argv built from validated inputs,
 *         no shell interpretation, no surprises with paths containing
 *         spaces or special characters.
 *   - The port owns NOTHING about the command's caller context (cwd is
 *     an input). It handles streaming, truncation, timeout and abort —
 *     behavior that must be identical across Local and Sandbox.
 *   - The return shape is a unified `ShellExecResult` so callers have
 *     one thing to inspect regardless of how the process was launched.
 *
 * Invariants preserved from the pre-refactor shell.ts:
 *   - stdout/stderr accumulated in bounded UTF-8 buffers capped at
 *     `maxOutputBytes` (default 100 000). Oversized streams preserve both
 *     their beginning and their TRUE final bytes, with an inline marker that
 *     reports the exact number of source bytes omitted.
 *   - `SIGKILL` on timeout or abort, `timedOut` flag set.
 *   - `exitCode` is `null` when the process was killed (never code 0/1).
 */

import { spawn } from 'node:child_process';
import { delimiter } from 'node:path';
import { killProcessTree, trackProcessTree } from '@mcp/shared/utils/process-tree.js';

/**
 * Per-project runtime PATH/env to inject into agent-spawned processes — the
 * project's chosen PHP/Python (and future runtimes), resolved by the HOST and
 * passed down (the agent can't import the resolver without a dep cycle). Node
 * is deliberately excluded upstream.
 */
export interface AgentRuntimeEnv {
  pathPrepend: string[];
  extraEnv: Record<string, string>;
}

/**
 * Merge a runtime env into a base env: prepend its bin dirs to PATH (highest
 * priority first) and add its extra vars (e.g. PHPRC). Windows env keys may be
 * `Path`; normalise to `PATH`. No-op when `runtimeEnv` is undefined/empty.
 */
export function applyRuntimeEnv(
  base: NodeJS.ProcessEnv,
  runtimeEnv?: AgentRuntimeEnv,
): NodeJS.ProcessEnv {
  if (!runtimeEnv) return base;
  const env: NodeJS.ProcessEnv = { ...base, ...runtimeEnv.extraEnv };
  const prepend = (runtimeEnv.pathPrepend ?? []).filter(Boolean);
  if (prepend.length > 0) {
    const prev = env.PATH ?? env.Path ?? '';
    delete env.Path;
    env.PATH = `${prepend.join(delimiter)}${delimiter}${prev}`;
  }
  return env;
}

export interface ShellExecResult {
  stdout: string;
  stderr: string;
  /** `null` when the process was killed (timeout or abort). */
  exitCode: number | null;
  timedOut: boolean;
  /** Present only when the streaming capture omitted source bytes. */
  stdoutTruncation?: { inputBytes: number; outputBytes: number };
  stderrTruncation?: { inputBytes: number; outputBytes: number };
}

export interface ShellExecOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Max bytes captured per stream. Defaults to 100 000. */
  maxOutputBytes?: number;
  /** Optional env override. Defaults to `process.env` in the local adapter. */
  env?: NodeJS.ProcessEnv;
  /** Per-project runtime to inject (PHP/Python bin dirs + PHPRC). Ignored when `env` is set. */
  runtimeEnv?: AgentRuntimeEnv;
  /**
   * Optional payload written to the child's stdin before the stream is
   * closed. Use this to feed multi-line code to interpreters (e.g.
   * `python -`) instead of embedding it via shell quoting — quoting
   * rules differ between cmd / bash / PowerShell / sh-in-container, and
   * stdin works uniformly across all of them.
   *
   * EPIPE on commands that don't read stdin is swallowed: writing then
   * `end()`ing into a closed stdin is a no-op, not a failure.
   */
  stdin?: string;
}

export interface ShellRunOptions {
  cwd: string;
  /** Optional env override. Defaults to `process.env` in the local adapter. */
  env?: NodeJS.ProcessEnv;
  /** Per-project runtime to inject (PHP/Python bin dirs + PHPRC). Ignored when `env` is set. */
  runtimeEnv?: AgentRuntimeEnv;
  /** Encoding for stdout/stderr. Defaults to `'utf-8'`. */
  encoding?: BufferEncoding;
  /** Abort/fence signal — the owned process tree is killed when it fires. */
  signal?: AbortSignal;
  /** Optional process deadline. Defaults to ten minutes for argv tools. */
  timeoutMs?: number;
  /** Max bytes captured per stream. Defaults to 100 000. */
  maxOutputBytes?: number;
}

export interface IShellPort {
  /**
   * True when invocation enters the physical spawn boundary without an
   * intervening await and the adapter honors the supplied abort signal.
   */
  readonly mutationFenceAttested?: true;

  /**
   * Execute `command` through a shell (Windows: default cmd; POSIX:
   * `/bin/bash`). Streams stdout/stderr with per-stream byte cap,
   * honors `timeoutMs` and `signal` via SIGKILL.
   */
  exec(command: string, options: ShellExecOptions): Promise<ShellExecResult>;

  /**
   * Spawn `program` with `args` directly — NO shell parsing. Synchronous
   * semantics modeled after `child_process.spawnSync` but returned as a
   * Promise to keep the port uniformly async. Used by `git_*` tools.
   */
  run(program: string, args: string[], options: ShellRunOptions): Promise<ShellExecResult>;

  /**
   * Async argv-based spawn — same streaming/truncation/timeout/abort
   * semantics as `exec`, but without a shell wrapper. Used for long-
   * running host invocations (notably `docker exec …`) where we need
   * the event loop to keep turning and must pass argv through intact.
   */
  spawn(
    program: string,
    args: string[],
    options: ShellExecOptions,
  ): Promise<ShellExecResult>;
}

/**
 * Strip dev-only env vars from `process.env` before handing it to a
 * spawned process. Without this, the parent process's NODE_OPTIONS
 * (`--import tsx/esm` in our dev mode) leaks into every shelled-out
 * command — `npm run dev` / `node script.js` in the user's project
 * then crashes with ERR_MODULE_NOT_FOUND 'tsx' because their
 * node_modules doesn't have tsx. Same with ELECTRON_RUN_AS_NODE
 * (flags electron.exe as Node interpreter — only valid for our own
 * subprocesses like the MCP bridge, never for user code).
 */
export function cleanProcessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MCP_DEV_HTTP;
  delete env.MCP_ELECTRON_DEV_URL;
  return env;
}

/**
 * Default implementation: delegates to `child_process.spawn` / `spawnSync`.
 * Behavior MUST be identical to the pre-refactor `runCommand()` in shell.ts
 * and `git()` helper in git.ts.
 */
export class LocalShellAdapter implements IShellPort {
  readonly mutationFenceAttested = true as const;

  exec(command: string, options: ShellExecOptions): Promise<ShellExecResult> {
    if (options.signal?.aborted) {
      return Promise.resolve({ stdout: '', stderr: '', exitCode: null, timedOut: false });
    }
    const { cwd, env } = options;
    const isWin = process.platform === 'win32';
    const child = spawn(command, {
      cwd,
      shell: isWin ? true : '/bin/bash',
      env: env ?? applyRuntimeEnv(cleanProcessEnv(), options.runtimeEnv),
      detached: !isWin,
      windowsHide: true,
    });
    const untrack = trackProcessTree(child.pid);
    writeStdin(child, options.stdin);
    return this.collectStreaming(child, options, untrack);
  }

  spawn(
    program: string,
    args: string[],
    options: ShellExecOptions,
  ): Promise<ShellExecResult> {
    if (options.signal?.aborted) {
      return Promise.resolve({ stdout: '', stderr: '', exitCode: null, timedOut: false });
    }
    const { cwd, env } = options;
    const child = spawn(program, args, {
      cwd,
      env: env ?? applyRuntimeEnv(cleanProcessEnv(), options.runtimeEnv),
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    const untrack = trackProcessTree(child.pid);
    writeStdin(child, options.stdin);
    return this.collectStreaming(child, options, untrack);
  }

  private collectStreaming(
    child: ReturnType<typeof spawn>,
    options: ShellExecOptions,
    untrack: () => void,
  ): Promise<ShellExecResult> {
    const { timeoutMs, signal } = options;
    const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    return new Promise((resolvePromise) => {
      const stdout = new BoundedUtf8Capture(maxBytes);
      const stderr = new BoundedUtf8Capture(maxBytes);
      let timedOut = false;
      let killed = false;
      const terminateOwnedTree = (): void => {
        void killProcessTree(child.pid, 'SIGKILL').finally(() => {
          // Fallback when taskkill is unavailable or its bounded circuit is
          // open. The tree helper runs first so Windows can still discover
          // descendants before the direct shell handle disappears.
          try { child.kill('SIGKILL'); } catch { /* already exited */ }
        });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killed = true;
        // `run_command` uses a shell. Killing only that direct handle leaves
        // descendants such as Unity.exe alive and holding the project lock.
        // The shared helper serializes/bounds taskkill on Windows.
        terminateOwnedTree();
      }, timeoutMs);

      const onAbort = () => {
        killed = true;
        terminateOwnedTree();
      };
      signal?.addEventListener('abort', onAbort);
      if (signal?.aborted) onAbort();

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout.append(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr.append(chunk);
      });
      child.on('close', (code) => {
        untrack();
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const stdoutResult = stdout.finishDetailed();
        const stderrResult = stderr.finishDetailed();
        resolvePromise({
          stdout: stdoutResult.content,
          stderr: stderrResult.content,
          exitCode: killed ? null : code,
          timedOut,
          ...(stdoutResult.truncation ? { stdoutTruncation: stdoutResult.truncation } : {}),
          ...(stderrResult.truncation ? { stderrTruncation: stderrResult.truncation } : {}),
        });
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        stderr.append(e instanceof Error ? e.message : String(e));
        const stdoutResult = stdout.finishDetailed();
        const stderrResult = stderr.finishDetailed();
        resolvePromise({
          stdout: stdoutResult.content,
          stderr: stderrResult.content,
          exitCode: null,
          timedOut,
          ...(stdoutResult.truncation ? { stdoutTruncation: stdoutResult.truncation } : {}),
          ...(stderrResult.truncation ? { stderrTruncation: stderrResult.truncation } : {}),
        });
      });
    });
  }

  async run(program: string, args: string[], options: ShellRunOptions): Promise<ShellExecResult> {
    if (options.signal?.aborted) {
      return { stdout: '', stderr: '', exitCode: null, timedOut: false };
    }
    return this.spawn(program, args, {
      cwd: options.cwd,
      env: options.env,
      runtimeEnv: options.runtimeEnv,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 10 * 60_000,
      maxOutputBytes: options.maxOutputBytes,
    });
  }
}

/**
 * Feed `payload` into the child's stdin and close it. EPIPE on `write`
 * happens when the child exits before reading (e.g. `echo hi` ignores
 * stdin) — it's harmless, swallow it. The `end()` call signals EOF so
 * interpreters running `python -` / `node -` know the script is done.
 */
function writeStdin(child: ReturnType<typeof spawn>, payload: string | undefined): void {
  if (payload === undefined) return;
  if (!child.stdin) return;
  child.stdin.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') return;
  });
  child.stdin.end(payload);
}

let defaultShell: IShellPort | null = null;
export function defaultLocalShellPort(): IShellPort {
  if (!defaultShell) defaultShell = new LocalShellAdapter();
  return defaultShell;
}
