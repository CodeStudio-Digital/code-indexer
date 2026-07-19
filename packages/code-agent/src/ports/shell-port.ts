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

import { spawn, spawnSync } from 'node:child_process';
import { delimiter } from 'node:path';
import { trackProcessTree } from '@mcp/shared/utils/process-tree.js';

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
}

const DEFAULT_MAX_OUTPUT_BYTES = 100_000;
const OUTPUT_HEAD_RATIO = 0.55;

function omissionMarker(omittedBytes: number): Buffer {
  return Buffer.from(
    `\n[truncated: ${omittedBytes} bytes omitted; preserved beginning and true tail]\n`,
    'utf-8',
  );
}

function utf8SequenceLength(lead: number): number {
  if ((lead & 0x80) === 0) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 1;
}

/** Do not turn a byte-budget boundary into a Unicode replacement character. */
function utf8SafePrefix(source: Buffer, maxBytes: number): Buffer {
  let end = Math.min(source.length, Math.max(0, maxBytes));
  if (end === source.length || end === 0) return source.subarray(0, end);

  let lead = end - 1;
  while (lead >= 0 && (source[lead] & 0xc0) === 0x80) lead -= 1;
  if (lead < 0 || lead + utf8SequenceLength(source[lead]) > end) end = Math.max(0, lead);
  return source.subarray(0, end);
}

/** Skip leading continuation bytes when retaining a UTF-8 suffix. */
function utf8SafeSuffix(source: Buffer, maxBytes: number): Buffer {
  let start = Math.max(0, source.length - Math.max(0, maxBytes));
  while (start < source.length && (source[start] & 0xc0) === 0x80) start += 1;
  return source.subarray(start);
}

/**
 * Format already-bounded head/tail buffers inside `maxBytes`, including the
 * marker. `totalBytes` is the number of raw bytes observed from the process,
 * so the marker remains exact even though the omitted middle was never kept
 * in memory.
 */
function formatBoundedBuffers(
  head: Buffer,
  tail: Buffer,
  totalBytes: number,
  maxBytes: number,
): string {
  const limit = Math.max(0, Math.floor(maxBytes));
  if (limit === 0) return '';

  let omittedBytes = Math.max(1, totalBytes - limit);
  let marker = omissionMarker(omittedBytes);
  let headBytes = 0;
  let tailBytes = 0;
  let selectedHead: Buffer = Buffer.alloc(0);
  let selectedTail: Buffer = Buffer.alloc(0);

  // The marker's digit count affects the retained budget, and the retained
  // budget affects the omitted count. Iterate to the tiny fixed point.
  let stable = false;
  for (let i = 0; i < 32; i += 1) {
    if (marker.length >= limit) break;
    const available = Math.max(0, limit - marker.length);
    const desiredHead = Math.floor(available * OUTPUT_HEAD_RATIO);
    selectedHead = utf8SafePrefix(head, desiredHead);
    selectedTail = utf8SafeSuffix(tail, available - selectedHead.length);
    headBytes = selectedHead.length;
    tailBytes = selectedTail.length;

    const nextOmitted = Math.max(0, totalBytes - headBytes - tailBytes);
    if (nextOmitted === omittedBytes) {
      stable = true;
      break;
    }
    omittedBytes = nextOmitted;
    marker = omissionMarker(omittedBytes);
  }

  if (!stable || marker.length >= limit) {
    // Pathological tiny limits cannot fit the descriptive marker. Still keep
    // the allocation bounded and make truncation explicit.
    return Buffer.from(`[truncated:${totalBytes}B]`, 'utf-8')
      .subarray(0, limit)
      .toString('utf-8');
  }

  return Buffer.concat([
    selectedHead,
    marker,
    selectedTail,
  ]).toString('utf-8');
}

/**
 * Bound an already-materialized string without losing its true tail. This is
 * also used by the tool layer as a defensive fallback for remote shell
 * adapters that cannot stream through `LocalShellAdapter`.
 */
