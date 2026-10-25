import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CoderWorktree, CoderWorktrees } from '@mcp/api-bus';
import { worktreeGit, type WorktreeExecution } from './worktree-operations.js';

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

/** -z avoids Git's quoting of spaces, accents, tabs and Windows paths. */
export function parseWorktrees(output: string, primaryPath: string): CoderWorktree[] {
  return output.split('\0\0').flatMap((record) => {
    const fields = record.split('\0');
    const path = fields.find((field) => field.startsWith('worktree '))?.slice(9);
    if (!path || fields.includes('bare')) return [];
    return [{
      path,
      head: fields.find((field) => field.startsWith('HEAD '))?.slice(5) ?? '',
      branch: fields.find((field) => field.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') ?? null,
      primary: pathKey(path) === pathKey(primaryPath),
      locked: fields.some((field) => field === 'locked' || field.startsWith('locked ')),
      prunable: fields.some((field) => field === 'prunable' || field.startsWith('prunable ')),
    }];
  });
}

export async function listProjectWorktrees(projectRoot: string, execution: WorktreeExecution = {}): Promise<CoderWorktrees> {
  const root = await realpath(projectRoot);
  const top = await worktreeGit(['rev-parse', '--show-toplevel'], root, execution);
  if (!top.ok) {
    if (/not a git repository/i.test(top.error)) return { isGit: false, worktrees: [] };
    throw new Error(top.error);
  }
  const listed = await worktreeGit(['worktree', 'list', '--porcelain', '-z'], root, execution);
  if (!listed.ok) throw new Error(listed.error);
  return { isGit: true, worktrees: parseWorktrees(listed.out, top.out) };
}

/** A client may select only a live checkout registered with this repository. */
export async function resolveProjectWorktree(projectRoot: string, requested: unknown): Promise<string | null> {
  if (requested == null) return null;
  if (typeof requested !== 'string' || !requested.trim()) throw new Error('worktree_path must be a non-empty path');
  const actual = await realpath(requested);
  const inventory = await listProjectWorktrees(projectRoot);
  const candidate = inventory.worktrees.find((item) => pathKey(item.path) === pathKey(actual));
  if (!candidate || candidate.prunable) throw new Error('Worktree is unavailable or does not belong to this project');
  const commonArgs = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
  const [projectGit, checkoutGit] = await Promise.all([
    worktreeGit(commonArgs, projectRoot), worktreeGit(commonArgs, actual),
  ]);
  if (!projectGit.ok || !checkoutGit.ok || await realpath(projectGit.out) !== await realpath(checkoutGit.out)) {
    throw new Error('Worktree no longer belongs to this repository');
  }
  return candidate.primary ? null : actual;
}

/** Older agent-entered worktrees recorded snapshot paths relative to main.
 * UI-bound sessions use checkout-relative paths for the whole run. */
export async function resolveSessionWorkspaceRoot(projectRoot: string, session: {
  worktree_path?: string | null;
  metadata?: Readonly<Record<string, unknown>>;
}): Promise<string> {
  if (!session.worktree_path || session.metadata?.worktree_workspace !== true) return projectRoot;
  return await resolveProjectWorktree(projectRoot, session.worktree_path) ?? projectRoot;
}
