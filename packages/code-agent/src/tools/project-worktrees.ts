import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CoderWorktree, CoderWorktrees } from '@mcp/api-bus';
import { worktreeGit, type WorktreeExecution } from './worktree-operations.js';

export interface WorktreeReadOptions extends WorktreeExecution {
  readGit?: typeof worktreeGit;
}

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

/** -z avoids Git's quoting of spaces, accents, tabs and Windows paths. */
export function parseWorktrees(output: string, primaryPath: string): CoderWorktree[] {
  return output.split('\0\0').flatMap((record, index) => {
    const fields = record.split('\0');
    const path = fields.find((field) => field.startsWith('worktree '))?.slice(9);
    if (!path || fields.includes('bare')) return [];
    return [{
      path,
      head: fields.find((field) => field.startsWith('HEAD '))?.slice(5) ?? '',
      branch: fields.find((field) => field.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') ?? null,
      primary: pathKey(path) === pathKey(primaryPath),
      ...(index === 0 ? { repositoryMain: true } : {}),
      locked: fields.some((field) => field === 'locked' || field.startsWith('locked ')),
      prunable: fields.some((field) => field === 'prunable' || field.startsWith('prunable ')),
    }];
  });
}

async function readInventory(projectRoot: string, execution: WorktreeReadOptions): Promise<{ inventory: CoderWorktrees; commonDir?: string }> {
  const read = execution.readGit ?? worktreeGit;
  const root = await realpath(projectRoot);
  const listed = await read(['worktree', 'list', '--porcelain', '-z'], root, execution);
  if (!listed.ok) {
    if (/not a git repository/i.test(listed.error)) return { inventory: { isGit: false, worktrees: [] } };
    throw new Error(listed.error);
  }
  const worktrees = parseWorktrees(listed.out, root);
  if (worktrees.some(item => item.primary)) return { inventory: { isGit: true, worktrees } };
  // A project can also point at a subdirectory of any checkout.
  const location = await read(['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], root, execution);
  if (!location.ok) throw new Error(location.error);
  const [top, gitDir, commonDir] = location.out.split(/\r?\n/);
  if (!top || !gitDir || !commonDir) throw new Error('Git could not identify this checkout');
  // Git can report the administrative directory as the main worktree of an
  // absorbed submodule. Its rev-parse toplevel is the actual workspace.
  const mainGitDir = pathKey(gitDir) === pathKey(commonDir) ? pathKey(commonDir) : null;
  for (const item of worktrees) {
    if (pathKey(item.path) === mainGitDir) item.path = top;
    item.primary = pathKey(item.path) === pathKey(top);
  }
  return { inventory: { isGit: true, worktrees }, commonDir };
}

export async function listProjectWorktrees(projectRoot: string, execution: WorktreeReadOptions = {}): Promise<CoderWorktrees> {
  return (await readInventory(projectRoot, execution)).inventory;
}

/** A client may select only a live checkout registered with this repository. */
export async function resolveProjectWorktree(projectRoot: string, requested: unknown, execution: WorktreeReadOptions = {}): Promise<string | null> {
  if (requested == null) return null;
  if (typeof requested !== 'string' || !requested.trim()) throw new Error('worktree_path must be a non-empty path');
  const actual = await realpath(requested);
  const { inventory, commonDir: knownCommonDir } = await readInventory(projectRoot, execution);
  const candidate = inventory.worktrees.find((item) => pathKey(item.path) === pathKey(actual));
  if (!candidate || candidate.prunable) throw new Error('Worktree is unavailable or does not belong to this project');
  const read = execution.readGit ?? worktreeGit;
  const commonArgs = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
  const [projectGit, checkoutGit] = await Promise.all([
    knownCommonDir ? { ok: true as const, out: knownCommonDir } : read(commonArgs, projectRoot, execution),
    read([...commonArgs, '--show-toplevel'], actual, execution),
  ]);
  const [commonDir, checkoutRoot] = checkoutGit.ok ? checkoutGit.out.split(/\r?\n/) : [];
  if (!projectGit.ok || !commonDir || !checkoutRoot
    || pathKey(await realpath(projectGit.out)) !== pathKey(await realpath(commonDir))
    || pathKey(await realpath(checkoutRoot)) !== pathKey(actual)) {
    throw new Error('Worktree no longer belongs to this repository');
  }
  return candidate.primary ? null : actual;
}

/** Older agent-entered worktrees recorded snapshot paths relative to main.
 * UI-bound sessions use checkout-relative paths for the whole run. */
export async function resolveSessionWorkspaceRoot(projectRoot: string, session: {
  worktree_path?: string | null;
  metadata?: Readonly<Record<string, unknown>>;
}, execution: WorktreeReadOptions = {}): Promise<string> {
  if (!session.worktree_path || session.metadata?.worktree_workspace !== true) return projectRoot;
  return await resolveProjectWorktree(projectRoot, session.worktree_path, execution) ?? projectRoot;
}