export function boundUtf8OutputDetailed(
  content: string,
  maxBytes = DEFAULT_MAX_OUTPUT_BYTES,
): { content: string; truncation?: { inputBytes: number; outputBytes: number } } {
  const source = Buffer.from(content, 'utf-8');
  if (source.length <= maxBytes) return { content };
  const bounded = formatBoundedBuffers(source, source, source.length, maxBytes);
  return {
    content: bounded,
    truncation: {
      inputBytes: source.length,
      outputBytes: Buffer.byteLength(bounded, 'utf-8'),
    },
  };
}

export function boundUtf8Output(content: string, maxBytes = DEFAULT_MAX_OUTPUT_BYTES): string {
  return boundUtf8OutputDetailed(content, maxBytes).content;
}

/** A memory-bounded process stream capture with exact omission accounting. */
class BoundedUtf8Capture {
  private readonly maxBytes: number;
  private readonly headCapacity: number;
  private readonly tailCapacity: number;
  private totalBytes = 0;
  private full: Buffer | null = Buffer.alloc(0);
  private head: Buffer = Buffer.alloc(0);
  private tail: Buffer = Buffer.alloc(0);

  constructor(maxBytes: number) {
    this.maxBytes = Math.max(0, Math.floor(maxBytes));
    this.headCapacity = Math.floor(this.maxBytes * OUTPUT_HEAD_RATIO);
    this.tailCapacity = this.maxBytes - this.headCapacity;
  }

  append(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf-8');
    if (bytes.length === 0) return;
    this.totalBytes += bytes.length;

    if (this.full !== null) {
      if (this.full.length + bytes.length <= this.maxBytes) {
        this.full = Buffer.concat([this.full, bytes]);
        return;
      }

      // Buffer.concat with an explicit shorter length copies only the prefix;
      // it does not allocate the potentially huge combined stream.
      this.head = Buffer.concat([this.full, bytes], this.headCapacity);
      this.tail = this.keepTail(this.full, bytes);
      this.full = null;
      return;
    }

    this.tail = this.keepTail(this.tail, bytes);
  }

  finish(): string {
    return this.finishDetailed().content;
  }

  finishDetailed(): {
    content: string;
    truncation?: { inputBytes: number; outputBytes: number };
  } {
    if (this.full !== null) return { content: this.full.toString('utf-8') };
    const content = formatBoundedBuffers(
      this.head,
      this.tail,
      this.totalBytes,
      this.maxBytes,
    );
    return {
      content,
      truncation: {
        inputBytes: this.totalBytes,
        outputBytes: Buffer.byteLength(content, 'utf-8'),
      },
    };
  }

  private keepTail(previous: Buffer, chunk: Buffer): Buffer {
    if (this.tailCapacity === 0) return Buffer.alloc(0);
    if (chunk.length >= this.tailCapacity) {
      return Buffer.from(chunk.subarray(chunk.length - this.tailCapacity));
    }
    const previousBytes = Math.min(previous.length, this.tailCapacity - chunk.length);
    return Buffer.concat([
      previous.subarray(previous.length - previousBytes),
      chunk,
    ]);
  }
}

export interface IShellPort {
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
function cleanProcessEnv(): NodeJS.ProcessEnv {
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
  exec(command: string, options: ShellExecOptions): Promise<ShellExecResult> {
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

      const timer = setTimeout(() => {
        timedOut = true;
        killed = true;
        // Timeout/abort is a hot background path. Kill through the existing
        // handle; the process-wide tracker performs the expensive tree sweep
        // only when the owning worker/application shuts down.
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      }, timeoutMs);

      const onAbort = () => {
        killed = true;
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      };
      signal?.addEventListener('abort', onAbort);

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
    const { cwd, env, encoding = 'utf-8' } = options;
    const r = spawnSync(program, args, { cwd, encoding, env: env ?? applyRuntimeEnv(cleanProcessEnv(), options.runtimeEnv) });
    if (r.error) {
      return {
        stdout: '',
        stderr: `${program} ${args.join(' ')} failed to spawn: ${r.error.message}`,
        exitCode: null,
        timedOut: false,
      };
    }
    return {
      stdout: (r.stdout as string | null) ?? '',
      stderr: (r.stderr as string | null) ?? '',
      exitCode: r.status,
      timedOut: false,
    };
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
