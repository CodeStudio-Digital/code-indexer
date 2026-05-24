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
import { ApiError, type ProjectGitApi, type GitStatusFile } from '@mcp/api-bus';
import type { HandlerDeps } from '../types.js';

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[], stdin?: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, windowsHide: true });
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
    if (stdin) {
      child.stdin.write(stdin);
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

  return {
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

    async log({ projectId, limit = 30, path }) {
      const root = requireRoot(projectId);
      const fmt = '%H%x1f%h%x1f%an%x1f%ad%x1f%s';
      const args = ['log', `--pretty=format:${fmt}`, '--date=iso-strict', `-n${limit}`];
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
  };
}
