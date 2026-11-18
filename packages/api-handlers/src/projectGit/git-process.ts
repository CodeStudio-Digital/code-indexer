import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { GitRunResult } from '@mcp/api-bus';
import { killProcessTree } from '@mcp/shared/utils/process-tree.js';

export interface GitResult {
  code: number; stdout: string; stderr: string; durationMs?: number; processMs?: number;
  timedOut?: boolean; truncated?: boolean; errorCode?: GitRunResult['errorCode'];
}

export interface GitProcessInput {
  cwd: string; args: string[]; stdin?: string; env: NodeJS.ProcessEnv;
  timeoutMs: number; maxOutputBytes: number;
}

const active = new Map<ChildProcess, Promise<void>>();

/** Shared transport; the caller decides which realm may spawn this command. */
export function runGitProcess(input: GitProcessInput, onSpawn?: (pid: number) => void, signal?: AbortSignal): Promise<GitResult> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve({ code: -1, stdout: '', stderr: 'Git read timed out before dispatch', timedOut: true, errorCode: 'timeout' }); return; }
    const startedAt = Date.now();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('git', input.args, { cwd: input.cwd, env: input.env,
        stdio: 'pipe', windowsHide: true, detached: process.platform !== 'win32' });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error), errorCode: 'spawn_failed', durationMs: Date.now() - startedAt });
      return;
    }
    let closed!: () => void;
    active.set(child, new Promise<void>(done => { closed = done; }));
    let settled = false, timedOut = false, truncated = false, bytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killing: Promise<void> | null = null;
    let processError: Error | undefined;
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const finish = (result: GitResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      active.delete(child); closed();
      resolve({ ...result, durationMs: Date.now() - startedAt });
    };
    const kill = () => { killing ??= killProcessTree(child.pid, 'SIGKILL').then(() => {
      // A failed/busy tree helper must not leave even the direct child alive.
      try { child.kill('SIGKILL'); } catch { /* already closed */ }
    }); };
    const abort = () => { timedOut = true; kill(); };
    const collect = (target: Buffer[], chunk: Buffer) => {
      if (settled || truncated) return;
      bytes += chunk.length;
      if (input.maxOutputBytes > 0 && bytes > input.maxOutputBytes) { truncated = true; kill(); return; }
      target.push(chunk);
    };
    child.stdout.on('data', chunk => collect(stdout, chunk));
    child.stderr.on('data', chunk => collect(stderr, chunk));
    child.stdin.on('error', () => { /* early Git exit is reported by close */ });
    child.on('error', error => {
      // Kill errors can occur after a successful spawn. A live PID remains
      // owned until close; only a failed spawn without a PID can finish here.
      if (child.pid) processError = error;
      else finish({ code: -1, stdout: '', stderr: error.message, errorCode: 'spawn_failed' });
    });
    child.once('close', async code => {
      // A cap/timeout receipt must not race a still-running tree-kill helper.
      if (killing) await killing;
      if (timedOut) return finish({ code: -1, stdout: '', stderr: `git ${input.args[0] ?? ''} timed out after ${input.timeoutMs}ms`, timedOut: true, errorCode: 'timeout' });
      if (truncated) return finish({ code: -1, stdout: '', stderr: `git output exceeded ${input.maxOutputBytes} bytes`, truncated: true, errorCode: 'output_too_large' });
      if (processError) return finish({ code: -1, stdout: '', stderr: processError.message, errorCode: 'git_failed' });
      finish({ code: code ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
        ...(code === 0 ? {} : { errorCode: 'git_failed' as const }) });
    });
    if (child.pid) onSpawn?.(child.pid);
    signal?.addEventListener('abort', abort, { once: true });
    if (input.timeoutMs > 0) timer = setTimeout(() => { timedOut = true; kill(); }, input.timeoutMs);
    child.stdin.end(input.stdin);
  });
}

/** Await both tree termination and the child's close event before releasing its owner. */
export async function disposeGitProcesses(): Promise<void> {
  const snapshot = [...active];
  await Promise.all(snapshot.map(async ([child, closed]) => {
    await killProcessTree(child.pid, 'SIGKILL');
    try { child.kill('SIGKILL'); } catch { /* already closed */ }
    await closed;
  }));
}
