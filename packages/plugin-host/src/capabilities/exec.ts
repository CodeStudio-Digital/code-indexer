/**
 * One-shot command capability. Spawns an allowlisted binary (no shell → no
 * injection), collects stdout+stderr, resolves { stdout, code } at exit. The
 * binary basename (and, for `npx`, the package basename) must be in the
 * plugin's granted `exec.allow`. Long-running / interactive commands (live
 * `tail`, `wrangler login`) use the UI streaming path, not this.
 *
 * Note: the CALLER resolves platform shims (e.g. `npx.cmd` on Windows); the
 * allowlist matches on basename so `npx` and `npx.cmd` are equivalent.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { PluginPermissions } from '@mcp/plugin-sdk';

export interface ExecResult {
  stdout: string;
  code: number | null;
}

/** A frame of a streamed command's output (live `wrangler tail`, `login`, …). */
export type ExecChunk =
  | { type: 'data'; data: string }
  | { type: 'exit'; code: number | null };

type ExecGrants = PluginPermissions['exec'];

interface ExecPayload {
  cmd?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/** Strip the binary basename of path + .cmd/.exe/.bat so the allowlist is platform-neutral. */
function baseName(cmd: string): string {
  return (cmd.split(/[/\\]/).pop() ?? cmd).replace(/\.(cmd|exe|bat|ps1)$/i, '');
}

/** Exported for unit tests: is `cmd args` permitted by the allowlist? */
export function isExecAllowed(cmd: string, args: string[], allow: string[] | undefined): boolean {
  if (!allow || allow.length === 0) return false;
  const base = baseName(cmd);
  if (!allow.includes(base)) return false;
  // `npx <pkg>` — the package itself must be allowlisted too.
  if (base === 'npx') {
    const pkg = args.find((a) => !a.startsWith('-'));
    return pkg ? allow.includes(baseName(pkg)) : false;
  }
  return true;
}

/** Drop the dev-only vars our parent injects so child processes behave normally. */
function cleanEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MCP_DEV_HTTP;
  delete env.MCP_ELECTRON_DEV_URL;
  return { ...env, ...(extra ?? {}) };
}

export async function handleExec(
  payload: unknown,
  cwd: string,
  grants: ExecGrants | undefined,
): Promise<ExecResult> {
  const { cmd, args = [], env, cwd: subCwd } = (payload ?? {}) as ExecPayload;
  if (!cmd || !isExecAllowed(cmd, args, grants?.allow)) {
    throw new Error(`permission_denied: exec not allowed: ${cmd ?? ''} ${args.join(' ')}`.trim());
  }
  const runCwd = resolve(cwd, subCwd ?? '.');
  return new Promise<ExecResult>((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd: runCwd, env: cleanEnv(env), shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      stdout += d;
    });
    child.stderr?.on('data', (d: string) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolvePromise({ stdout: stderr ? `${stdout}${stdout ? '\n' : ''}${stderr}` : stdout, code });
    });
  });
}

export interface ExecStreamOpts {
  cmd: string;
  args: string[];
  cwd: string;
  /** The plugin's granted exec allowlist — checked before spawning. */
  allow: string[] | undefined;
  env?: Record<string, string>;
  /** Abort to kill the child (e.g. the webview closed the tail panel). */
  signal?: AbortSignal;
}

/**
 * Stream an allowlisted command's stdout/stderr as it runs, yielding `data`
 * frames until the process exits (`exit` frame). For long-running / interactive
 * commands the one-shot `handleExec` can't serve — live `wrangler tail`,
 * `wrangler login`. Bridges the child's event emitter to an async iterator via
 * a queue+waiter; the `finally` kills the child if the consumer stops early.
 */
export async function* execStream(opts: ExecStreamOpts): AsyncGenerator<ExecChunk> {
  if (!isExecAllowed(opts.cmd, opts.args, opts.allow)) {
    throw new Error(
      `permission_denied: exec not allowed: ${opts.cmd} ${opts.args.join(' ')}`.trim(),
    );
  }
  opts.signal?.throwIfAborted();
  const child = spawn(opts.cmd, opts.args, {
    cwd: resolve(opts.cwd),
    env: cleanEnv(opts.env),
    shell: false,
  });

  // Bound pending output without discarding it. Pausing both pipes propagates
  // backpressure to the child when the UI/network consumer is slow. The pipe
  // buffers and one incoming chunk are additional to this queue's high mark.
  const maxBytes = 1024 * 1024;
  const maxFrames = 256;
  const queue: Array<{ chunk: ExecChunk; bytes: number } | undefined> = [];
  let head = 0;
  let queuedBytes = 0;
  let paused = false;
  let wake: (() => void) | null = null;
  let ended = false;
  const push = (c: ExecChunk): void => {
    const bytes = c.type === 'data' ? Buffer.byteLength(c.data, 'utf8') : 0;
    queue.push({ chunk: c, bytes });
    queuedBytes += bytes;
    if (!paused && !opts.signal?.aborted
      && (queuedBytes >= maxBytes || queue.length - head >= maxFrames)) {
      paused = true;
      child.stdout?.pause();
      child.stderr?.pause();
    }
    if (wake) {
      wake();
      wake = null;
    }
  };

  // StringDecoder inside setEncoding preserves UTF-8 across pipe boundaries.
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (data: string) => push({ type: 'data', data }));
  child.stderr?.on('data', (data: string) => push({ type: 'data', data }));
  child.on('error', (e) => push({ type: 'data', data: `${e.message}\n` }));
  child.on('close', (code) => {
    push({ type: 'exit', code });
    ended = true;
    if (wake) {
      wake();
      wake = null;
    }
  });

  const onAbort = (): void => {
    try {
      child.kill();
    } catch {
      /* already dead */
    }
    // A paused pipe (or an inherited pipe held by a descendant) can prevent
    // close from arriving. Retain queued output; stop collecting after abort.
    paused = false;
    child.stdout?.destroy();
    child.stderr?.destroy();
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      while (head < queue.length) {
        const frame = queue[head]!;
        queue[head++] = undefined;
        queuedBytes -= frame.bytes;
        if (head === queue.length) {
          queue.length = 0;
          head = 0;
        } else if (head >= maxFrames) {
          queue.splice(0, head);
          head = 0;
        }
        if (paused && queuedBytes <= maxBytes / 2 && queue.length - head <= maxFrames / 2) {
          paused = false;
          child.stdout?.resume();
          child.stderr?.resume();
        }
        yield frame.chunk;
      }
      if (ended) break;
      await new Promise<void>((r) => {
        wake = r;
      });
    }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    try {
      child.kill();
    } catch {
      /* already dead */
    }
    // No consumer remains to drain paused pipes on generator.return().
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
}
