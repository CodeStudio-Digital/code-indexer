import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import * as path from 'node:path';
import { defaultLocalShellPort, type IShellPort } from '@mcp/code-agent/ports/shell-port.js';
import type {
  GitCommit,
  GitCommitDetail,
  GitCommitFileChange,
  GitPushActionRequired,
  GitPushPreview,
} from '@mcp/api-bus';
import { pushWithAutoUpdate } from '@mcp/shared/git/push-with-auto-update.js';

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

async function runGit(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  const r = await port().run('git', args, {
    cwd,
    encoding: 'utf-8',
    env: env ? { ...process.env, ...env } : undefined,
  });
  return {
    ok: r.exitCode === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    code: r.exitCode,
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

function parsePushCommits(out: string): GitCommit[] {
  return out.split('\n').filter(Boolean).map((line) => {
    const [sha = '', shortSha = '', author = '', date = '', subject = '', parents = '', refs = ''] = line.split('\x1f');
    return {
      sha,
      shortSha,
      author,
      date,
      subject,
      parents: parents.trim() ? parents.trim().split(/\s+/) : [],
      refs: refs.split(',').map((item) => item.trim()).filter(Boolean),
    };
  });
}

async function resolveCommit(root: string, sha: string): Promise<string> {
  if (!sha || sha.startsWith('-')) throw new Error('invalid commit');
  const result = await runGit(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${sha}^{commit}`]);
  const resolved = result.ok ? result.stdout.trim() : '';
  if (!resolved) throw new Error('unknown commit');
  return resolved;
}

async function commitFiles(root: string, sha: string): Promise<GitCommitFileChange[]> {
  const [numstat, names] = await Promise.all([
    runGit(root, ['show', '--format=', '--numstat', '-z', sha]),
    runGit(root, ['show', '--format=', '--name-status', '-z', sha]),
  ]);
  if (!numstat.ok || !names.ok) throw new Error((numstat.stderr || names.stderr || 'failed to inspect commit').trim());
  const counts = new Map<string, { additions: number; deletions: number }>();
  const numberRows = numstat.stdout.split('\0');
  for (let index = 0; index < numberRows.length; index += 1) {
    const row = numberRows[index];
    if (!row) continue;
    const first = row.indexOf('\t');
    const second = first < 0 ? -1 : row.indexOf('\t', first + 1);
    if (second < 0) continue;
    let filePath = row.slice(second + 1);
    if (!filePath) {
      index += 1;
      filePath = numberRows[++index] ?? '';
    }
    if (!filePath) continue;
    const additions = row.slice(0, first);
    const deletions = row.slice(first + 1, second);
    counts.set(filePath, {
      additions: additions === '-' ? 0 : Number(additions) || 0,
      deletions: deletions === '-' ? 0 : Number(deletions) || 0,
    });
  }
  const rows = names.stdout.split('\0');
  const files: GitCommitFileChange[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const code = rows[index];
    if (!code) continue;
    const prefix = code[0];
    const state: GitCommitFileChange['state'] = prefix === 'A' ? 'added' : prefix === 'D' ? 'deleted' : prefix === 'R' ? 'renamed' : prefix === 'C' ? 'copied' : 'modified';
    let oldPath: string | undefined;
    if (state === 'renamed' || state === 'copied') oldPath = rows[++index] ?? '';
    const filePath = rows[++index] ?? '';
    if (!filePath) continue;
    const stats = counts.get(filePath) ?? { additions: 0, deletions: 0 };
    files.push({ path: filePath, oldPath, state, ...stats });
  }
  return files;
}

export async function gitPushPreview(root: string): Promise<GitPushPreview> {
  if (!hasGitDir(root)) throw new Error('not a git repo');
  const status = await gitStatus(root);
  const branch = status.branch;
  if (!branch) throw new Error('detached HEAD — checkout a branch first');
  const remotesResult = await runGit(root, ['remote']);
  if (!remotesResult.ok) throw new Error(remotesResult.stderr.trim() || 'failed to list remotes');
  const remotes = remotesResult.stdout.split('\n').map((item) => item.trim()).filter(Boolean);
  const upstreamRemote = status.upstream
    ? [...remotes].sort((a, b) => b.length - a.length).find((name) => status.upstream!.startsWith(`${name}/`))
    : undefined;
  const remote = upstreamRemote ?? (remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : undefined);
  if (!remote) throw new Error('No unambiguous push remote is configured.');
  const targetBranch = status.upstream && upstreamRemote === remote ? status.upstream.slice(remote.length + 1) : branch;
  const trackingRef = `refs/remotes/${remote}/${targetBranch}`;
  const tracking = await runGit(root, ['show-ref', '--verify', '--quiet', trackingRef]);
  const revisions = tracking.ok
    ? [`${trackingRef}..refs/heads/${branch}`]
    : [`refs/heads/${branch}`, '--not', `--remotes=${remote}`];
  const fmt = '%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%P%x1f%D';
  const [head, count, log, tags] = await Promise.all([
    runGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]),
    runGit(root, ['rev-list', '--count', ...revisions]),
    runGit(root, ['log', `--pretty=format:${fmt}`, '--date=iso-strict', '--decorate=short', '-n501', ...revisions]),
    runGit(root, ['for-each-ref', '--format=%(refname:short)%09%(objectname:short)%09%(contents:subject)', '--count=501', 'refs/tags']),
  ]);
  if (!head.ok || !count.ok || !log.ok || !tags.ok) throw new Error((head.stderr || count.stderr || log.stderr || tags.stderr || 'failed to build push preview').trim());
  const commitCount = Number(count.stdout.trim()) || 0;
  const commits = parsePushCommits(log.stdout).slice(0, 500);
  const parsedTags = tags.stdout.split('\n').filter(Boolean).map((line) => {
    const [name = '', target = '', subject = ''] = line.split('\t');
    return { name, target, subject };
  });
  return {
    branch,
    headSha: head.stdout.trim(),
    remote,
    targetBranch,
    upstream: status.upstream,
    setUpstream: !status.upstream,
    commits,
    commitCount,
    commitsTruncated: commitCount > commits.length,
    tags: parsedTags.slice(0, 500),
    tagCount: parsedTags.length,
    tagsTruncated: parsedTags.length > 500,
  };
}

export async function gitCommitDetail(root: string, sha: string): Promise<GitCommitDetail> {
  const resolved = await resolveCommit(root, sha);
  const [meta, body, files] = await Promise.all([
    runGit(root, ['show', '-s', '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%P%x1f%s', '--date=iso-strict', resolved]),
    runGit(root, ['show', '-s', '--format=%b', resolved]),
    commitFiles(root, resolved),
  ]);
  if (!meta.ok || !body.ok) throw new Error((meta.stderr || body.stderr || 'failed to inspect commit').trim());
  const [fullSha = '', shortSha = '', author = '', authorEmail = '', date = '', parents = '', subject = ''] = meta.stdout.trim().split('\x1f');
  return {
    sha: fullSha,
    shortSha,
    author,
    authorEmail,
    date,
    subject,
    body: body.stdout.replace(/\s+$/, ''),
    parents: parents.trim() ? parents.trim().split(/\s+/) : [],
    files,
  };
}

export async function gitCommitFileDiff(root: string, sha: string, filePath: string): Promise<{ diff: string; truncated: boolean }> {
  const resolved = await resolveCommit(root, sha);
  const result = await runGit(root, ['show', '--no-color', '--format=', resolved, '--', filePath]);
  if (!result.ok) throw new Error(result.stderr.trim() || 'failed to read commit diff');
  const diff = result.stdout.length > MAX_DIFF_BYTES ? result.stdout.slice(0, MAX_DIFF_BYTES) : result.stdout;
  return { diff, truncated: result.stdout.length > MAX_DIFF_BYTES };
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

export interface GitPushResult extends GitMutationResult {
  /** True when the local branch had no upstream and one was set with `--set-upstream`. */
  setUpstream: boolean;
  /** True when a rejected push was safely rebased onto the remote and retried. */
  updatedBeforePush?: boolean;
  /** Stable UI intent when automatic push recovery needs operator action. */
  pushActionRequired?: GitPushActionRequired;
}

type WorkspaceGitResult = Awaited<ReturnType<typeof runGit>>;

function workspacePushResult(
  result: WorkspaceGitResult,
  setUpstream: boolean,
  extras: Pick<GitPushResult, 'updatedBeforePush' | 'pushActionRequired'> = {},
): GitPushResult {
  return {
    ok: result.ok,
    message: (result.stderr || result.stdout).trim() || (result.ok ? 'pushed' : 'git push failed'),
    setUpstream,
    ...extras,
  };
}

function workspacePushNeedsAction(
  result: WorkspaceGitResult,
  setUpstream: boolean,
  action: GitPushActionRequired,
  message: string,
): GitPushResult {
  const detail = (result.stderr || result.stdout).trim();
  return {
    ok: false,
    message: detail ? `${message}\n\n${detail}` : message,
    setUpstream,
    pushActionRequired: action,
  };
}

/**
 * Push the current branch to its upstream. When the branch has no
 * upstream yet, fall back to `git push --set-upstream origin <branch>`
 * so first-push workflows work without extra UI steps. Returns the
 * combined git output for surfacing in the toast.
 */
export async function gitPush(root: string, options: {
  remote?: string;
  branch?: string;
  targetBranch?: string;
  expectedHead?: string;
  setUpstream?: boolean;
  pushTags?: boolean;
} = {}): Promise<GitPushResult> {
  if (!hasGitDir(root)) return { ok: false, message: 'not a git repo', setUpstream: false };
  if (options.remote && options.branch) {
    if (options.expectedHead) {
      const actualHead = await runGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${options.branch}`]);
      if (!actualHead.ok || actualHead.stdout.trim() !== options.expectedHead) {
        return { ok: false, message: 'The branch changed after this push preview was opened. Review it again before pushing.', setUpstream: false };
      }
    }
    const args = ['push'];
    if (options.setUpstream) args.push('--set-upstream');
    // Keep reviewed branch + tag publication all-or-nothing. This also
    // prevents tags from being published before an automatic update stops.
    if (options.pushTags) args.push('--atomic', '--tags');
    args.push(options.remote);
    args.push(options.targetBranch && options.targetBranch !== options.branch
      ? `${options.branch}:${options.targetBranch}`
      : options.branch);
    const setUpstream = options.setUpstream === true;
    const outcome = await pushWithAutoUpdate({
      pushArgs: args,
      remote: options.remote,
      branch: options.branch,
      targetBranch: options.targetBranch ?? options.branch,
      expectedHead: options.expectedHead,
      pushTags: options.pushTags,
      run: (gitArgs, runOptions) => runGit(root, gitArgs, runOptions.env),
    });
    if (outcome.actionRequired) {
      const failure = workspacePushNeedsAction(
        outcome.result,
        setUpstream,
        outcome.actionRequired,
        outcome.actionMessage ?? 'Update the branch before pushing.',
      );
      return { ...failure, updatedBeforePush: outcome.updatedBeforePush };
    }
    return workspacePushResult(outcome.result, setUpstream, {
      updatedBeforePush: outcome.updatedBeforePush,
    });
  }
  // Try the plain `git push` first — git already knows the upstream
  // for branches that have one configured.
  const direct = await runGit(root, ['push']);
  if (direct.ok) {
    return { ok: true, message: (direct.stderr || direct.stdout).trim() || 'pushed', setUpstream: false };
  }
  // No upstream? Detect via the stderr message and retry with
  // `--set-upstream origin <branch>`. Git emits "has no upstream branch"
  // and "set-upstream" hints in this case.
  const combined = (direct.stderr || direct.stdout || '').toLowerCase();
  const looksLikeNoUpstream =
    combined.includes('no upstream branch') || combined.includes('set-upstream');
  if (!looksLikeNoUpstream) {
    return { ok: false, message: (direct.stderr || direct.stdout).trim() || 'git push failed', setUpstream: false };
  }
  // Resolve current branch name.
  const head = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!head.ok) {
    return { ok: false, message: 'failed to resolve current branch', setUpstream: false };
  }
  const branch = head.stdout.trim();
  if (!branch || branch === 'HEAD') {
    return { ok: false, message: 'detached HEAD — checkout a branch first', setUpstream: false };
  }
  const retry = await runGit(root, ['push', '--set-upstream', 'origin', branch]);
  if (!retry.ok) {
    return { ok: false, message: (retry.stderr || retry.stdout).trim() || 'git push failed', setUpstream: true };
  }
  return { ok: true, message: (retry.stderr || retry.stdout).trim() || 'pushed', setUpstream: true };
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
