/**
 * Carries out an approved kill.
 *
 * Prefers the owning manager over a blind tree kill wherever one exists: a PTY
 * shut down through `PtyManager.kill()` emits its exit chunk, releases its
 * replay buffer and unregisters, whereas taskkill-ing the same pid leaves the
 * manager holding a corpse. The tree kill is the fallback for everything with
 * no owner — LSP servers, git, build helpers, terminal grandchildren.
 *
 * Only call this after `evaluateKill` has approved the pid.
 */
import { sharedPtyManager } from '@mcp/api-handlers';
import { tryGetLocalProcessManager } from '@mcp/services/sandbox/local-process/LocalProcessManager.js';
import { killProcessTree } from '@mcp/shared/utils/process-tree.js';
import type { ProcessInventoryEntry } from '../process-inventory.js';

export type KillMode = 'graceful' | 'force';
type KillMethod = 'owner' | 'tree';

export async function executeKill(
  pid: number,
  mode: KillMode,
  owner: ProcessInventoryEntry | undefined,
): Promise<KillMethod> {
  const signal = mode === 'force' ? 'SIGKILL' : 'SIGTERM';

  if (owner?.ownerKind === 'pty' && owner.ownerId) {
    try {
      // Already tree-first internally, so grandchildren die with the shell.
      sharedPtyManager.kill(owner.ownerId, signal);
      return 'owner';
    } catch {
      /* entry vanished between snapshot and kill — fall through */
    }
  }

  if (owner?.ownerKind === 'local-process' && owner.ownerId) {
    const manager = tryGetLocalProcessManager();
    if (manager) {
      try {
        await manager.stop(owner.ownerId, 'task-manager');
        return 'owner';
      } catch {
        /* fall through to the tree kill */
      }
    }
  }

  // MCP stdio servers deliberately take this path: closing them through the
  // pool is a lifecycle operation that would reconnect them, which is not what
  // "end task" means.
  await killProcessTree(pid, signal);
  return 'tree';
}
