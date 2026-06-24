/**
 * Cross-platform process-TREE kill. A plain `process.kill(pid)` (or
 * node-pty's `.kill()`) only signals the direct child — but the IDE's
 * terminals spawn grandchildren (a user's `npm run dev` → vite → esbuild,
 * or WinPTY's `winpty-agent.exe`). On a hard app quit those grandchildren
 * orphan and keep holding ports/CPU. This kills the whole subtree.
 *
 *   - win32: `taskkill /PID <pid> /T /F` — `/T` walks the child tree, `/F`
 *     forces. The only reliable way to reap a detached grandchild on Windows.
 *   - POSIX: signal the process GROUP (`kill(-pid)`) when the child was
 *     spawned `detached` (its own group leader); fall back to the single
 *     pid otherwise. SIGKILL — this is the last-resort force path.
 *
 * Best-effort and synchronous-capable (usable from a `process.on('exit')`
 * handler, where no async work can run). Never throws.
 */

import { spawnSync } from 'node:child_process';

export function killTree(pid: number | undefined | null): void {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return;
    }
    // POSIX: try the process group first (negative pid). Throws ESRCH if the
    // child wasn't a group leader — fall back to the single process.
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* taskkill missing / pid already reaped — best-effort */
  }
}
