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
  /** Override env. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface RunNpmResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function runNpm(input: RunNpmInput): Promise<RunNpmResult> {
  return new Promise((resolve) => {
    const child = spawn('npm', input.args, {
      cwd: input.cwd,
      env: input.env ?? process.env,
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
