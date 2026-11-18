import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
import type { CoderWorktreeRemoval } from '@mcp/api-bus';
import { worktreeGit } from '@mcp/code-agent/tools/worktree-operations.js';
import { sharedPtyManager } from '@mcp/api-handlers/terminal/pty-manager.js';
import { peekCoderWorkerPool } from '../../../sse/coderWorkerPoolSingleton.js';
import type { ServerDeps } from '../../deps.js';
import { listProjectWorktrees, resolveProjectWorktree } from '../../worktree-reads.js';

interface RemovalRequest {
  project_id: number;
  path: string;
  head: string;
  branch: string | null;
  confirmed: true;
  discardChanges: boolean;
  deleteBranch: boolean;
}

export function validRemoval(value: unknown): value is RemovalRequest {
  if (!value || typeof value !== 'object') return false;
  const req = value as Partial<RemovalRequest>;
  return typeof req.project_id === 'number' && Number.isSafeInteger(req.project_id) && req.project_id > 0
    && req.confirmed === true && typeof req.path === 'string' && isAbsolute(req.path) && !req.path.includes('\0')
    && typeof req.head === 'string' && (req.branch === null || typeof req.branch === 'string')
    && typeof req.discardChanges === 'boolean' && typeof req.deleteBranch === 'boolean'
    && (!req.deleteBranch || !!req.branch);
}

export class WorktreeRemovalError extends Error {
  constructor(readonly code: 'changed' | 'protected' | 'busy' | 'activeChat' | 'terminal' | 'nested' | 'dirty' | 'unknown', message: string) {
    super(message);
  }
}

function pathKey(path: string) {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function containsPath(parent: string, child: string) {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}

const removing = new Set<string>();

async function deleteLocalBranch(root: string, branch: string, expectedHead: string): Promise<CoderWorktreeRemoval> {
  try {
    const tip = await worktreeGit(['rev-parse', '--verify', 'refs/heads/' + branch], root);
    if (!tip.ok || !expectedHead || tip.out !== expectedHead) {
      return { removed: true, branchDeleted: false, branchWarning: 'The local branch no longer points to the confirmed commit.' };
    }
    // Git also refuses branches in use by another checkout, rebase or bisect,
    // and removes the branch configuration and reflog on success.
    const result = await worktreeGit(['branch', '-D', '--', branch], root, {}, true);
    if (!result.ok) return { removed: true, branchDeleted: false, branchWarning: result.error };
    return { removed: true, branchDeleted: true };
  } catch (error) {
    return { removed: true, branchDeleted: false, branchWarning: error instanceof Error ? error.message : String(error) };
  }
}

export async function removeConfirmedWorktree(deps: ServerDeps, root: string, req: RemovalRequest, signal: AbortSignal): Promise<CoderWorktreeRemoval> {
  const key = pathKey(req.path);
  if (removing.has(key)) throw new WorktreeRemovalError('busy', 'Worktree removal already in progress');
  removing.add(key);
  try {
    const { worktrees } = await listProjectWorktrees(root, { signal });
    const item = worktrees.find(candidate => pathKey(candidate.path) === key);
    if (!item || item.head !== req.head || item.branch !== req.branch) {
      throw new WorktreeRemovalError('changed', 'The selected worktree changed or is no longer registered');
    }
    if (item.primary || item.repositoryMain || item.locked || key === pathKey(parse(key).root)) {
      throw new WorktreeRemovalError('protected', 'This checkout is protected against removal');
    }
    if (containsPath(key, await realpath(root)) || worktrees.some(other => other !== item && containsPath(key, other.path))) {
      throw new WorktreeRemovalError('nested', 'The selected directory contains another checkout');
    }
    if (item.prunable) {
      // Only forget an exact Git entry whose directory has actually disappeared.
      // A replacement directory (including a junction) belongs to someone else.
      const entry = await lstat(item.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (entry) throw new WorktreeRemovalError('changed', 'The original checkout directory has been replaced');
    } else {
      const livePath = await resolveProjectWorktree(root, item.path, { signal });
      if (!livePath || pathKey(livePath) !== key) throw new WorktreeRemovalError('changed', 'The checkout path has changed');
    }
    if (sharedPtyManager.listEntries().some(({ meta }) => meta?.kind !== 'ssh' && meta?.cwd && containsPath(key, meta.cwd))) {
      throw new WorktreeRemovalError('terminal', 'A terminal or runner is using this directory');
    }
    const pool = peekCoderWorkerPool();
    if (pool) {
      for (const { sessionId } of pool.snapshot()) {
        if (!pool.isRunning(sessionId)) continue;
        const session = await deps.sessionStore.getSession(sessionId);
        const checkout = session?.worktree_path || (session?.project_id != null && deps.db.getProjectCatalogEntry(session.project_id)?.root_path);
        if (checkout && containsPath(key, checkout)) {
          throw new WorktreeRemovalError('activeChat', 'A chat is running in this worktree');
        }
      }
    }
    signal.throwIfAborted();
    // Once the user-confirmed mutation starts, finish it even if the UI disconnects.
    // Never use a recursive filesystem fallback or prune other stale registrations.
    // Git's cleanliness check honors status.showUntrackedFiles. A user's
    // display preference must never implicitly authorize discarding files.
    const result = await worktreeGit(['-c', 'status.showUntrackedFiles=normal', 'worktree', 'remove',
      ...(req.discardChanges ? ['--force'] : []), '--', item.path], root, {}, true);
    if (!result.ok) {
      if (result.outcomeUnknown) throw new WorktreeRemovalError('unknown', result.error);
      if (!req.discardChanges && /modified|untracked|submodules|--force/i.test(result.error)) {
        throw new WorktreeRemovalError('dirty', result.error);
      }
      throw new Error(result.error);
    }
    if (req.deleteBranch && item.branch) return await deleteLocalBranch(root, item.branch, item.head);
    return { removed: true, branchDeleted: false };
  } finally {
    removing.delete(key);
  }
}
