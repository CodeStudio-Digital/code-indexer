/**
 * Sequencer-state detection for the conflict engine — figuring out which
 * git op (merge / cherry-pick / revert / rebase) is mid-flight and which
 * files it left conflicted. Split from conflicts.ts to keep each module
 * small; takes `runGit` as a param so it stays free of spawn plumbing.
 */

import { promises as fs } from 'node:fs';
import type { MergeKind } from '@mcp/api-bus';

type RunGit = (
  cwd: string,
  args: string[],
  optsOrStdin?: string | { stdin?: string; env?: Record<string, string> },
) => Promise<{ code: number; stdout: string; stderr: string }>;

const NUL = String.fromCharCode(0);

/** Absolute path of a gitdir entry — follows the `.git` FILE of worktrees/submodules. */
async function gitPath(runGit: RunGit, repoRoot: string, name: string): Promise<string> {
  const r = await runGit(repoRoot, ['rev-parse', '--path-format=absolute', '--git-path', name]);
  return r.stdout.trim();
}
async function exists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}
async function firstLine(p: string): Promise<string | undefined> {
  try { return (await fs.readFile(p, 'utf8')).split('\n')[0]?.trim() || undefined; } catch { return undefined; }
}

/**
 * Which sequencer op is mid-flight. Precedence rebase > revert >
 * cherry-pick > merge: a rebase can leave a CHERRY_PICK_HEAD while
 * applying a pick, so the rebase dirs must win.
 */
export async function detectMergeKind(
  runGit: RunGit,
  repoRoot: string,
): Promise<{ kind: MergeKind | null; incomingSha?: string }> {
  const [rebaseMerge, rebaseApply] = await Promise.all([
    gitPath(runGit, repoRoot, 'rebase-merge'),
    gitPath(runGit, repoRoot, 'rebase-apply'),
  ]);
  if ((await exists(rebaseMerge)) || (await exists(rebaseApply))) {
    // Merge-backend rebase records the stopped commit in rebase-merge/stopped-sha;
    // the am/apply backend has no such file — its sha lives in rebase-apply/original-commit.
    const sha =
      (await firstLine(await gitPath(runGit, repoRoot, 'rebase-merge/stopped-sha'))) ??
      (await firstLine(await gitPath(runGit, repoRoot, 'rebase-apply/original-commit')));
    return { kind: 'rebase', incomingSha: sha };
  }
  const revertHead = await gitPath(runGit, repoRoot, 'REVERT_HEAD');
  if (await exists(revertHead)) return { kind: 'revert', incomingSha: await firstLine(revertHead) };
  const cpHead = await gitPath(runGit, repoRoot, 'CHERRY_PICK_HEAD');
  if (await exists(cpHead)) return { kind: 'cherry-pick', incomingSha: await firstLine(cpHead) };
  const mergeHead = await gitPath(runGit, repoRoot, 'MERGE_HEAD');
  if (await exists(mergeHead)) return { kind: 'merge', incomingSha: await firstLine(mergeHead) };
  return { kind: null };
}

/** Unmerged (conflicted) paths, repoRoot-relative posix, via the NUL-separated diff. */
export async function listConflictedFiles(runGit: RunGit, repoRoot: string): Promise<string[]> {
  const r = await runGit(repoRoot, ['diff', '--name-only', '--diff-filter=U', '-z']);
  return r.stdout.split(NUL).filter(Boolean);
}
