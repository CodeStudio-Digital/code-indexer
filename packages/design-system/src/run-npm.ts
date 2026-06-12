/**
 * Shared `npm` runner used by Design System tooling.
 *
 * Both `verdaccio-service.publishTarball` and the Design System
 * `ds_publish_version` tool need to spawn `npm` from the host process.
 * Centralising the spawn boilerplate (Windows `shell: true` quirk,
 * timeout SIGKILL, stdout/stderr capture) keeps both call sites honest
 * to the same behaviour.
 *
 * Pure-ish: returns `{ ok, exitCode, stdout, stderr }` and never throws —
 * callers decide how to react to a failure.
 */
import { spawn } from 'node:child_process';

export interface RunNpmInput {
  args: string[];
  cwd: string;
  timeoutMs: number;
  /** Extra/override env vars, merged over a cleaned `process.env`
   *  (see `cleanNpmEnv` — dev-runner injection is always stripped). */
  env?: NodeJS.ProcessEnv;
}

export interface RunNpmResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Child env with the dev-runner injection stripped. The MCP backend runs
 * under a `tsx` loader in dev (`NODE_OPTIONS=--import tsx`); npm is itself
 * Node, so an inherited NODE_OPTIONS makes it resolve the bare `tsx`
 * specifier from the CHILD's cwd (the package dir / npm's temp scripts) and
 * die with ERR_MODULE_NOT_FOUND before doing anything. That broke every
 * `ds_publish_version` (npm pack AND the Verdaccio npm publish) in dev —
 * session 979 failed 4 publishes in a row on it. Same strip as
 * host-scaffold/run-host-command `childEnv` and exec-command `cleanEnv`.
 */
export function cleanNpmEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export function runNpm(input: RunNpmInput): Promise<RunNpmResult> {
  return new Promise((resolve) => {
    const child = spawn('npm', input.args, {
      cwd: input.cwd,
      env: cleanNpmEnv(input.env),
      // On Windows `npm` is a `.cmd` shim — direct spawn without `shell` fails.
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* swallow */ }
    }, input.timeoutMs);
    child.stdout?.on('data', (b: Buffer) => { stdout += b.toString(); });
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, exitCode: code ?? -1, stdout, stderr });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: -1, stdout, stderr: String(e) });
    });
  });
}
