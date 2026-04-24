import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import * as path from 'node:path';
import { defaultLocalShellPort, type IShellPort } from '../../../../../core/coder/ports/shell-port.js';

export interface GitFileStatus {
  path: string;
  index: string;   // single-char status from porcelain v2 ('.', 'M', 'A', 'D', '?', …)
  worktree: string;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
}

const MAX_DIFF_BYTES = 500_000;
const MAX_LOG_BYTES = 100_000;

function port(): IShellPort {
  return defaultLocalShellPort();
}

async function runGit(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }> {
  const r = await port().run('git', args, { cwd, encoding: 'utf-8' });
  return {
    ok: r.exitCode === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    exitCode: r.exitCode,
  };
}

export function hasGitDir(root: string): boolean {
  return existsSync(path.join(root, '.git'));
}

/**
 * Parse `git status --porcelain=v2 --branch` output into a structured
 * snapshot. Porcelain v2 is machine-stable and gives us ahead/behind for
 * free via header lines.
 */
export async function gitStatus(root: string): Promise<GitStatus> {
  if (!hasGitDir(root)) {
    return { isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  }
  const r = await runGit(root, ['status', '--porcelain=v2', '--branch']);
  if (!r.ok) {
    return { isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  }
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitFileStatus[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim();
    } else if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        ahead = parseInt(m[1], 10);
        behind = parseInt(m[2], 10);
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // "1 XY … path" or "2 XY … path<TAB>orig"
      const parts = line.split(' ');
      const xy = parts[1] ?? '..';
      const pathIdx = line.indexOf(parts[8] ?? '');
      const rest = pathIdx >= 0 ? line.slice(pathIdx) : parts.slice(8).join(' ');
      files.push({ path: rest.split('\t')[0], index: xy[0] ?? '.', worktree: xy[1] ?? '.' });
    } else if (line.startsWith('? ')) {
      files.push({ path: line.slice(2), index: '?', worktree: '?' });
    } else if (line.startsWith('! ')) {
      files.push({ path: line.slice(2), index: '!', worktree: '!' });
    }
  }
  return { isRepo: true, branch, upstream, ahead, behind, files };
}

export async function gitDiff(
  root: string,
  opts: { path?: string; staged?: boolean } = {},
): Promise<{ diff: string; truncated: boolean }> {
  const args = ['diff'];
  if (opts.staged) args.push('--staged');
  args.push('--no-color');
  if (opts.path) args.push('--', opts.path);
  const r = await runGit(root, args);
  const raw = r.stdout ?? '';
  if (raw.length > MAX_DIFF_BYTES) {
    return { diff: raw.slice(0, MAX_DIFF_BYTES), truncated: true };
  }
  return { diff: raw, truncated: false };
}

export interface GitLogEntry {
  hash: string;
  subject: string;
}

export async function gitLog(root: string, limit: number): Promise<GitLogEntry[]> {
  const r = await runGit(root, ['log', `-${Math.max(1, Math.min(200, limit))}`, '--pretty=format:%h%x09%s']);
  const out: GitLogEntry[] = [];
  const raw = r.stdout.length > MAX_LOG_BYTES ? r.stdout.slice(0, MAX_LOG_BYTES) : r.stdout;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    out.push({ hash: line.slice(0, tab), subject: line.slice(tab + 1) });
  }
  return out;
}

export async function gitInit(root: string): Promise<{ ok: boolean; message: string }> {
  if (hasGitDir(root)) return { ok: true, message: 'already a repo' };
  const r = await runGit(root, ['init']);
  return { ok: r.ok, message: (r.stdout + r.stderr).trim() || (r.ok ? 'initialized' : 'git init failed') };
}

export interface GitMutationResult {
  ok: boolean;
  message: string;
}

