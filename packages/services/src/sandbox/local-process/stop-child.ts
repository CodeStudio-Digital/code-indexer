import type { ChildProcess } from 'node:child_process';
import { killProcessTree } from '@mcp/shared/utils/process-tree.js';

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      child.off('exit', finish);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', finish);
      resolve(false);
    }, timeoutMs);
    child.once('exit', finish);
  });
}

/** Keep the process handle until termination is observed, including taskkill fallback. */
export async function stopLocalChild(child: ChildProcess): Promise<void> {
  if (hasExited(child)) return;
  const gracefulExit = waitForExit(child, 5_000);
  void killProcessTree(child.pid, 'SIGTERM');
  if (await gracefulExit) return;

  await killProcessTree(child.pid, 'SIGKILL');
  // Windows tree cleanup is best-effort and may open its circuit breaker.
  // The owned child handle remains safe to terminate even when that helper fails.
  if (!hasExited(child)) child.kill('SIGKILL');
  if (!await waitForExit(child, 2_000)) {
    throw new Error(`Local process ${child.pid} did not exit after termination`);
  }
}
