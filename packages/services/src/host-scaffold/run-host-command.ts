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
 * Grace window after the child's `'exit'` to let stdout/stderr finish
 * draining before we settle on the exit fallback. On Windows a child can
 * exit while an inherited stdio pipe stays open, so `'close'` never fires —
 * relying on `'close'` alone (the old behaviour) hung the promise forever,
 * even past the timeout, freezing the New Project wizard on its spinner. We
 * settle on `'exit'` too, but wait briefly so the log tail isn't truncated.
 */
export const EXIT_DRAIN_MS = 250;

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

export function runHostCommand(
  input: RunHostCommandInput,
  // Seam for tests: inject a fake child so the exit/close fallback is
  // exercisable without spawning a real process. Defaults to node's `spawn`.
  spawnFn: typeof spawn = spawn,
): Promise<RunHostCommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stderrTail = '';
    let reason: RunHostCommandResult['reason'];
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (r: RunHostCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      input.signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };

    // Build the terminal result from the exit code, preserving an abort/
    // timeout note. Called by BOTH the `'close'` handler (preferred — full
    // stdio drain) and the `'exit'` fallback; the `settled` guard makes the
    // second caller a no-op.
    const settle = (code: number | null) => {
      if (reason === 'aborted' || reason === 'timeout') {
        const note = reason === 'timeout' ? `Timed out after ${input.timeoutMs}ms` : 'Cancelled';
        return finish({ ok: false, exitCode: code ?? -1, stderrTail: `${note}\n${stderrTail}`.slice(-TAIL_BYTES), reason });
      }
      finish({ ok: code === 0, exitCode: code ?? -1, stderrTail });
    };

    // Abort before spawn: bail immediately.
    if (input.signal?.aborted) {
      return finish({ ok: false, exitCode: -1, stderrTail: '', reason: 'aborted' });
    }

    const child = spawnFn(input.program, input.args, {
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

    // Preferred terminal signal: fires once the process exited AND all stdio
    // pipes closed (full log drain).
    child.on('close', (code) => settle(code));

    // Fallback: the process terminated but an inherited stdio pipe may stay
    // open (Windows), so `'close'` can never fire. Settle after a brief drain
    // window; a later (or never-arriving) `'close'` is a no-op via `settled`.
    // This also makes the timeout/abort `kill()` path reliably resolve.
    child.on('exit', (code) => {
      graceTimer = setTimeout(() => settle(code), EXIT_DRAIN_MS);
      graceTimer.unref?.();
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
