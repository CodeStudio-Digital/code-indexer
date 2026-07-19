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
 * Best-effort and asynchronous on Windows so a suspended helper cannot block
 * Electron's main event loop. The exit-only synchronous batch lives in the
 * shared helper and is used by ChildProcessRegistry.killAllSync().
 */

import { killProcessTree } from '@mcp/shared/utils/process-tree.js';

/** @deprecated Prefer the shared helper directly outside Electron. */
export const killTree = killProcessTree;
