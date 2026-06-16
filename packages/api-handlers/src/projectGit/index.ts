/**
 * Project-local git operations — wraps the `git` CLI at the project's
 * `root_path`. Distinct from the sandbox git handlers in
 * @mcp/company; this is what the IDE workspace's Git tool window uses
 * to surface status / diff / stage / commit for the operator's actual
 * working tree.
 *
 * Why CLI: keeps us out of `simple-git` / `isomorphic-git` deps and
 * matches whatever git the user has installed (signing keys, hooks,
 * lfs, etc. all work for free). Each invocation is short-lived so
 * spawn cost is fine.
 */

import { spawn } from 'node:child_process';
import {
  ApiError,
  type ProjectGitApi,
  type GitStatusFile,
  type GitCommitFileChange,
  type GitBranch,
  type GitRunResult,
  type GitStashEntry,
  type GitPlan,
  type GitPlanStep,
} from '@mcp/api-bus';
import type { HandlerDeps } from '../types.js';
import { callGeneralAiJson } from '../aiJson.js';
import { createConflictHandlers } from './conflicts.js';

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `git` and collect output. The 3rd arg is either the legacy
 * positional `stdin` string OR an options bag `{ stdin?, env? }` — kept a
 * union so the ~30 existing positional callers (e.g. `commit` piping the
 * message) work unchanged. `env` is MERGED over `process.env` (never
 * replaces it — dropping PATH would make git unspawnable); used to inject
 * GIT_EDITOR=true on the `--continue` path so it can't block on an editor.
 */
function runGit(
  cwd: string,
  args: string[],
  optsOrStdin?: string | { stdin?: string; env?: Record<string, string> },
): Promise<GitResult> {
  const opts = typeof optsOrStdin === 'string' ? { stdin: optsOrStdin } : (optsOrStdin ?? {});
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (e) => {
      resolve({ code: -1, stdout: '', stderr: (e as Error).message });
    });
    child.on('close', (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
    if (opts.stdin) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Parse the `XY path` lines of `git status --porcelain=v1 -z`. The two
 * status chars are independent: X = staged, Y = working-tree. We collapse
 * to one entry per path with `staged: boolean` and a coarse `state`.
 */
function parsePorcelainStatus(out: string): GitStatusFile[] {
  if (!out) return [];
  const entries: GitStatusFile[] = [];
  // `-z` separates records with NUL. Rename entries take the next NUL too.
  const records = out.split('\0');
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r) continue;
    const xy = r.slice(0, 2);
    const rest = r.slice(3); // skip "XY "
    if (!rest) continue;
    let path = rest;
    if (xy[0] === 'R' || xy[1] === 'R') {
      // Renames: next record is the old path; we keep the new path.
      i += 1;
    }
    const stagedChar = xy[0];
    const wtChar = xy[1];
    const interpret = (c: string): GitStatusFile['state'] | null => {
      switch (c) {
        case 'M': return 'modified';
        case 'A': return 'added';
        case 'D': return 'deleted';
        case 'R': return 'renamed';
        case 'C': return 'copied';
        case '?': return 'untracked';
        case '!': return 'ignored';
        case 'U': return 'unmerged';
        case ' ': return null;
        default: return null;
      }
    };
    const stagedState = interpret(stagedChar);
    if (stagedState && stagedState !== 'untracked' && stagedState !== 'ignored') {
      entries.push({ path, state: stagedState, staged: true });
    }
    const wtState = interpret(wtChar);
    if (wtState) {
      entries.push({ path, state: wtState, staged: false });
    }
  }
  return entries;
}

