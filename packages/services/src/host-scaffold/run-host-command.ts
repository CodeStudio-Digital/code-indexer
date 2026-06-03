/**
 * Streamed host child-process runner for the New Project wizard.
 *
 * Unlike `LocalProcessManager` (long-lived dev servers with port +
 * readiness probes) and `design-system/run-npm` (npm-only, buffered, no
 * abort), this runs an arbitrary CLI (`npm`, `npx`, `git`, `pnpm`) to
 * completion while streaming stdout/stderr to a callback, honours an
 * `AbortSignal`, enforces a timeout, and never throws on a non-zero exit —
 * it returns `{ ok: false, … }` so the orchestrator can emit a clean error.
 *
 * Windows quirk: `npm`/`npx`/`pnpm` are `.cmd` shims, so direct spawn
 * without a shell fails with ENOENT — we set `shell` on win32 (same trick
 * as `design-system/run-npm`).
 */
import { spawn } from 'node:child_process';

export interface RunHostCommandInput {
  program: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Streamed line/chunk callback. Called for both stdout and stderr. */
  onLog?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

export interface RunHostCommandResult {
  ok: boolean;
  exitCode: number;
  /** Last ~2 KB of stderr — surfaced to the user on failure. */
  stderrTail: string;
  /** Set when the failure is structural (ENOENT/abort/timeout), not exit code. */
  reason?: 'enoent' | 'aborted' | 'timeout' | 'spawn-error';
}

const TAIL_BYTES = 2_000;

/**
 * Build the child env, stripping dev-runner injection. The MCP backend
 * runs under a `tsx` loader in dev (`NODE_OPTIONS=--import tsx` / `--loader
 * tsx/esm`), which propagates to spawned children. A scaffold CLI like
 * `npm create vite` then re-spawns `node`, which tries to resolve the bare
 * `tsx` specifier from the NEW project directory and dies with
 * `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'`. External CLIs must run
 * with a clean Node, so we drop the injected loader and Electron-as-node
 * flag (we keep everything else, incl. PATH and our non-interactive vars).
 */
function childEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export function runHostCommand(input: RunHostCommandInput): Promise<RunHostCommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stderrTail = '';
    let reason: RunHostCommandResult['reason'];

    const finish = (r: RunHostCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };

    // Abort before spawn: bail immediately.
    if (input.signal?.aborted) {
      return finish({ ok: false, exitCode: -1, stderrTail: '', reason: 'aborted' });
    }

    const child = spawn(input.program, input.args, {
      cwd: input.cwd,
      env: childEnv(input.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      // On Windows the npm/npx/pnpm shims are `.cmd` files — need a shell.
      shell: process.platform === 'win32',
    });

    const onAbort = () => {
      reason = 'aborted';
      kill(child);
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      reason = 'timeout';
      kill(child);
    }, input.timeoutMs);

    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => input.onLog?.('stdout', chunk));
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-TAIL_BYTES);
      input.onLog?.('stderr', chunk);
    });

    child.on('error', (err) => {
      const raw = err instanceof Error ? err.message : String(err);
      const isEnoent = raw.includes('ENOENT');
      const hint = isEnoent
        ? ` — '${input.program}' was not found on PATH. Install it (or Node.js) and retry.`
        : '';
      finish({
        ok: false,
        exitCode: -1,
        stderrTail: (stderrTail + raw + hint).slice(-TAIL_BYTES),
        reason: isEnoent ? 'enoent' : 'spawn-error',
      });
    });

    child.on('close', (code) => {
      if (reason === 'aborted' || reason === 'timeout') {
        const note = reason === 'timeout' ? `Timed out after ${input.timeoutMs}ms` : 'Cancelled';
        return finish({ ok: false, exitCode: code ?? -1, stderrTail: `${note}\n${stderrTail}`.slice(-TAIL_BYTES), reason });
      }
      finish({ ok: code === 0, exitCode: code ?? -1, stderrTail });
    });
  });
}

/** SIGTERM then SIGKILL after a grace period. Windows maps SIGTERM to kill. */
function kill(child: ReturnType<typeof spawn>): void {
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, 3_000).unref?.();
}
