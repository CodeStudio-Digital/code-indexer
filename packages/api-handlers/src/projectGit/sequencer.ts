/**
 * Sequencer-state detection for the conflict engine — figuring out which
 * git op (merge / cherry-pick / revert / rebase) is mid-flight and which
 * files it left conflicted. Takes `runGit` as a param so it stays free of
 * spawn plumbing.
 *
 * The fast path takes a resolved absolute `gitDir` (from `rev-parse
 * --absolute-git-dir`, which already follows the `.git` FILE of worktrees /
 * submodules) and reads the sequencer state files with pure `fs` — ZERO git
 * spawns, where the old per-file `rev-parse --git-path` cascade cost one
 * ~8-10s spawn each on heavy repos. The state files (MERGE_HEAD,
 * CHERRY_PICK_HEAD, REVERT_HEAD, rebase-merge/, rebase-apply/) are
 * per-worktree and always live in that gitdir, never the common dir, so the
 * join is correct for every layout. A spawn-based fallback covers the rare
 * case where the gitdir couldn't be resolved.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { MergeKind } from '@mcp/api-bus';

type RunGit = (
  cwd: string,
  args: string[],
  optsOrStdin?: string | { stdin?: string; env?: Record<string, string> },
) => Promise<{ code: number; stdout: string; stderr: string }>;

const NUL = String.fromCharCode(0);

async function exists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}
async function firstLine(p: string): Promise<string | undefined> {
  try { return (await fs.readFile(p, 'utf8')).split('\n')[0]?.trim() || undefined; } catch { return undefined; }
}

/** Absolute path of a gitdir entry — follows the `.git` FILE of worktrees/submodules. */
async function gitPath(runGit: RunGit, repoRoot: string, name: string): Promise<string> {
  const r = await runGit(repoRoot, ['rev-parse', '--path-format=absolute', '--git-path', name]);
  return r.stdout.trim();
}

/**
 * Which sequencer op is mid-flight. Precedence rebase > revert >
 * cherry-pick > merge: a rebase can leave a CHERRY_PICK_HEAD while
 * applying a pick, so the rebase dirs must win.
 *
 * Fast path: pure `fs` on `join(gitDir, NAME)` (no spawns). Fallback: the
 * per-file `rev-parse --git-path` spawns when `gitDir` is unavailable.
 */
export async function detectMergeKind(
  gitDir: string | null,
  fallback?: { runGit: RunGit; repoRoot: string },
): Promise<{ kind: MergeKind | null; incomingSha?: string }> {
  if (!gitDir) {
    return fallback ? detectMergeKindViaSpawn(fallback.runGit, fallback.repoRoot) : { kind: null };
  }
  const at = (name: string) => join(gitDir, name);
  if ((await exists(at('rebase-merge'))) || (await exists(at('rebase-apply')))) {
    // Merge-backend rebase records the stopped commit in rebase-merge/stopped-sha;
    // the am/apply backend has no such file — its sha lives in rebase-apply/original-commit.
    const sha =
      (await firstLine(at('rebase-merge/stopped-sha'))) ??
      (await firstLine(at('rebase-apply/original-commit')));
    return { kind: 'rebase', incomingSha: sha };
  }
  if (await exists(at('REVERT_HEAD'))) return { kind: 'revert', incomingSha: await firstLine(at('REVERT_HEAD')) };
  if (await exists(at('CHERRY_PICK_HEAD'))) return { kind: 'cherry-pick', incomingSha: await firstLine(at('CHERRY_PICK_HEAD')) };
  if (await exists(at('MERGE_HEAD'))) return { kind: 'merge', incomingSha: await firstLine(at('MERGE_HEAD')) };
  return { kind: null };
}

/** Spawn-based fallback, identical to the pre-optimization behavior (correct, slower). */
async function detectMergeKindViaSpawn(
  runGit: RunGit,
  repoRoot: string,
): Promise<{ kind: MergeKind | null; incomingSha?: string }> {
  const [rebaseMerge, rebaseApply] = await Promise.all([
    gitPath(runGit, repoRoot, 'rebase-merge'),
    gitPath(runGit, repoRoot, 'rebase-apply'),
  ]);
  if ((await exists(rebaseMerge)) || (await exists(rebaseApply))) {
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

/**
 * Current branch name from HEAD (pure fs), or '' when detached. Replaces a
 * `git branch --show-current` spawn; the caller keeps its 'HEAD (detached)'
 * fallback on the empty string.
 */
export async function readHead(gitDir: string | null): Promise<string> {
  if (!gitDir) return '';
  const head = await firstLine(join(gitDir, 'HEAD'));
  const m = head?.match(/^ref: refs\/heads\/(.+)$/);
  return m ? m[1] : '';
}

/** Unmerged (conflicted) paths, repoRoot-relative posix, via the NUL-separated diff. */
export async function listConflictedFiles(runGit: RunGit, repoRoot: string): Promise<string[]> {
  const r = await runGit(repoRoot, ['diff', '--name-only', '--diff-filter=U', '-z']);
  return r.stdout.split(NUL).filter(Boolean);
}