function parseHeadBranchInfo(out: string): {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
} {
  // `git status --porcelain=v2 --branch -z` headers start with `#`.
  // We get e.g.:
  //   # branch.oid <sha>
  //   # branch.head main
  //   # branch.upstream origin/main
  //   # branch.ab +2 -1
  const lines = out.split(/[\0\n]/).filter((l) => l.startsWith('# branch.'));
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  for (const line of lines) {
    const [, key, value] = line.match(/^# (\S+)\s(.+)$/) ?? [];
    if (!key) continue;
    if (key === 'branch.head') branch = value === '(detached)' ? null : value;
    else if (key === 'branch.upstream') upstream = value;
    else if (key === 'branch.ab') {
      const m = value.match(/^\+(\d+)\s-(\d+)$/);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    }
  }
  return { branch, upstream, ahead, behind };
}

/**
 * Build a changed-file list by merging `--name-status` (authoritative
 * status + rename old/new paths) with `--numstat` (per-file add/remove
 * counts, keyed by the new path). We avoid `-z` parsing to keep the
 * splits trivial; for renames the numstat path is a combined `old =>
 * new` token that won't key-match, so those rows fall back to 0/0 — fine
 * since renames are usually content-identical.
 *
 * `argsWith(flag)` produces the full git argv for the given stat flag —
 * differs between a commit (`show … <sha>`) and a stash (`stash show …
 * <ref>`), so the caller supplies it.
 */
async function collectChangedFiles(
  cwd: string,
  argsWith: (statFlag: string) => string[],
): Promise<GitCommitFileChange[]> {
  const mapState = (code: string): GitCommitFileChange['state'] => {
    const c = code[0];
    if (c === 'A') return 'added';
    if (c === 'D') return 'deleted';
    if (c === 'R') return 'renamed';
    if (c === 'C') return 'copied';
    return 'modified'; // M, T (typechange), and anything unexpected
  };

  const numstat = await runGit(cwd, argsWith('--numstat'));
  const counts = new Map<string, { additions: number; deletions: number }>();
  for (const line of numstat.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [adds, dels, ...pathParts] = line.split('\t');
    const path = pathParts.join('\t');
    if (!path) continue;
    counts.set(path, {
      additions: adds === '-' ? 0 : Number(adds) || 0,
      deletions: dels === '-' ? 0 : Number(dels) || 0,
    });
  }

  const nameStatus = await runGit(cwd, argsWith('--name-status'));
  const files: GitCommitFileChange[] = [];
  for (const line of nameStatus.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0];
    if (!code) continue;
    const state = mapState(code);
    let path: string;
    let oldPath: string | undefined;
    if ((state === 'renamed' || state === 'copied') && parts.length >= 3) {
      oldPath = parts[1];
      path = parts[2];
    } else {
      path = parts[1] ?? '';
    }
    if (!path) continue;
    const c = counts.get(path) ?? { additions: 0, deletions: 0 };
    files.push({ path, oldPath, state, additions: c.additions, deletions: c.deletions });
  }
  return files;
}

