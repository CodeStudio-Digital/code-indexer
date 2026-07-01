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
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import {
  ApiError,
  type ProjectGitApi,
  type GitStatus,
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
import { nativeFetch } from '@mcp/shared/utils/native-fetch.js';
import { createConflictHandlers } from './conflicts.js';
import { createGitOptimizationHandlers } from './git-optimizations.js';
import { createRepoResolver } from './repos.js';
import { selectHunks } from './hunk-stage.js';

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface GitRunOptions {
  stdin?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const GIT_READ_TIMEOUT_MS = Number(process.env.MCP_GIT_READ_TIMEOUT_MS ?? 15_000);
const GIT_SUMMARY_TIMEOUT_MS = Number(process.env.MCP_GIT_SUMMARY_TIMEOUT_MS ?? 3_000);
// Only auto-enable git fsmonitor/untrackedCache for repos whose `git status`
// took longer than this — fast/small repos never get a persistent daemon.
const GIT_AUTO_OPTIMIZE_SLOW_MS = Number(process.env.MCP_GIT_AUTO_OPTIMIZE_SLOW_MS ?? 3_000);
// Bound network ops (fetch/pull) so an unreachable remote can't hang the UI
// forever — git itself has no default timeout here.
const GIT_NETWORK_TIMEOUT_MS = Number(process.env.MCP_GIT_NETWORK_TIMEOUT_MS ?? 30_000);
const GIT_STATUS_MAX_OUTPUT_BYTES = Number(process.env.MCP_GIT_STATUS_MAX_OUTPUT_BYTES ?? 24 * 1024 * 1024);
// How many repos to `git status` in parallel for the aggregate (explorer) view.
const GIT_AGG_CONCURRENCY = Number(process.env.MCP_GIT_AGG_CONCURRENCY ?? 4);
const GIT_LIST_MAX_OUTPUT_BYTES = Number(process.env.MCP_GIT_LIST_MAX_OUTPUT_BYTES ?? 8 * 1024 * 1024);
const GIT_DETAIL_MAX_OUTPUT_BYTES = Number(process.env.MCP_GIT_DETAIL_MAX_OUTPUT_BYTES ?? 32 * 1024 * 1024);

function throwGitReadFailure(operation: string, result: GitResult, fallback: string): never {
  const message = result.stderr.trim() || fallback;
  if (/timed out/i.test(message)) {
    throw new ApiError(`${operation}_timeout`, 504, message);
  }
  if (/output exceeded/i.test(message)) {
    throw new ApiError(`${operation}_output_too_large`, 413, message);
  }
  throw new ApiError(`${operation}_failed`, 500, message);
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
  optsOrStdin?: string | GitRunOptions,
): Promise<GitResult> {
  const opts = typeof optsOrStdin === 'string' ? { stdin: optsOrStdin } : (optsOrStdin ?? {});
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let outputTooLarge = false;
    let outputBytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const finish = (result: GitResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const collect = (target: Buffer[], chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (opts.maxOutputBytes && outputBytes > opts.maxOutputBytes) {
        outputTooLarge = true;
        child.kill();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(out, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(err, chunk));
    child.on('error', (e) => {
      finish({ code: -1, stdout: '', stderr: (e as Error).message });
    });
    child.on('close', (code) => {
      if (timedOut) {
        finish({ code: -1, stdout: '', stderr: `git ${args[0] ?? ''} timed out after ${opts.timeoutMs}ms` });
        return;
      }
      if (outputTooLarge) {
        finish({ code: -1, stdout: '', stderr: `git output exceeded ${opts.maxOutputBytes} bytes` });
        return;
      }
      finish({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, opts.timeoutMs);
      timer.unref?.();
    }
    if (opts.stdin) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

function interpretStatusChar(c: string): GitStatusFile['state'] | null {
  switch (c) {
    case 'M': return 'modified';
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case '?': return 'untracked';
    case '!': return 'ignored';
    case 'U': return 'unmerged';
    case '.':
    case ' ': return null;
    default: return null;
  }
}

function appendStatusEntries(entries: GitStatusFile[], xy: string, path: string): void {
  if (!path) return;
  const stagedState = interpretStatusChar(xy[0] ?? '.');
  if (stagedState && stagedState !== 'untracked' && stagedState !== 'ignored') {
    entries.push({ path, state: stagedState, staged: true });
  }
  const wtState = interpretStatusChar(xy[1] ?? '.');
  if (wtState) {
    entries.push({ path, state: wtState, staged: false });
  }
}

/**
 * Parse `git status --porcelain=v2 --branch -z` once for both branch
 * headers and file rows. V2 avoids the old two-command v1+v2 split and
 * keeps rename/copy paths unquoted under `-z`.
 */
function parsePorcelainV2Status(out: string): {
  head: { branch: string | null; upstream: string | null; ahead: number; behind: number };
  files: GitStatusFile[];
} {
  const files: GitStatusFile[] = [];
  const records = out.split('\0');
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r) continue;
    if (r.startsWith('# branch.')) continue;
    if (r.startsWith('1 ')) {
      const parts = r.split(' ');
      appendStatusEntries(files, parts[1] ?? '..', parts.slice(8).join(' '));
      continue;
    }
    if (r.startsWith('2 ')) {
      const parts = r.split(' ');
      appendStatusEntries(files, parts[1] ?? '..', parts.slice(9).join(' '));
      i += 1; // old path for rename/copy
      continue;
    }
    if (r.startsWith('u ')) {
      const parts = r.split(' ');
      appendStatusEntries(files, parts[1] ?? 'UU', parts.slice(10).join(' '));
      continue;
    }
    if (r.startsWith('? ')) {
      files.push({ path: r.slice(2), state: 'untracked', staged: false });
      continue;
    }
    if (r.startsWith('! ')) {
      files.push({ path: r.slice(2), state: 'ignored', staged: false });
    }
  }
  return { head: parseHeadBranchInfo(out), files };
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

async function readHeadSummary(cwd: string): Promise<{
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}> {
  // branch + upstream are independent lookups — fire both at once, then the
  // ahead/behind rev-list (which needs the upstream ref) runs only if present.
  const [branchRes, upstreamRes] = await Promise.all([
    runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: GIT_SUMMARY_TIMEOUT_MS }),
    runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
      timeoutMs: GIT_SUMMARY_TIMEOUT_MS,
    }),
  ]);
  const branch = branchRes.code === 0 ? branchRes.stdout.trim() || null : null;
  const upstream = upstreamRes.code === 0 ? upstreamRes.stdout.trim() || null : null;
  if (!upstream) return { branch, upstream: null, ahead: 0, behind: 0 };

  const abRes = await runGit(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], {
    timeoutMs: GIT_SUMMARY_TIMEOUT_MS,
  });
  if (abRes.code !== 0) return { branch, upstream, ahead: 0, behind: 0 };
  const [aheadRaw, behindRaw] = abRes.stdout.trim().split(/\s+/);
  return {
    branch,
    upstream,
    ahead: Number(aheadRaw) || 0,
    behind: Number(behindRaw) || 0,
  };
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

  const numstat = await runGit(cwd, argsWith('--numstat'), {
    timeoutMs: GIT_READ_TIMEOUT_MS,
    maxOutputBytes: GIT_DETAIL_MAX_OUTPUT_BYTES,
  });
  if (numstat.code !== 0) {
    throwGitReadFailure('git_changed_files', numstat, 'git changed files failed');
  }
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

  const nameStatus = await runGit(cwd, argsWith('--name-status'), {
    timeoutMs: GIT_READ_TIMEOUT_MS,
    maxOutputBytes: GIT_DETAIL_MAX_OUTPUT_BYTES,
  });
  if (nameStatus.code !== 0) {
    throwGitReadFailure('git_changed_files', nameStatus, 'git changed files failed');
  }
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

/** Run `fn` over `items` with a bounded number in flight at once. Order of the
 *  returned array matches `items`; a failing `fn` rejects the whole pool. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, worker));
  return out;
}

/** POSIX path of `to` relative to `from`. */
function posixRel(from: string, to: string): string {
  return path.relative(from, to).replace(/\\/g, '/');
}

export function createProjectGitHandlers(deps: HandlerDeps): ProjectGitApi {
  const { db } = deps;
  const statusInflight = new Map<string, Promise<GitStatus>>();

  function requireRoot(projectId: number): string {
    const project = db.getProject(projectId);
    if (!project) throw new ApiError('not_found', 404, 'project not found');
    return project.root_path;
  }

  // repoRoot + absolute gitDir are stable for a fixed root_path across a
  // session (branch checkout / commit don't move them), yet resolving them
  // costs a ~8-10s git spawn on heavy repos — a tax EVERY method paid first.
  // Cache positives with a short TTL so a burst of reloads shares one lookup
  // while bounding staleness against the rare external `.git` swap; negatives
  // are never cached so a later `git init` is still picked up.
  const REPO_CACHE_MS = Number(process.env.MCP_GIT_REPO_CACHE_MS ?? 30_000);
  const repoRootCache = new Map<string, { repoRoot: string; gitDir: string; at: number }>();
  // branchesDetailed is the heavy one on big repos (for-each-ref over 100s of
  // refs + per-ref ahead/behind). Cache its result per (project, includeRemote,
  // git-revision) so reopening the branch list is instant; a ref change bumps
  // the caller's gitRev and recomputes. One live entry per (project,scope).
  const branchesCache = new Map<string, GitBranch[]>();

  async function detectRepo(
    root: string,
  ): Promise<{ repoRoot: string | null; gitDir: string | null; notARepo: boolean }> {
    const cached = repoRootCache.get(root);
    if (cached && Date.now() - cached.at < REPO_CACHE_MS) {
      return { repoRoot: cached.repoRoot, gitDir: cached.gitDir, notARepo: false };
    }
    // One spawn yields BOTH the worktree root and the resolved absolute gitdir.
    // --absolute-git-dir follows the `.git` FILE of linked worktrees/submodules,
    // which is what lets the sequencer detection read state files via pure fs.
    const r = await runGit(root, ['rev-parse', '--show-toplevel', '--absolute-git-dir'], {
      timeoutMs: GIT_READ_TIMEOUT_MS,
    });
    if (r.code !== 0) return { repoRoot: null, gitDir: null, notARepo: true };
    const [repoRoot = '', gitDir = ''] = r.stdout.split('\n').map((s) => s.trim());
    if (!repoRoot) return { repoRoot: null, gitDir: null, notARepo: true };
    repoRootCache.set(root, { repoRoot, gitDir, at: Date.now() });
    return { repoRoot, gitDir, notARepo: false };
  }

  // Multi-repo resolver: discovers submodules / nested repos and resolves which
  // root a call targets. `resolveCwd` validates an explicit `repoPath` selection
  // (the Git tool window always sends one) against the discovered set and falls
  // back to the project's main repo when omitted.
  const repoResolver = createRepoResolver({ runGit, requireRoot, detectRepo });
  const resolveCwd = repoResolver.resolveCwd;

  // Path-scoped auto-routing (explorer / editor): with NO explicit repo selected,
  // resolve which discovered repo CONTAINS a project-relative path and run there
  // with the path rebased repo-relative — so a file inside a submodule gets its
  // baseline/diff/stage from the SUBMODULE, not the opaque parent gitlink. With
  // an explicit repoPath the path is already relative to that repo (the Git tool
  // window's single-repo view), so it's used verbatim.
  async function resolvePathTarget(
    projectId: number,
    repoPath: string | undefined,
    projectRelPath: string,
  ): Promise<{ cwd: string; gitPath: string }> {
    if (repoPath) return { cwd: await resolveCwd(projectId, repoPath), gitPath: projectRelPath };
    const { cwd, repoRelPath } = await repoResolver.resolveRepoForPath(projectId, projectRelPath);
    return { cwd, gitPath: repoRelPath };
  }

  // Group project-relative paths by containing repo so a bulk stage/unstage/
  // discard runs one git invocation per repo with repo-relative paths.
  async function groupPathsByRepo(projectId: number, paths: string[]): Promise<Map<string, string[]>> {
    const groups = new Map<string, string[]>();
    for (const p of paths) {
      const { cwd, repoRelPath } = await repoResolver.resolveRepoForPath(projectId, p);
      const arr = groups.get(cwd);
      if (arr) arr.push(repoRelPath);
      else groups.set(cwd, [repoRelPath]);
    }
    return groups;
  }

  // Git accelerators (fsmonitor/untrackedCache). Created once so `readStatus`
  // can also auto-enable them per repo on first status (ensureAutoOptimized).
  const gitOpt = createGitOptimizationHandlers({ runGit, resolveCwd });

  // Aggregate working-tree status across EVERY git root in the project — the
  // main repo plus its initialized submodules and non-ignored nested repos. Each
  // repo's `git status` runs at its own root and its file paths are rebased to
  // project-relative (so the explorer can color files INSIDE a submodule, which
  // the parent only reports as one opaque gitlink). The parent's gitlink entry
  // for every DISCOVERED repo root is suppressed to avoid double-reporting; files
  // outside the project subtree (when the main repo is an ancestor of a nested
  // project) are clamped out. Discovery is single-level — a submodule nested
  // inside another submodule isn't expanded, so its parent's opaque entry stays.
  async function aggregateStatus(projectId: number): Promise<GitStatus> {
    // Canonicalize the project root so per-file rebasing lines up with the
    // realpath'd repo roots discovery resolved (see repos.ts).
    let projectRoot = requireRoot(projectId);
    try {
      projectRoot = await realpath(projectRoot);
    } catch {
      /* keep raw root */
    }
    const repos = await repoResolver.listRepos(projectId);
    if (repos.length === 0) {
      return { branch: null, upstream: null, ahead: 0, behind: 0, files: [], repoRoot: null, notARepo: true };
    }
    const main = repos.find((r) => r.kind === 'main') ?? repos[0];
    const scan = repos.filter(
      (r) => r.kind === 'main' || (r.initialized && !(r.kind === 'nested' && r.ignoredByParent)),
    );
    // Suppress the parent's single gitlink entry for any discovered repo root.
    const repoPrefixes = new Set(repos.map((r) => r.projectRelPrefix).filter(Boolean));

    const perRepo = await mapPool(scan, GIT_AGG_CONCURRENCY, async (r) => {
      const res = await runGit(r.absPath, ['status', '--porcelain=v2', '--branch', '-z'], {
        timeoutMs: GIT_READ_TIMEOUT_MS,
        maxOutputBytes: GIT_STATUS_MAX_OUTPUT_BYTES,
      });
      // Tolerate a single repo failing (transient lock / race) — the rest render.
      if (res.code !== 0) return { repo: r, files: [] as GitStatusFile[] };
      return { repo: r, files: parsePorcelainV2Status(res.stdout).files };
    });

    const files: GitStatusFile[] = [];
    for (const { repo, files: repoFiles } of perRepo) {
      for (const f of repoFiles) {
        const projRel = posixRel(projectRoot, path.resolve(repo.absPath, f.path));
        if (projRel.startsWith('..') || path.isAbsolute(projRel)) continue; // outside the project
        if (repoPrefixes.has(projRel)) continue; // a discovered repo's gitlink → already detailed
        files.push({ path: projRel, state: f.state, staged: f.staged, repo: repo.projectRelPrefix || undefined });
      }
    }
    // Branch / ahead-behind come from the repo that contains the project root.
    const head = await readHeadSummary(main.absPath);
    return { ...head, files, repoRoot: main.absPath, notARepo: false };
  }

  async function readStatus(projectId: number, includeFiles: boolean, repoPath?: string): Promise<GitStatus> {
    // No explicit repo selected + a full file list requested (the explorer /
    // status bar) → the project-wide aggregate. An explicit repoPath (the Git
    // tool window) or a summary-only read takes the single-repo path below.
    if (!repoPath && includeFiles) return aggregateStatus(projectId);
    const root = await resolveCwd(projectId, repoPath);
    const { repoRoot, notARepo } = await detectRepo(root);
    if (notARepo) {
      return {
        branch: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        ...(includeFiles ? { files: [] } : {}),
        repoRoot: null,
        notARepo: true,
      };
    }
    const cwd = repoRoot ?? root;
    if (!includeFiles) {
      return {
        ...(await readHeadSummary(cwd)),
        repoRoot: cwd,
        notARepo: false,
      };
    }
    const startedAt = Date.now();
    const statusRes = await runGit(cwd, ['status', '--porcelain=v2', '--branch', '-z'], {
      timeoutMs: GIT_READ_TIMEOUT_MS,
      maxOutputBytes: GIT_STATUS_MAX_OUTPUT_BYTES,
    });
    if (statusRes.code !== 0) {
      throwGitReadFailure('git_status', statusRes, 'git status failed');
    }
    // Warm fsmonitor/untrackedCache only for repos whose status was actually
    // slow (large / cold) so small repos never get a persistent daemon.
    // Fire-and-forget — never adds latency; once-per-repo guarded inside.
    if (Date.now() - startedAt > GIT_AUTO_OPTIMIZE_SLOW_MS) void gitOpt.ensureAutoOptimized(cwd);
    const { head, files } = parsePorcelainV2Status(statusRes.stdout);
    return {
      ...head,
      files,
      repoRoot: cwd,
      notARepo: false,
    };
  }

  function statusSingleFlight(projectId: number, includeFiles: boolean, repoPath?: string): Promise<GitStatus> {
    const key = `${projectId}:${includeFiles ? 'full' : 'summary'}:${repoPath ?? ''}`;
    const existing = statusInflight.get(key);
    if (existing) return existing;
    const promise = readStatus(projectId, includeFiles, repoPath).finally(() => {
      statusInflight.delete(key);
    });
    statusInflight.set(key, promise);
    return promise;
  }

  const base: Omit<
    ProjectGitApi,
    | 'mergeState'
    | 'conflictFile'
    | 'resolveConflict'
    | 'mergeContinue'
    | 'mergeAbort'
    | 'gitOptimizations'
    | 'configureGitOptimizations'
  > = {
    async listRepos({ projectId }) {
      return repoResolver.listRepos(projectId);
    },

    async status({ projectId, includeFiles = true, repoPath }) {
      return statusSingleFlight(projectId, includeFiles !== false, repoPath);
    },

    async detectRemote({ projectId, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      const { repoRoot, notARepo } = await detectRepo(root);
      if (notARepo) return { gitRemote: null, defaultBranch: null };
      const cwd = repoRoot ?? root;
      const remoteRes = await runGit(cwd, ['remote', 'get-url', 'origin'], { timeoutMs: GIT_SUMMARY_TIMEOUT_MS });
      const gitRemote = remoteRes.code === 0 ? remoteRes.stdout.trim() || null : null;
      // origin/HEAD ("origin/main") is set on clone; fall back to the current branch.
      let defaultBranch: string | null = null;
      const headRes = await runGit(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { timeoutMs: GIT_SUMMARY_TIMEOUT_MS });
      if (headRes.code === 0) {
        const v = headRes.stdout.trim();
        defaultBranch = v.includes('/') ? v.split('/').slice(1).join('/') : v || null;
      }
      if (!defaultBranch) {
        const curRes = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: GIT_SUMMARY_TIMEOUT_MS });
        if (curRes.code === 0) {
          const b = curRes.stdout.trim();
          if (b && b !== 'HEAD') defaultBranch = b;
        }
      }
      return { gitRemote, defaultBranch };
    },

    async diff({ projectId, path: filePath, staged, repoPath }) {
      // A path-scoped diff auto-routes to its containing repo (submodule-aware);
      // a whole-repo diff (no path) uses the selected/main repo.
      const target = filePath
        ? await resolvePathTarget(projectId, repoPath, filePath)
        : { cwd: await resolveCwd(projectId, repoPath), gitPath: undefined as string | undefined };
      const args = ['diff', '--no-color'];
      if (staged) args.push('--cached');
      if (target.gitPath) args.push('--', target.gitPath);
      const r = await runGit(target.cwd, args, {
        timeoutMs: GIT_READ_TIMEOUT_MS,
        maxOutputBytes: GIT_DETAIL_MAX_OUTPUT_BYTES,
      });
      if (r.code !== 0 && !r.stdout) {
        throwGitReadFailure('git_diff', r, 'git diff failed');
      }
      return { patch: r.stdout };
    },

    async baseline({ projectId, path: filePath, repoPath }) {
      // Route to the repo that CONTAINS the file (submodule-aware) so a file
      // inside a submodule reads its baseline from the submodule's HEAD — the
      // parent only has an opaque gitlink, which `HEAD:./` would silently
      // misresolve (empty → whole file painted as added).
      const { cwd, gitPath } = await resolvePathTarget(projectId, repoPath, filePath);
      // Distinguish "not a repo" (no markers) from "new file in a repo" (whole
      // file is added). detectRepo is cached, so this is cheap.
      const { notARepo } = await detectRepo(cwd);
      if (notARepo) return { content: null, isRepo: false };
      // `HEAD:./<gitPath>` resolves relative to the containing repo's root.
      // Non-zero → the file isn't at HEAD yet (new / untracked) → empty baseline.
      const r = await runGit(cwd, ['show', `HEAD:./${gitPath}`], {
        timeoutMs: GIT_READ_TIMEOUT_MS,
        maxOutputBytes: GIT_DETAIL_MAX_OUTPUT_BYTES,
      });
      if (r.code !== 0) return { content: null, isRepo: true };
      return { content: r.stdout, isRepo: true };
    },

    async stageHunk({ projectId, path: filePath, newStart, newEnd, repoPath }) {
      const { cwd, gitPath } = await resolvePathTarget(projectId, repoPath, filePath);
      // Diff the on-disk working tree against the index in the CONTAINING repo;
      // the caller flushes the buffer first so the new side matches the editor.
      // `--recount` lets git re-derive line numbers after we drop non-overlaps.
      const diffRes = await runGit(cwd, ['diff', '--no-color', '-U3', '--', gitPath], {
        timeoutMs: GIT_READ_TIMEOUT_MS,
        maxOutputBytes: GIT_DETAIL_MAX_OUTPUT_BYTES,
      });
      if (diffRes.code !== 0 && !diffRes.stdout) {
        throwGitReadFailure('git_diff', diffRes, 'git diff failed');
      }
      const patch = selectHunks(diffRes.stdout, newStart, newEnd);
      if (!patch) throw new ApiError('stage_hunk_empty', 409, 'no stageable changes in this block');
      const applyRes = await runGit(cwd, ['apply', '--cached', '--recount', '--whitespace=nowarn'], {
        stdin: patch,
        timeoutMs: GIT_READ_TIMEOUT_MS,
      });
      if (applyRes.code !== 0) {
        throw new ApiError('stage_hunk_failed', 409, applyRes.stderr.trim() || 'git apply failed');
      }
      // Return the repo we staged in so a follow-up "commit this block" targets
      // the SAME repo (a submodule, not the opaque parent).
      return { ok: true as const, repoPath: cwd };
    },

    async branchDiff({ projectId, branch, worktree, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      // worktree → branch vs the working tree ("Show diff with working tree");
      // else the symmetric three-dot diff from the merge-base ("Compare with
      // current"), so it shows exactly what `branch` carries relative to HEAD.
      const args = worktree
        ? ['diff', '--no-color', branch]
        : ['diff', '--no-color', `HEAD...${branch}`];
      const r = await runGit(root, args, {
        timeoutMs: GIT_READ_TIMEOUT_MS,
        maxOutputBytes: GIT_DETAIL_MAX_OUTPUT_BYTES,
      });
      if (r.code !== 0 && !r.stdout) {
        throwGitReadFailure('git_branch_diff', r, 'git diff failed');
      }
      return { patch: r.stdout };
    },

    async log({ projectId, limit = 30, path, branch, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      const fmt = '%H%x1f%h%x1f%an%x1f%ad%x1f%s';
      const args = ['log', `--pretty=format:${fmt}`, '--date=iso-strict', `-n${limit}`];
      // Branch filter ALWAYS goes BEFORE the `--` separator. Treating
      // it as a single ref is intentional — the renderer drives a
      // dropdown that emits exact branch names, so we don't need glob
      // expansion (which would also let users `git log --all` here).
      if (branch) args.push(branch);
      if (path) args.push('--', path);
      const r = await runGit(root, args, {
        timeoutMs: GIT_READ_TIMEOUT_MS,
        maxOutputBytes: GIT_LIST_MAX_OUTPUT_BYTES,
      });
      if (r.code !== 0) {
        throwGitReadFailure('git_log', r, 'git log failed');
      }
      return r.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, shortSha, author, date, subject] = line.split('\x1f');
          return { sha, shortSha, author, date, subject };
        });
    },

    async commitDetail({ projectId, sha, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      // Metadata in one pass. `%P` (parents) is space-separated; `%b`
      // (body) can contain anything including our separator, so it's
      // fetched in a second `-s` call where it's the whole output.
      const metaFmt = '%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%P%x1f%s';
      const meta = await runGit(root, ['show', '-s', `--format=${metaFmt}`, '--date=iso-strict', sha], {
        timeoutMs: GIT_READ_TIMEOUT_MS,
        maxOutputBytes: GIT_LIST_MAX_OUTPUT_BYTES,
      });
      if (meta.code !== 0) {
        throwGitReadFailure('git_show', meta, 'git show failed');
      }
      const [fullSha, shortSha, author, authorEmail, date, parentStr, subject] =
        meta.stdout.trim().split('\x1f');
      const bodyRes = await runGit(root, ['show', '-s', '--format=%b', sha], {
        timeoutMs: GIT_READ_TIMEOUT_MS,
        maxOutputBytes: GIT_DETAIL_MAX_OUTPUT_BYTES,
      });
      if (bodyRes.code !== 0) {
        throwGitReadFailure('git_show', bodyRes, 'git show failed');
      }
      const body = bodyRes.stdout.replace(/\s+$/, '');
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

    async commitFileDiff({ projectId, sha, path, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      // Empty `--format=` strips the commit header so we return only the
      // unified patch — matches the shape `diff` returns.
      const r = await runGit(root, ['show', '--no-color', '--format=', sha, '--', path], {
        timeoutMs: GIT_READ_TIMEOUT_MS,
        maxOutputBytes: GIT_DETAIL_MAX_OUTPUT_BYTES,
      });
      if (r.code !== 0 && !r.stdout) {
        throwGitReadFailure('git_show', r, 'git show failed');
      }
      return { patch: r.stdout };
    },

    async stage({ projectId, paths, repoPath }) {
      if (paths.length === 0) return { ok: true as const };
      // Explicit repo (Git window) → paths are repo-relative, one call. No
      // repoPath (explorer) → project-relative paths grouped by containing repo.
      const groups = repoPath
        ? new Map([[await resolveCwd(projectId, repoPath), paths]])
        : await groupPathsByRepo(projectId, paths);
      for (const [cwd, gitPaths] of groups) {
        const r = await runGit(cwd, ['add', '--', ...gitPaths]);
        if (r.code !== 0) throw new ApiError('git_stage_failed', 500, r.stderr.trim() || 'git add failed');
      }
      return { ok: true as const };
    },

    async unstage({ projectId, paths, repoPath }) {
      if (paths.length === 0) return { ok: true as const };
      const groups = repoPath
        ? new Map([[await resolveCwd(projectId, repoPath), paths]])
        : await groupPathsByRepo(projectId, paths);
      for (const [cwd, gitPaths] of groups) {
        const r = await runGit(cwd, ['restore', '--staged', '--', ...gitPaths]);
        if (r.code !== 0) throw new ApiError('git_unstage_failed', 500, r.stderr.trim() || 'git restore --staged failed');
      }
      return { ok: true as const };
    },

    async discard({ projectId, paths, repoPath }) {
      if (paths.length === 0) return { ok: true as const };
      const groups = repoPath
        ? new Map([[await resolveCwd(projectId, repoPath), paths]])
        : await groupPathsByRepo(projectId, paths);
      for (const [cwd, gitPaths] of groups) {
        const r = await runGit(cwd, ['checkout', '--', ...gitPaths]);
        if (r.code !== 0) throw new ApiError('git_discard_failed', 500, r.stderr.trim() || 'git checkout failed');
      }
      return { ok: true as const };
    },

    async commit({ projectId, message, amend, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
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

    async branchList({ projectId, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      const cur = (await runGit(root, ['branch', '--show-current'])).stdout.trim() || null;
      const all = (await runGit(root, ['branch', '--list', '--format=%(refname:short)']))
        .stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      return { current: cur, all };
    },

    async branchCheckout({ projectId, name, create, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      const args = create ? ['checkout', '-b', name] : ['checkout', name];
      const r = await runGit(root, args);
      if (r.code !== 0) {
        throw new ApiError('git_checkout_failed', 500, r.stderr.trim() || 'git checkout failed');
      }
      return { ok: true as const };
    },

    // ─── Branches (rich) ─────────────────────────────────────────
    async branchesDetailed({ projectId, includeRemote, rev, repoPath }) {
      const withRemote = includeRemote !== false;
      // Serve from cache when the caller pins a git-revision and nothing moved.
      // repoPath is part of the scope (before rev) so the cleanup prefix below
      // isolates per-repo entries.
      const cacheKey = rev !== undefined ? `${projectId}:${withRemote}:${repoPath ?? ''}:${rev}` : null;
      if (cacheKey) {
        const hit = branchesCache.get(cacheKey);
        if (hit) return hit;
      }
      const root = await resolveCwd(projectId, repoPath);
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
      if (withRemote) refs.push('refs/remotes');
      const r = await runGit(root, ['for-each-ref', `--format=${fmt}`, ...refs], {
        timeoutMs: GIT_READ_TIMEOUT_MS,
        maxOutputBytes: GIT_LIST_MAX_OUTPUT_BYTES,
      });
      if (r.code !== 0) {
        throwGitReadFailure('git_branch_list', r, 'for-each-ref failed');
      }
      // No separate `branch --show-current` spawn: for-each-ref already marks
      // the checked-out branch with %(HEAD)='*' (field 1). On detached HEAD no
      // ref carries '*', so every branch is correctly non-current — identical
      // to what the removed command returned.
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
          isCurrent: head === '*',
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
      if (cacheKey) {
        branchesCache.set(cacheKey, branches);
        // Keep only the latest rev per (project, scope, repo) — older revs are stale.
        for (const k of branchesCache.keys()) {
          if (k !== cacheKey && k.startsWith(`${projectId}:${withRemote}:${repoPath ?? ''}:`)) branchesCache.delete(k);
        }
      }
      return branches;
    },

    async branchCreate({ projectId, name, from, checkout, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      const args = checkout ? ['checkout', '-b', name] : ['branch', name];
      if (from) args.push(from);
      const r = await runGit(root, args);
      if (r.code !== 0) {
        throw new ApiError('git_branch_create_failed', 500, r.stderr.trim() || 'git branch failed');
      }
      return { ok: true as const };
    },

    async branchDelete({ projectId, name, force, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      // -D (force) merges -d's safety check + force-delete; -d alone
      // refuses to delete branches not fully merged into HEAD.
      const args = ['branch', force ? '-D' : '-d', name];
      const r = await runGit(root, args);
      if (r.code !== 0) {
        throw new ApiError('git_branch_delete_failed', 500, r.stderr.trim() || 'git branch -d failed');
      }
      return { ok: true as const };
    },

    async branchRename({ projectId, oldName, newName, force, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      const args = ['branch', force ? '-M' : '-m', oldName, newName];
      const r = await runGit(root, args);
      if (r.code !== 0) {
        throw new ApiError('git_branch_rename_failed', 500, r.stderr.trim() || 'git branch -m failed');
      }
      return { ok: true as const };
    },

    // ─── Merge / reset / revert / cherry-pick ────────────────────
    async merge({ projectId, branch, ffOnly, noFf, message, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      const args = ['merge'];
      if (ffOnly) args.push('--ff-only');
      if (noFf) args.push('--no-ff');
      if (message) args.push('-m', message);
      args.push(branch);
      return runAsResult(root, 'git', args);
    },

    async reset({ projectId, target, mode, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      // Whitelist mode — never trust raw input as a git CLI flag.
      const flag =
        mode === 'soft' ? '--soft' : mode === 'hard' ? '--hard' : '--mixed';
      return runAsResult(root, 'git', ['reset', flag, target]);
    },

    async revert({ projectId, commit, noCommit, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      const args = ['revert'];
      if (noCommit) args.push('--no-commit');
      args.push(commit);
      return runAsResult(root, 'git', args);
    },

    async cherryPick({ projectId, commits, noCommit, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      if (commits.length === 0) {
        throw new ApiError('bad_input', 400, 'cherryPick requires at least one commit');
      }
      const args = ['cherry-pick'];
      if (noCommit) args.push('--no-commit');
      for (const c of commits) args.push(c);
      return runAsResult(root, 'git', args);
    },

    async rebase({ projectId, onto, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      // Non-interactive: suppress the editor (todo list + commit message) so a
      // rebase can never block on it. A conflict stops the rebase and is picked
      // up by mergeState (kind 'rebase') — the resolver + continue/abort flow
      // already handle it, exactly like a conflicting cherry-pick.
      return runAsResult(root, 'git', ['-c', 'core.editor=true', 'rebase', onto], {
        GIT_EDITOR: 'true',
        GIT_SEQUENCE_EDITOR: 'true',
      });
    },

    // ─── Remote sync (push / fetch / pull) ───────────────────────
    // These all surface as GitRunResult instead of throwing so the UI
    // can render "non-zero exit but here's the helpful stderr" — git's
    // failure messages on push/pull are rich (rejected fast-forward,
    // diverged branches, suggested next steps).
    async push({ projectId, remote, branch, force, setUpstream, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
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

    async fetch({ projectId, remote, prune, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      const args = ['fetch'];
      if (prune) args.push('--prune');
      if (remote) args.push(remote);
      // No remote arg → `git fetch` fetches the current branch's upstream
      // (or all configured remotes when there's no upstream). Matches
      // JetBrains "Update Project" intuition.
      return runAsResult(root, 'git', args, undefined, GIT_NETWORK_TIMEOUT_MS);
    },

    async pull({ projectId, remote, branch, rebase, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      const args = ['pull'];
      if (rebase) args.push('--rebase');
      if (remote) args.push(remote);
      if (branch) args.push(branch);
      return runAsResult(root, 'git', args, undefined, GIT_NETWORK_TIMEOUT_MS);
    },

    async updateBranch({ projectId, branch, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      // The branch's configured upstream, e.g. "origin/feature/x".
      const up = await runGit(root, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], {
        timeoutMs: GIT_READ_TIMEOUT_MS,
      });
      const upstream = up.code === 0 ? up.stdout.trim() : '';
      const slash = upstream.indexOf('/');
      if (slash < 0) {
        return {
          command: 'git', args: ['fetch'], ok: false, code: 1, stdout: '',
          stderr: `'${branch}' has no remote-tracking upstream to update from.`,
        };
      }
      const remote = upstream.slice(0, slash); // origin
      const src = upstream.slice(slash + 1); //   feature/x
      // Fast-forward the LOCAL ref from its upstream without `+`, so git refuses
      // a diverged (non-fast-forward) update instead of clobbering local commits.
      return runAsResult(root, 'git', ['fetch', remote, `${src}:${branch}`], undefined, GIT_NETWORK_TIMEOUT_MS);
    },

    // ─── Stash (list / save / pop / apply / drop / show) ─────────
    // Parse `stash list` via `--format` so we get tab-separated fields
    // without scraping the freeform default output. The auto-generated
    // message follows "WIP on <branch>: <sha> <subject>" — we extract
    // the branch portion when present.
    async stashList({ projectId, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      // %gd = stash ref (stash@{0}), %h = short sha, %gs = full message,
      // %cI = committer date (iso-strict). \x1f as field separator.
      const fmt = '%gd%x1f%h%x1f%cI%x1f%gs';
      const r = await runGit(root, ['stash', 'list', `--format=${fmt}`], {
        timeoutMs: GIT_READ_TIMEOUT_MS,
        maxOutputBytes: GIT_LIST_MAX_OUTPUT_BYTES,
      });
      if (r.code !== 0) {
        throwGitReadFailure('git_stash_list', r, 'git stash list failed');
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

    async stashSave({ projectId, message, includeUntracked, keepIndex, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      // `stash push` is the modern form; `save` is deprecated. `-u`
      // includes untracked, `--keep-index` leaves staged changes alone.
      const args = ['stash', 'push'];
      if (includeUntracked) args.push('-u');
      if (keepIndex) args.push('--keep-index');
      if (message) args.push('-m', message);
      return runAsResult(root, 'git', args);
    },

    async stashPop({ projectId, ref, repoPath }) {
      if (!ref) {
        throw new ApiError('bad_input', 400, 'ref required (e.g. stash@{0})');
      }
      const root = await resolveCwd(projectId, repoPath);
      return runAsResult(root, 'git', ['stash', 'pop', ref]);
    },

    async stashApply({ projectId, ref, repoPath }) {
      if (!ref) {
        throw new ApiError('bad_input', 400, 'ref required (e.g. stash@{0})');
      }
      const root = await resolveCwd(projectId, repoPath);
      return runAsResult(root, 'git', ['stash', 'apply', ref]);
    },

    async stashDrop({ projectId, ref, repoPath }) {
      if (!ref) {
        throw new ApiError('bad_input', 400, 'ref required (e.g. stash@{0})');
      }
      const root = await resolveCwd(projectId, repoPath);
      return runAsResult(root, 'git', ['stash', 'drop', ref]);
    },

    async stashShow({ projectId, ref, repoPath }) {
      if (!ref) {
        throw new ApiError('bad_input', 400, 'ref required (e.g. stash@{0})');
      }
      const root = await resolveCwd(projectId, repoPath);
      // `-p` emits a unified diff. Skips the index-summary at the top
      // that the default `stash show` produces.
      const r = await runGit(root, ['stash', 'show', '-p', '--no-color', ref], {
        timeoutMs: GIT_READ_TIMEOUT_MS,
        maxOutputBytes: GIT_DETAIL_MAX_OUTPUT_BYTES,
      });
      if (r.code !== 0 && !r.stdout) {
        throwGitReadFailure('git_stash_show', r, 'git stash show failed');
      }
      return { patch: r.stdout };
    },

    async stashDetail({ projectId, ref, repoPath }) {
      if (!ref) throw new ApiError('bad_input', 400, 'ref required (e.g. stash@{0})');
      const root = await resolveCwd(projectId, repoPath);
      // A stash IS a commit object, so `git show -s` reads its metadata.
      // %s is the stash subject ("WIP on <branch>: <sha> <subject>").
      const meta = await runGit(root, ['show', '-s', '--format=%h%x1f%cI%x1f%s', '--date=iso-strict', ref], {
        timeoutMs: GIT_READ_TIMEOUT_MS,
        maxOutputBytes: GIT_LIST_MAX_OUTPUT_BYTES,
      });
      if (meta.code !== 0) {
        throwGitReadFailure('git_stash_show', meta, 'git show failed');
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

    async stashFileDiff({ projectId, ref, path, repoPath }) {
      if (!ref) throw new ApiError('bad_input', 400, 'ref required (e.g. stash@{0})');
      const root = await resolveCwd(projectId, repoPath);
      // `git stash show` rejects a `-- <path>` pathspec ("too many
      // revisions"). A stash IS a commit whose first parent is the base
      // it was taken from, so diffing base→stash for one path gives the
      // same per-file patch `stash show` would, but path-scoped.
      const r = await runGit(root, ['diff', '--no-color', `${ref}^1`, ref, '--', path], {
        timeoutMs: GIT_READ_TIMEOUT_MS,
        maxOutputBytes: GIT_DETAIL_MAX_OUTPUT_BYTES,
      });
      if (r.code !== 0 && !r.stdout) {
        throwGitReadFailure('git_stash_show', r, 'git diff failed');
      }
      return { patch: r.stdout };
    },

    // ─── AI-assisted git ─────────────────────────────────────────
    async aiPlan({ projectId, intent, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
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

    async aiExecute({ projectId, steps, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
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

    async aiCommitMessage({ projectId, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
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
    ...createConflictHandlers({ runGit, runAsResult, resolveCwd, detectRepo, resolveRepoForPath: repoResolver.resolveRepoForPath }),
    // Only the two public methods reach the IPC surface — `ensureAutoOptimized`
    // stays internal (called fire-and-forget from readStatus).
    gitOptimizations: gitOpt.gitOptimizations,
    configureGitOptimizations: gitOpt.configureGitOptimizations,
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
  timeoutMs?: number,
): Promise<GitRunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      env: env ? { ...process.env, ...env } : process.env,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const finish = (r: GitRunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    // Optional wall-clock bound (network ops): kill the child and surface a
    // timeout as a non-zero GitRunResult instead of hanging forever.
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill();
        finish({
          command: 'git', args, ok: false, code: -1,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: `git ${args[0] ?? ''} timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);
    }
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (e) =>
      finish({ command: 'git', args, ok: false, code: -1, stdout: '', stderr: (e as Error).message }),
    );
    child.on('close', (code) =>
      finish({
        command: 'git',
        args,
        ok: code === 0,
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
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
      const client = new Anthropic({ apiKey: cfg.api_key ?? '', ...(baseUrl ? { baseURL: baseUrl } : {}), fetch: nativeFetch() });
      const resp = await client.messages.create({
        model: modelId,
        max_tokens: 800,
        system,
        messages: [{ role: 'user', content: userMsg }],
      });
      raw = resp.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
    } else {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: cfg.api_key ?? '', ...(baseUrl ? { baseURL: baseUrl } : {}), fetch: nativeFetch() });
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