export async function gitAdd(root: string, paths: string[]): Promise<GitMutationResult> {
  if (!hasGitDir(root)) return { ok: false, message: 'not a git repo' };
  if (paths.length === 0) return { ok: true, message: 'nothing to stage' };
  const r = await runGit(root, ['add', '--', ...paths]);
  return { ok: r.ok, message: (r.stderr || r.stdout).trim() || (r.ok ? 'staged' : 'git add failed') };
}

export async function gitReset(root: string, paths: string[]): Promise<GitMutationResult> {
  if (!hasGitDir(root)) return { ok: false, message: 'not a git repo' };
  if (paths.length === 0) return { ok: true, message: 'nothing to unstage' };
  const r = await runGit(root, ['reset', 'HEAD', '--', ...paths]);
  return { ok: r.ok, message: (r.stderr || r.stdout).trim() || (r.ok ? 'unstaged' : 'git reset failed') };
}

export interface GitCommitResult extends GitMutationResult {
  hash: string | null;
}

/**
 * Discard working-tree + index changes for the given paths, bringing them
 * back to HEAD (or removing them entirely, if untracked / newly added and
 * never committed). Intended for "undo what the AI did" flows.
 *
 * Strategy per path, based on the current status:
 * - untracked ('?'): delete from disk.
 * - tracked (M/D/R/C or staged-only): `git restore --source=HEAD --staged --worktree -- <path>`.
 * - newly added ('A' with no HEAD version): unstage via `git restore --staged`, then delete from disk.
 *
 * If a path isn't in `status.files`, it's skipped silently (already clean).
 */
export async function gitDiscard(
  root: string,
  paths: string[],
  status: GitStatus,
): Promise<GitMutationResult> {
  if (!hasGitDir(root)) return { ok: false, message: 'not a git repo' };
  if (paths.length === 0) return { ok: true, message: 'nothing to discard' };

  const byPath = new Map(status.files.map((f) => [f.path, f]));
  const toDelete: string[] = [];
  const toRestore: string[] = [];
  const newlyAdded: string[] = [];

  for (const p of paths) {
    const f = byPath.get(p);
    if (!f) continue;
    if (f.index === '?' && f.worktree === '?') {
      toDelete.push(p);
    } else if (f.index === 'A' && (f.worktree === '.' || f.worktree === 'A')) {
      newlyAdded.push(p);
    } else {
      toRestore.push(p);
    }
  }

  const messages: string[] = [];

  if (toRestore.length > 0) {
    const r = await runGit(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...toRestore]);
    if (!r.ok) return { ok: false, message: (r.stderr || r.stdout).trim() || 'git restore failed' };
    messages.push(`restored ${toRestore.length}`);
  }

  if (newlyAdded.length > 0) {
    const unstage = await runGit(root, ['restore', '--staged', '--', ...newlyAdded]);
    if (!unstage.ok) return { ok: false, message: (unstage.stderr || unstage.stdout).trim() || 'git restore --staged failed' };
    toDelete.push(...newlyAdded);
  }

  for (const rel of toDelete) {
    const abs = path.join(root, rel);
    try {
      await rm(abs, { force: true, recursive: false });
    } catch (err) {
      return { ok: false, message: `failed to remove ${rel}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  if (toDelete.length > 0) messages.push(`removed ${toDelete.length}`);

  return { ok: true, message: messages.join(', ') || 'nothing to discard' };
}

export async function gitCommit(root: string, message: string): Promise<GitCommitResult> {
  if (!hasGitDir(root)) return { ok: false, hash: null, message: 'not a git repo' };
  const trimmed = message.trim();
  if (!trimmed) return { ok: false, hash: null, message: 'empty commit message' };
  const r = await runGit(root, ['commit', '-m', trimmed]);
  if (!r.ok) {
    return { ok: false, hash: null, message: (r.stderr || r.stdout).trim() || 'git commit failed' };
  }
  const head = await runGit(root, ['rev-parse', '--short', 'HEAD']);
  const hash = head.ok ? head.stdout.trim() : null;
  return { ok: true, hash, message: r.stdout.trim() || 'committed' };
}