export function createProjectGitHandlers(deps: HandlerDeps): ProjectGitApi {
  const { db } = deps;

  function requireRoot(projectId: number): string {
    const project = db.getProject(projectId);
    if (!project) throw new ApiError('not_found', 404, 'project not found');
    return project.root_path;
  }

  async function detectRepo(root: string): Promise<{ repoRoot: string | null; notARepo: boolean }> {
    const r = await runGit(root, ['rev-parse', '--show-toplevel']);
    if (r.code !== 0) return { repoRoot: null, notARepo: true };
    return { repoRoot: r.stdout.trim(), notARepo: false };
  }

  const base: Omit<
    ProjectGitApi,
    'mergeState' | 'conflictFile' | 'resolveConflict' | 'mergeContinue' | 'mergeAbort'
  > = {
    async status({ projectId }) {
      const root = requireRoot(projectId);
      const { repoRoot, notARepo } = await detectRepo(root);
      if (notARepo) {
        return {
          branch: null,
          upstream: null,
          ahead: 0,
          behind: 0,
          files: [],
          repoRoot: null,
          notARepo: true,
        };
      }
      const cwd = repoRoot ?? root;
      // Combined porcelain v1 (files) + branch headers from v2 in one go
      // would be cleanest, but v1 doesn't emit headers; cheaper to make
      // two short calls.
      const filesRes = await runGit(cwd, ['status', '--porcelain=v1', '-z']);
      const headerRes = await runGit(cwd, ['status', '--porcelain=v2', '--branch', '-z']);
      const files = parsePorcelainStatus(filesRes.stdout);
      const head = parseHeadBranchInfo(headerRes.stdout);
      return {
        ...head,
        files,
        repoRoot: cwd,
        notARepo: false,
      };
    },

    async diff({ projectId, path, staged }) {
      const root = requireRoot(projectId);
      const args = ['diff', '--no-color'];
      if (staged) args.push('--cached');
      if (path) args.push('--', path);
      const r = await runGit(root, args);
      if (r.code !== 0 && !r.stdout) {
        throw new ApiError('git_diff_failed', 500, r.stderr.trim() || 'git diff failed');
      }
      return { patch: r.stdout };
    },

    async log({ projectId, limit = 30, path, branch }) {
      const root = requireRoot(projectId);
      const fmt = '%H%x1f%h%x1f%an%x1f%ad%x1f%s';
      const args = ['log', `--pretty=format:${fmt}`, '--date=iso-strict', `-n${limit}`];
      // Branch filter ALWAYS goes BEFORE the `--` separator. Treating
      // it as a single ref is intentional — the renderer drives a
      // dropdown that emits exact branch names, so we don't need glob
      // expansion (which would also let users `git log --all` here).
      if (branch) args.push(branch);
      if (path) args.push('--', path);
      const r = await runGit(root, args);
      if (r.code !== 0) {
        throw new ApiError('git_log_failed', 500, r.stderr.trim() || 'git log failed');
      }
      return r.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, shortSha, author, date, subject] = line.split('\x1f');
          return { sha, shortSha, author, date, subject };
        });
    },

    async commitDetail({ projectId, sha }) {
      const root = requireRoot(projectId);
      // Metadata in one pass. `%P` (parents) is space-separated; `%b`
      // (body) can contain anything including our separator, so it's
      // fetched in a second `-s` call where it's the whole output.
      const metaFmt = '%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%P%x1f%s';
      const meta = await runGit(root, ['show', '-s', `--format=${metaFmt}`, '--date=iso-strict', sha]);
      if (meta.code !== 0) {
        throw new ApiError('git_show_failed', 500, meta.stderr.trim() || 'git show failed');
      }
      const [fullSha, shortSha, author, authorEmail, date, parentStr, subject] =
        meta.stdout.trim().split('\x1f');
      const body = (await runGit(root, ['show', '-s', '--format=%b', sha])).stdout.replace(/\s+$/, '');
      const files = await collectChangedFiles(root, (flag) => ['show', flag, '--format=', sha]);
      return {
        sha: fullSha,
        shortSha,
        author,
        authorEmail,
        date,
        subject: subject ?? '',
        body,
        parents: parentStr ? parentStr.trim().split(/\s+/).filter(Boolean) : [],
        files,
      };
    },

    async commitFileDiff({ projectId, sha, path }) {
      const root = requireRoot(projectId);
      // Empty `--format=` strips the commit header so we return only the
      // unified patch — matches the shape `diff` returns.
      const r = await runGit(root, ['show', '--no-color', '--format=', sha, '--', path]);
      if (r.code !== 0 && !r.stdout) {
        throw new ApiError('git_show_failed', 500, r.stderr.trim() || 'git show failed');
      }
      return { patch: r.stdout };
    },

    async stage({ projectId, paths }) {
      if (paths.length === 0) return { ok: true as const };
      const root = requireRoot(projectId);
      const r = await runGit(root, ['add', '--', ...paths]);
      if (r.code !== 0) {
        throw new ApiError('git_stage_failed', 500, r.stderr.trim() || 'git add failed');
      }
      return { ok: true as const };
    },

    async unstage({ projectId, paths }) {
      if (paths.length === 0) return { ok: true as const };
      const root = requireRoot(projectId);
      const r = await runGit(root, ['restore', '--staged', '--', ...paths]);
      if (r.code !== 0) {
        throw new ApiError('git_unstage_failed', 500, r.stderr.trim() || 'git restore --staged failed');
      }
      return { ok: true as const };
    },

    async discard({ projectId, paths }) {
      if (paths.length === 0) return { ok: true as const };
      const root = requireRoot(projectId);
      const r = await runGit(root, ['checkout', '--', ...paths]);
      if (r.code !== 0) {
        throw new ApiError('git_discard_failed', 500, r.stderr.trim() || 'git checkout failed');
      }
      return { ok: true as const };
    },

    async commit({ projectId, message, amend }) {
      const root = requireRoot(projectId);
      const args = ['commit'];
      if (amend) args.push('--amend');
      args.push('-F', '-');
      const r = await runGit(root, args, message);
      if (r.code !== 0) {
        throw new ApiError('git_commit_failed', 500, r.stderr.trim() || 'git commit failed');
      }
      const sha = (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim();
      return { sha };
    },

    async branchList({ projectId }) {
      const root = requireRoot(projectId);
      const cur = (await runGit(root, ['branch', '--show-current'])).stdout.trim() || null;
      const all = (await runGit(root, ['branch', '--list', '--format=%(refname:short)']))
        .stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      return { current: cur, all };
    },

    async branchCheckout({ projectId, name, create }) {
      const root = requireRoot(projectId);
      const args = create ? ['checkout', '-b', name] : ['checkout', name];
      const r = await runGit(root, args);
      if (r.code !== 0) {
        throw new ApiError('git_checkout_failed', 500, r.stderr.trim() || 'git checkout failed');
      }
      return { ok: true as const };
    },

    // ─── Branches (rich) ─────────────────────────────────────────
    async branchesDetailed({ projectId, includeRemote }) {
      const root = requireRoot(projectId);
      // `git for-each-ref` with a tab-separated format is the cheap
      // single-call alternative to running `git branch -vv` and parsing
      // its column-oriented output. We pull both refs/heads and
      // refs/remotes when requested.
      const fmt = [
        '%(refname:short)',                  // 0
        '%(HEAD)',                           // 1 ('*' for current)
        '%(refname)',                        // 2 (full ref for is-remote test)
        '%(upstream:short)',                 // 3
        '%(upstream:track,nobracket)',       // 4 (e.g. "ahead 2, behind 1" or empty)
        '%(contents:subject)',               // 5
      ].join('%09');
      const refs = ['refs/heads'];
      if (includeRemote !== false) refs.push('refs/remotes');
      const r = await runGit(root, ['for-each-ref', `--format=${fmt}`, ...refs]);
      if (r.code !== 0) {
        throw new ApiError('git_branch_list_failed', 500, r.stderr.trim() || 'for-each-ref failed');
      }
      const cur = (await runGit(root, ['branch', '--show-current'])).stdout.trim();
      const branches: GitBranch[] = [];
      for (const line of r.stdout.split('\n').filter(Boolean)) {
        const [name, head, refname, upstream, track, subject] = line.split('\t');
        if (!name) continue;
        // Skip the special HEAD pointer of remotes (e.g. origin/HEAD).
        if (refname?.startsWith('refs/remotes/') && name.endsWith('/HEAD')) continue;
        let ahead = 0;
        let behind = 0;
        if (track) {
          const m1 = track.match(/ahead (\d+)/);
          const m2 = track.match(/behind (\d+)/);
          if (m1) ahead = Number(m1[1]);
          if (m2) behind = Number(m2[1]);
        }
        branches.push({
          name,
          isCurrent: name === cur || head === '*',
          isRemote: !!refname?.startsWith('refs/remotes/'),
          upstream: upstream || null,
          ahead,
          behind,
          tipSubject: subject ?? '',
        });
      }
      // Sort: current first, then locals (alpha), then remotes (alpha).
      branches.sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
        if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
      return branches;
    },

    async branchCreate({ projectId, name, from, checkout }) {
      const root = requireRoot(projectId);
      const args = checkout ? ['checkout', '-b', name] : ['branch', name];
      if (from) args.push(from);
      const r = await runGit(root, args);
      if (r.code !== 0) {
        throw new ApiError('git_branch_create_failed', 500, r.stderr.trim() || 'git branch failed');
      }
      return { ok: true as const };
    },

    async branchDelete({ projectId, name, force }) {
      const root = requireRoot(projectId);
      // -D (force) merges -d's safety check + force-delete; -d alone
      // refuses to delete branches not fully merged into HEAD.
      const args = ['branch', force ? '-D' : '-d', name];
      const r = await runGit(root, args);
      if (r.code !== 0) {
        throw new ApiError('git_branch_delete_failed', 500, r.stderr.trim() || 'git branch -d failed');
      }
      return { ok: true as const };
    },

    async branchRename({ projectId, oldName, newName, force }) {
      const root = requireRoot(projectId);
      const args = ['branch', force ? '-M' : '-m', oldName, newName];
      const r = await runGit(root, args);
      if (r.code !== 0) {
        throw new ApiError('git_branch_rename_failed', 500, r.stderr.trim() || 'git branch -m failed');
      }
      return { ok: true as const };
    },

    // ─── Merge / reset / revert / cherry-pick ────────────────────
    async merge({ projectId, branch, ffOnly, noFf, message }) {
      const root = requireRoot(projectId);
      const args = ['merge'];
      if (ffOnly) args.push('--ff-only');
      if (noFf) args.push('--no-ff');
      if (message) args.push('-m', message);
      args.push(branch);
      return runAsResult(root, 'git', args);
    },

    async reset({ projectId, target, mode }) {
      const root = requireRoot(projectId);
      // Whitelist mode — never trust raw input as a git CLI flag.
      const flag =
        mode === 'soft' ? '--soft' : mode === 'hard' ? '--hard' : '--mixed';
      return runAsResult(root, 'git', ['reset', flag, target]);
    },

    async revert({ projectId, commit, noCommit }) {
      const root = requireRoot(projectId);
      const args = ['revert'];
      if (noCommit) args.push('--no-commit');
      args.push(commit);
      return runAsResult(root, 'git', args);
    },

    async cherryPick({ projectId, commits, noCommit }) {
      const root = requireRoot(projectId);
      if (commits.length === 0) {
        throw new ApiError('bad_input', 400, 'cherryPick requires at least one commit');
      }
      const args = ['cherry-pick'];
      if (noCommit) args.push('--no-commit');
      for (const c of commits) args.push(c);
      return runAsResult(root, 'git', args);
    },

    // ─── Remote sync (push / fetch / pull) ───────────────────────
    // These all surface as GitRunResult instead of throwing so the UI
    // can render "non-zero exit but here's the helpful stderr" — git's
    // failure messages on push/pull are rich (rejected fast-forward,
    // diverged branches, suggested next steps).
    async push({ projectId, remote, branch, force, setUpstream }) {
      const root = requireRoot(projectId);
      const args = ['push'];
      // --force-with-lease is the safe variant: rejects when the
      // remote moved since we last fetched. Never expose plain --force
      // from the UI — that's a footgun behind a button.
      if (force) args.push('--force-with-lease');
      if (setUpstream) args.push('-u');
      if (remote) args.push(remote);
      if (branch) args.push(branch);
      return runAsResult(root, 'git', args);
    },

    async fetch({ projectId, remote, prune }) {
      const root = requireRoot(projectId);
      const args = ['fetch'];
      if (prune) args.push('--prune');
      if (remote) args.push(remote);
      // No remote arg → `git fetch` fetches the current branch's upstream
      // (or all configured remotes when there's no upstream). Matches
      // JetBrains "Update Project" intuition.
      return runAsResult(root, 'git', args);
    },

    async pull({ projectId, remote, branch, rebase }) {
      const root = requireRoot(projectId);
      const args = ['pull'];
      if (rebase) args.push('--rebase');
      if (remote) args.push(remote);
      if (branch) args.push(branch);
      return runAsResult(root, 'git', args);
    },

    // ─── Stash (list / save / pop / apply / drop / show) ─────────
    // Parse `stash list` via `--format` so we get tab-separated fields
    // without scraping the freeform default output. The auto-generated
    // message follows "WIP on <branch>: <sha> <subject>" — we extract
    // the branch portion when present.
    async stashList({ projectId }) {
      const root = requireRoot(projectId);
      // %gd = stash ref (stash@{0}), %h = short sha, %gs = full message,
      // %cI = committer date (iso-strict). \x1f as field separator.
      const fmt = '%gd%x1f%h%x1f%cI%x1f%gs';
      const r = await runGit(root, ['stash', 'list', `--format=${fmt}`]);
      if (r.code !== 0) {
        throw new ApiError(
          'git_stash_list_failed',
          500,
          r.stderr.trim() || 'git stash list failed',
        );
      }
      const entries: GitStashEntry[] = [];
      for (const line of r.stdout.split('\n').filter(Boolean)) {
        const [index, shortSha, date, message] = line.split('\x1f');
        if (!index) continue;
        // Auto-generated stash messages start with "WIP on <branch>: ..."
        // or "On <branch>: <user message>". Strip the prefix for the
        // branch column so the UI doesn't redundantly show it.
        let branch: string | null = null;
        const m = message?.match(/^(?:WIP on|On)\s+([^:]+):/);
        if (m) branch = m[1].trim();
        entries.push({
          index,
          shortSha: shortSha ?? '',
          branch,
          message: message ?? '',
          date: date ?? '',
        });
      }
      return entries;
    },

    async stashSave({ projectId, message, includeUntracked, keepIndex }) {
      const root = requireRoot(projectId);
      // `stash push` is the modern form; `save` is deprecated. `-u`
      // includes untracked, `--keep-index` leaves staged changes alone.
      const args = ['stash', 'push'];
      if (includeUntracked) args.push('-u');
      if (keepIndex) args.push('--keep-index');
      if (message) args.push('-m', message);
      return runAsResult(root, 'git', args);
    },

    async stashPop({ projectId, ref }) {
      if (!ref) {
        throw new ApiError('bad_input', 400, 'ref required (e.g. stash@{0})');
      }
      const root = requireRoot(projectId);
      return runAsResult(root, 'git', ['stash', 'pop', ref]);
    },

    async stashApply({ projectId, ref }) {
      if (!ref) {
        throw new ApiError('bad_input', 400, 'ref required (e.g. stash@{0})');
      }
      const root = requireRoot(projectId);
      return runAsResult(root, 'git', ['stash', 'apply', ref]);
    },

    async stashDrop({ projectId, ref }) {
      if (!ref) {
        throw new ApiError('bad_input', 400, 'ref required (e.g. stash@{0})');
      }
      const root = requireRoot(projectId);
      return runAsResult(root, 'git', ['stash', 'drop', ref]);
    },

    async stashShow({ projectId, ref }) {
      if (!ref) {
        throw new ApiError('bad_input', 400, 'ref required (e.g. stash@{0})');
      }
      const root = requireRoot(projectId);
      // `-p` emits a unified diff. Skips the index-summary at the top
      // that the default `stash show` produces.
      const r = await runGit(root, ['stash', 'show', '-p', '--no-color', ref]);
      if (r.code !== 0 && !r.stdout) {
        throw new ApiError(
          'git_stash_show_failed',
          500,
          r.stderr.trim() || 'git stash show failed',
        );
      }
      return { patch: r.stdout };
    },

    async stashDetail({ projectId, ref }) {
      if (!ref) throw new ApiError('bad_input', 400, 'ref required (e.g. stash@{0})');
      const root = requireRoot(projectId);
      // A stash IS a commit object, so `git show -s` reads its metadata.
      // %s is the stash subject ("WIP on <branch>: <sha> <subject>").
      const meta = await runGit(root, ['show', '-s', '--format=%h%x1f%cI%x1f%s', '--date=iso-strict', ref]);
      if (meta.code !== 0) {
        throw new ApiError('git_stash_show_failed', 500, meta.stderr.trim() || 'git show failed');
      }
      const [shortSha, date, message] = meta.stdout.trim().split('\x1f');
      const m = message?.match(/^(?:WIP on|On)\s+([^:]+):/);
      const files = await collectChangedFiles(root, (flag) => ['stash', 'show', flag, ref]);
      return {
        ref,
        shortSha: shortSha ?? '',
        branch: m ? m[1].trim() : null,
        message: message ?? '',
        date: date ?? '',
        files,
      };
    },

    async stashFileDiff({ projectId, ref, path }) {
      if (!ref) throw new ApiError('bad_input', 400, 'ref required (e.g. stash@{0})');
      const root = requireRoot(projectId);
      // `git stash show` rejects a `-- <path>` pathspec ("too many
      // revisions"). A stash IS a commit whose first parent is the base
      // it was taken from, so diffing base→stash for one path gives the
      // same per-file patch `stash show` would, but path-scoped.
      const r = await runGit(root, ['diff', '--no-color', `${ref}^1`, ref, '--', path]);
      if (r.code !== 0 && !r.stdout) {
        throw new ApiError('git_stash_show_failed', 500, r.stderr.trim() || 'git diff failed');
      }
      return { patch: r.stdout };
    },

    // ─── AI-assisted git ─────────────────────────────────────────
    async aiPlan({ projectId, intent }) {
      const root = requireRoot(projectId);
      const cleaned = intent.trim().slice(0, 2000);
      if (!cleaned) {
        throw new ApiError('bad_input', 400, 'intent text required');
      }
      // Gather lightweight context so the AI can plan against the real
      // repo state (current branch, recent branches, last few commits).
      const [curRes, branchRes, logRes] = await Promise.all([
        runGit(root, ['branch', '--show-current']),
        runGit(root, ['for-each-ref', '--count=20', '--sort=-committerdate',
                       '--format=%(refname:short)', 'refs/heads', 'refs/remotes']),
        runGit(root, ['log', '-n8', '--pretty=format:%h %s']),
      ]);
      const ctx = {
        currentBranch: curRes.stdout.trim(),
        recentBranches: branchRes.stdout.split('\n').filter(Boolean).slice(0, 20),
        recentCommits: logRes.stdout.split('\n').filter(Boolean).slice(0, 8),
      };
      const { plan } = await generateAiPlan(deps, intent, ctx);
      return plan;
    },

    async aiExecute({ projectId, steps }) {
      const root = requireRoot(projectId);
      const results: GitRunResult[] = [];
      let aborted = false;
      for (const step of steps) {
        // Hard-validate the command on every step — the steps come
        // from the renderer (which got them from the AI), so we must
        // never trust the field at face value. ONLY allow `git`.
        if (step.command !== 'git') {
          results.push({
            command: step.command,
            args: step.args,
            ok: false,
            code: -1,
            stdout: '',
            stderr: `refused: only \`git\` commands are allowed (got \`${step.command}\`)`,
          });
          aborted = true;
          break;
        }
        const safeArgs = Array.isArray(step.args) ? step.args.filter((a) => typeof a === 'string') : [];
        const r = await runGit(root, safeArgs);
        results.push({
          command: 'git',
          args: safeArgs,
          ok: r.code === 0,
          code: r.code,
          stdout: r.stdout,
          stderr: r.stderr,
        });
        if (r.code !== 0) {
          aborted = true;
          break;
        }
      }
      return { results, aborted };
    },

    async aiCommitMessage({ projectId }) {
      const root = requireRoot(projectId);
      const d = await runGit(root, ['diff', '--cached', '--no-color']);
      const diff = d.stdout.trim();
      if (!diff) {
        throw new ApiError('nothing_staged', 400, 'No staged changes — stage files first.');
      }
      // Cap the diff so a huge changeset doesn't blow the model's context.
      const MAX_DIFF = 12_000;
      const clipped =
        diff.length > MAX_DIFF
          ? `${diff.slice(0, MAX_DIFF)}\n\n[... truncated, ${diff.length - MAX_DIFF} more chars]`
          : diff;
      const system =
        'You write git commit messages. Output ONLY the message text — no ' +
        'preamble, no markdown fences, no surrounding quotes.';
      const user =
        'Write a Conventional-Commits-style commit message for the staged diff below.\n' +
        'Rules:\n' +
        '- First line: type(scope): short summary, <=72 chars, imperative mood.\n' +
        '- Optional body: blank line, then wrap at ~100 chars, explain WHY not WHAT.\n' +
        '- No trailing punctuation on the subject line.\n\n' +
        '--- STAGED DIFF ---\n' +
        clipped;
      const res = await callGeneralAiJson(deps, { system, user, maxTokens: 400 });
      if ('refusal' in res) {
        // callGeneralAiJson folds both "no provider configured" and "the
        // call threw" into a refusal string. Map the former to 412 (the UI
        // points the user at Admin → AI Geral); a runtime failure is 502.
        const notConfigured = /no usable ai provider|no enabled models|config missing/i.test(
          res.refusal,
        );
        throw new ApiError(
          notConfigured ? 'general_ai_unavailable' : 'general_ai_failed',
          notConfigured ? 412 : 502,
          res.refusal,
        );
      }
      // Models occasionally wrap output in fences/quotes despite the
      // instruction — strip them defensively before handing to the UI.
      const message = res.raw
        .trim()
        .replace(/^```(?:\w+)?\s*/i, '')
        .replace(/```\s*$/i, '')
        .replace(/^["']|["']$/g, '')
        .trim();
      return { message };
    },
  };

  // Conflict-resolution methods live in their own module to keep this
  // god-file from growing further. They're injected with the same spawn
  // helpers + repo resolver so there's a single source of truth for how
  // we shell out to git.
  return {
    ...base,
    ...createConflictHandlers({ runGit, runAsResult, requireRoot, detectRepo }),
  };
}

/**
 * Helper — execute a git command and shape it as GitRunResult instead
 * of throwing. Used by merge/reset/revert/cherry-pick so the UI can
 * surface "non-zero exit but here's what stderr says" without losing
 * information (the failure path in git is rich — conflict markers,
 * suggested next steps, etc.).
 */
async function runAsResult(
  cwd: string,
  _cmd: 'git',
  args: string[],
  env?: Record<string, string>,
): Promise<GitRunResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      env: env ? { ...process.env, ...env } : process.env,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (e) => {
      resolve({
        command: 'git', args, ok: false, code: -1, stdout: '',
        stderr: (e as Error).message,
      });
    });
    child.on('close', (code) => {
      resolve({
        command: 'git',
        args,
        ok: code === 0,
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
    child.stdin.end();
  });
}

/**
 * Drive the project's "general AI" provider to produce a git plan.
 *
 * The prompt asks for STRICT JSON to keep parsing robust — temperature
 * is 0 to minimise drift. On parse failure we surface a refusal in the
 * plan so the user gets an actionable message instead of a 500.
 *
 * Provider selection mirrors the generate-title route: prefer
 * `getGeneralDefault()`, then fall through to any anthropic/openai/
 * openrouter/zai/deepseek provider with an api_key. OAuth-only kinds aren't usable
 * by the SDKs here.
 */
async function generateAiPlan(
  deps: HandlerDeps,
  intent: string,
  ctx: { currentBranch: string; recentBranches: string[]; recentCommits: string[] },
): Promise<{ plan: GitPlan }> {
  const { providerStore } = deps;
  const isUsable = (p: { kind?: string; api_key?: string | null; enabled?: boolean } | null) => {
    if (!p?.enabled || !p.api_key) return false;
    const k = p.kind ?? '';
    return k === 'anthropic' || k === 'openai' || k === 'openrouter' || k === 'zai' || k === 'deepseek';
  };

  const def = providerStore.getGeneralDefault();
  let cfg = def ? providerStore.getProvider(def.providerId) : null;
  let modelId = def?.modelId ?? '';
  if (!isUsable(cfg) || !modelId) {
    const fallback = providerStore.listProviders({ enabled: true }).find(isUsable);
    if (!fallback) {
      return {
        plan: {
          intent,
          steps: [],
          summary: '',
          refusal: 'No usable AI provider — set an API key for Anthropic / OpenAI / Z.AI / DeepSeek in Configurações → Providers.',
        },
      };
    }
    cfg = fallback;
    const first = providerStore.listModels(fallback.id, true)[0];
    modelId = first?.model_id ?? '';
    if (!modelId) {
      return {
        plan: { intent, steps: [], summary: '', refusal: 'Fallback provider has no enabled models.' },
      };
    }
  }
  if (!cfg) {
    return { plan: { intent, steps: [], summary: '', refusal: 'Provider config missing after selection.' } };
  }

  // Strip ::mode the dashboard appends so the SDK sees a bare model id.
  let modelMode: string | undefined;
  if (modelId.includes('::')) {
    [modelId, modelMode] = modelId.split('::', 2);
  }
  // Z.AI routing precedence — same order as generate-title:
  //   1. ZAI_BASE_URL env  2. ::coding/::general suffix  3. cfg.base_url  4. general default
  let baseUrl: string | undefined = cfg.base_url ?? undefined;
  if (cfg.kind === 'zai') {
    if (process.env.ZAI_BASE_URL) {
      baseUrl = process.env.ZAI_BASE_URL;
    } else if (modelMode === 'coding') {
      baseUrl = 'https://api.z.ai/api/coding/paas/v4/';
    } else if (modelMode === 'general') {
      baseUrl = 'https://api.z.ai/api/paas/v4/';
    } else if (!baseUrl) {
      baseUrl = 'https://api.z.ai/api/paas/v4/';
    }
  } else if (cfg.kind === 'openrouter' && !baseUrl) {
    baseUrl = 'https://openrouter.ai/api/v1';
  }

  const system = `You are a git expert wired into an IDE. The user describes what they want; you produce a JSON plan of git commands to execute. NEVER execute or assume — your sole job is to plan.

Rules:
- ALWAYS return a single JSON object matching this TypeScript shape:
  { summary: string; steps: { command: 'git'; args: string[]; description: string; dangerous: boolean }[]; refusal?: string }
- Every step's "command" is literally the string "git". Put the subcommand and flags into "args".
- Mark a step "dangerous": true when it could destroy work (reset --hard, branch -D, push --force, clean -fd, filter-branch, rebase -i).
- If the intent is unclear, ambiguous, or unsafe, return { summary: "", steps: [], refusal: "<why>" }.
- Keep step descriptions short, in the user's language when possible.
- Never include shell metacharacters (|, &, ;, $(...)); each arg must be a literal string.
- Prefer fast-forward merges when the user just says "merge X into Y" without specifics.
- For "switch to / change branch", use \`switch\` (or \`checkout\` if the user said it).

Output ONLY the JSON object. No markdown, no prose.`;

  const userMsg = `Repo context:
  current branch: ${ctx.currentBranch || '(detached)'}
  recent branches: ${ctx.recentBranches.join(', ') || '(none)'}
  recent commits:
${ctx.recentCommits.map((l) => `    ${l}`).join('\n') || '    (no commits)'}

User intent:
${intent}`;

  let raw = '';
  try {
    if (cfg.kind === 'anthropic') {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: cfg.api_key ?? '', ...(baseUrl ? { baseURL: baseUrl } : {}) });
      const resp = await client.messages.create({
        model: modelId,
        max_tokens: 800,
        system,
        messages: [{ role: 'user', content: userMsg }],
      });
      raw = resp.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
    } else {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: cfg.api_key ?? '', ...(baseUrl ? { baseURL: baseUrl } : {}) });
      const resp = await client.chat.completions.create({
        model: modelId,
        max_tokens: 800,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userMsg },
        ],
      });
      raw = resp.choices[0]?.message?.content ?? '';
    }
  } catch (e) {
    console.warn(`[git-aiPlan] provider=${cfg.kind} model=${modelId} failed:`, e);
    return {
      plan: { intent, steps: [], summary: '', refusal: `AI call failed: ${e instanceof Error ? e.message : String(e)}` },
    };
  }

  // Models sometimes wrap JSON in ```json fences despite our "no
  // markdown" instruction. Strip them defensively before parsing.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as {
      summary?: string;
      refusal?: string;
      steps?: Array<{ command?: string; args?: string[]; description?: string; dangerous?: boolean }>;
    };
    const steps: GitPlanStep[] = Array.isArray(parsed.steps)
      ? parsed.steps
          .filter((s) => s && s.command === 'git' && Array.isArray(s.args))
          .map((s) => ({
            command: 'git',
            args: (s.args ?? []).filter((a): a is string => typeof a === 'string'),
            description: typeof s.description === 'string' ? s.description : '',
            dangerous: !!s.dangerous,
          }))
      : [];
    return {
      plan: {
        intent,
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
        steps,
        refusal: typeof parsed.refusal === 'string' && parsed.refusal ? parsed.refusal : undefined,
      },
    };
  } catch {
    return {
      plan: {
        intent,
        steps: [],
        summary: '',
        refusal: `AI returned unparseable JSON. Raw response: ${cleaned.slice(0, 200)}`,
      },
    };
  }
}
