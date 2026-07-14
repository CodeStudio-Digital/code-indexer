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
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { realpath, rm } from 'node:fs/promises';
import {
  ApiError,
  type ProjectGitApi,
  type GitStatus,
  type GitStatusFile,
  type GitCommit,
  type GitCommitFileChange,
  type GitBranch,
  type GitRunResult,
  type GitStashEntry,
  type GitPlan,
  type GitPlanStep,
  type GitPlanOperation,
  type GitPlanRisk,
  type GitWorkspaceSnapshot,
} from '@mcp/api-bus';
import type { HandlerDeps } from '../types.js';
import { callGeneralAiJson, stripJsonFences } from '../aiJson.js';
import { durationToBucket } from '@mcp/store/pipeline-telemetry-store.js';
import { createConflictHandlers } from './conflicts.js';
import { createGitOptimizationHandlers } from './git-optimizations.js';
import { createRepoResolver } from './repos.js';
import { selectHunks } from './hunk-stage.js';
import { guardProjectGitApi, recordGitCacheDecision, recordGitProcess } from './guard.js';

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs?: number;
  timedOut?: boolean;
  truncated?: boolean;
  errorCode?: GitRunResult['errorCode'];
}

interface GitRunOptions {
  stdin?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  profile?: 'read' | 'mutation' | 'network';
}

const GIT_READ_TIMEOUT_MS = Number(process.env.MCP_GIT_READ_TIMEOUT_MS ?? 15_000);
const GIT_SUMMARY_TIMEOUT_MS = Number(process.env.MCP_GIT_SUMMARY_TIMEOUT_MS ?? 3_000);
const GIT_MUTATION_TIMEOUT_MS = Number(process.env.MCP_GIT_MUTATION_TIMEOUT_MS ?? 60_000);
// Bound network ops (fetch/pull) so an unreachable remote can't hang the UI
// forever — git itself has no default timeout here.
const GIT_NETWORK_TIMEOUT_MS = Number(process.env.MCP_GIT_NETWORK_TIMEOUT_MS ?? 30_000);
const GIT_STATUS_MAX_OUTPUT_BYTES = Number(process.env.MCP_GIT_STATUS_MAX_OUTPUT_BYTES ?? 24 * 1024 * 1024);
// How many repos to `git status` in parallel for the aggregate (explorer) view.
const GIT_AGG_CONCURRENCY = Number(process.env.MCP_GIT_AGG_CONCURRENCY ?? 4);
const GIT_LIST_MAX_OUTPUT_BYTES = Number(process.env.MCP_GIT_LIST_MAX_OUTPUT_BYTES ?? 8 * 1024 * 1024);
const GIT_DETAIL_MAX_OUTPUT_BYTES = Number(process.env.MCP_GIT_DETAIL_MAX_OUTPUT_BYTES ?? 32 * 1024 * 1024);

const GIT_ENV_BLOCKLIST = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_CEILING_DIRECTORIES',
]);

function safeGitEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (GIT_ENV_BLOCKLIST.has(key) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key) || key === 'GIT_CONFIG_COUNT') continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (!GIT_ENV_BLOCKLIST.has(key) && !/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key) && key !== 'GIT_CONFIG_COUNT') {
      env[key] = value;
    }
  }
  return env;
}

function terminateProcessTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.unref();
    return;
  }
  child.kill('SIGTERM');
  const hardKill = setTimeout(() => child.kill('SIGKILL'), 1_000);
  hardKill.unref?.();
}

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
    const startedAt = Date.now();
    const timeoutMs = opts.timeoutMs ?? (opts.profile === 'network' ? GIT_NETWORK_TIMEOUT_MS : opts.profile === 'read' ? GIT_READ_TIMEOUT_MS : GIT_MUTATION_TIMEOUT_MS);
    const maxOutputBytes = opts.maxOutputBytes ?? GIT_DETAIL_MAX_OUTPUT_BYTES;
    let settled = false;
    let timedOut = false;
    let outputTooLarge = false;
    let outputBytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      env: safeGitEnv({ ...(opts.profile === 'network' ? { GIT_TERMINAL_PROMPT: '0' } : {}), ...opts.env }),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const finish = (result: GitResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      recordGitProcess({
        outputBytes: Buffer.byteLength(result.stdout, 'utf8') + Buffer.byteLength(result.stderr, 'utf8'),
        timedOut: result.timedOut,
        truncated: result.truncated,
      });
      resolve(result);
    };
    const collect = (target: Buffer[], chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (maxOutputBytes && outputBytes > maxOutputBytes) {
        outputTooLarge = true;
        terminateProcessTree(child);
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(out, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(err, chunk));
    child.on('error', (e) => {
      finish({ code: -1, stdout: '', stderr: (e as Error).message, durationMs: Date.now() - startedAt, errorCode: 'spawn_failed' });
    });
    child.on('close', (code) => {
      if (timedOut) {
        finish({ code: -1, stdout: '', stderr: `git ${args[0] ?? ''} timed out after ${timeoutMs}ms`, durationMs: Date.now() - startedAt, timedOut: true, errorCode: 'timeout' });
        return;
      }
      if (outputTooLarge) {
        finish({ code: -1, stdout: '', stderr: `git output exceeded ${maxOutputBytes} bytes`, durationMs: Date.now() - startedAt, truncated: true, errorCode: 'output_too_large' });
        return;
      }
      finish({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        durationMs: Date.now() - startedAt,
        ...(code === 0 ? {} : { errorCode: 'git_failed' as const }),
      });
    });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child);
      }, timeoutMs);
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

function appendStatusEntries(entries: GitStatusFile[], xy: string, path: string, oldPath?: string): void {
  if (!path) return;
  const stagedState = interpretStatusChar(xy[0] ?? '.');
  if (stagedState && stagedState !== 'untracked' && stagedState !== 'ignored') {
    entries.push({ path, oldPath, state: stagedState, staged: true });
  }
  const wtState = interpretStatusChar(xy[1] ?? '.');
  if (wtState) {
    entries.push({ path, oldPath, state: wtState, staged: false });
  }
}

/**
 * Parse `git status --porcelain=v2 --branch -z` once for both branch
 * headers and file rows. V2 avoids the old two-command v1+v2 split and
 * keeps rename/copy paths unquoted under `-z`.
 */
export function parsePorcelainV2Status(out: string): {
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
      const oldPath = records[i + 1] || undefined;
      appendStatusEntries(files, parts[1] ?? '..', parts.slice(9).join(' '), oldPath);
      i += 1;
      continue;
    }
    if (r.startsWith('u ')) {
      const parts = r.split(' ');
      const conflictPath = parts.slice(10).join(' ');
      if (conflictPath) files.push({ path: conflictPath, state: 'unmerged', staged: false });
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

/**
 * Build a changed-file list by merging `--name-status` (authoritative
 * status + rename old/new paths) with `--numstat` (per-file add/remove
 * counts, keyed by the new path). Both streams use NUL delimiters so spaces,
 * tabs, Unicode and newlines in file names remain unambiguous.
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

  const [numstat, nameStatus] = await Promise.all([
    runGit(cwd, [...argsWith('--numstat'), '-z'], {
      timeoutMs: GIT_READ_TIMEOUT_MS,
      maxOutputBytes: GIT_DETAIL_MAX_OUTPUT_BYTES,
    }),
    runGit(cwd, [...argsWith('--name-status'), '-z'], {
      timeoutMs: GIT_READ_TIMEOUT_MS,
      maxOutputBytes: GIT_DETAIL_MAX_OUTPUT_BYTES,
    }),
  ]);
  if (numstat.code !== 0) {
    throwGitReadFailure('git_changed_files', numstat, 'git changed files failed');
  }
  const counts = new Map<string, { additions: number; deletions: number }>();
  const numRecords = numstat.stdout.split('\0');
  for (let i = 0; i < numRecords.length; i += 1) {
    const record = numRecords[i];
    if (!record) continue;
    const firstTab = record.indexOf('\t');
    const secondTab = firstTab < 0 ? -1 : record.indexOf('\t', firstTab + 1);
    if (secondTab < 0) continue;
    const adds = record.slice(0, firstTab);
    const dels = record.slice(firstTab + 1, secondTab);
    let filePath = record.slice(secondTab + 1);
    if (!filePath) {
      i += 1; // pre-image path
      filePath = numRecords[++i] ?? ''; // post-image path
    }
    if (!filePath) continue;
    counts.set(filePath, {
      additions: adds === '-' ? 0 : Number(adds) || 0,
      deletions: dels === '-' ? 0 : Number(dels) || 0,
    });
  }

  if (nameStatus.code !== 0) {
    throwGitReadFailure('git_changed_files', nameStatus, 'git changed files failed');
  }
  const files: GitCommitFileChange[] = [];
  const nameRecords = nameStatus.stdout.split('\0');
  for (let i = 0; i < nameRecords.length; i += 1) {
    const code = nameRecords[i];
    if (!code) continue;
    const state = mapState(code);
    let filePath: string;
    let oldPath: string | undefined;
    if (state === 'renamed' || state === 'copied') {
      oldPath = nameRecords[++i] ?? '';
      filePath = nameRecords[++i] ?? '';
    } else {
      filePath = nameRecords[++i] ?? '';
    }
    if (!filePath) continue;
    const c = counts.get(filePath) ?? { additions: 0, deletions: 0 };
    files.push({ path: filePath, oldPath, state, additions: c.additions, deletions: c.deletions });
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

function parseGitLog(out: string): GitCommit[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, shortSha, author, date, subject, parentStr = '', refStr = ''] = line.split('\x1f');
      return {
        sha,
        shortSha,
        author,
        date,
        subject,
        parents: parentStr.trim() ? parentStr.trim().split(/\s+/) : [],
        refs: refStr.trim() ? refStr.split(',').map((ref) => ref.trim()).filter(Boolean) : [],
      };
    });
}

function asText(value: unknown, max = 1_024): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
    ? value
    : undefined;
}

function normalizeAiOperation(value: unknown): GitPlanOperation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const op = asText(v.op, 40);
  const bool = (key: string) => v[key] === true ? true : undefined;
  switch (op) {
    case 'branchCheckout': {
      const name = asText(v.name); return name ? { op, name, create: bool('create') } : null;
    }
    case 'branchCreate': {
      const name = asText(v.name); if (!name) return null;
      return { op, name, ...(asText(v.from) ? { from: asText(v.from) } : {}), checkout: bool('checkout') };
    }
    case 'branchRename': {
      const oldName = asText(v.oldName); const newName = asText(v.newName);
      return oldName && newName ? { op, oldName, newName, force: bool('force') } : null;
    }
    case 'branchDelete': {
      const name = asText(v.name); return name ? { op, name, force: bool('force') } : null;
    }
    case 'merge': {
      const branch = asText(v.branch); if (!branch) return null;
      const strategy = v.strategy === 'ff-only' || v.strategy === 'no-ff' ? v.strategy : 'default';
      return { op, branch, strategy };
    }
    case 'rebase': {
      const onto = asText(v.onto); return onto ? { op, onto } : null;
    }
    case 'reset': {
      const target = asText(v.target);
      const mode = v.mode === 'soft' || v.mode === 'mixed' || v.mode === 'hard' ? v.mode : null;
      return target && mode ? { op, target, mode } : null;
    }
    case 'revert': {
      const commit = asText(v.commit); return commit ? { op, commit, noCommit: bool('noCommit') } : null;
    }
    case 'cherryPick': {
      const commits = Array.isArray(v.commits) ? v.commits.map((item) => asText(item)).filter((item): item is string => !!item).slice(0, 100) : [];
      return commits.length > 0 ? { op, commits, noCommit: bool('noCommit') } : null;
    }
    case 'push':
      return { op, ...(asText(v.remote) ? { remote: asText(v.remote) } : {}), ...(asText(v.branch) ? { branch: asText(v.branch) } : {}), force: bool('force'), setUpstream: bool('setUpstream') };
    case 'fetch':
      return { op, ...(asText(v.remote) ? { remote: asText(v.remote) } : {}), prune: bool('prune') };
    case 'pull':
      return { op, ...(asText(v.remote) ? { remote: asText(v.remote) } : {}), ...(asText(v.branch) ? { branch: asText(v.branch) } : {}), rebase: bool('rebase') };
    case 'stashSave':
      return { op, ...(asText(v.message, 10_000) ? { message: asText(v.message, 10_000) } : {}), includeUntracked: bool('includeUntracked'), keepIndex: bool('keepIndex') };
    case 'stashPop':
    case 'stashApply':
    case 'stashDrop': {
      const ref = asText(v.ref); return ref ? { op, ref } : null;
    }
    default:
      return null;
  }
}

function operationRisk(operation: GitPlanOperation): GitPlanRisk {
  if (
    (operation.op === 'reset' && operation.mode === 'hard') ||
    (operation.op === 'branchDelete' && operation.force) ||
    (operation.op === 'branchRename' && operation.force) ||
    (operation.op === 'push' && operation.force) ||
    operation.op === 'stashDrop'
  ) return 'destructive';
  return 'mutating';
}

function buildOperation(operation: GitPlanOperation): {
  args: string[];
  env?: Record<string, string>;
  profile?: 'mutation' | 'network';
} {
  switch (operation.op) {
    case 'branchCheckout': return { args: operation.create ? ['checkout', '-b', operation.name] : ['checkout', operation.name] };
    case 'branchCreate': return { args: [...(operation.checkout ? ['checkout', '-b'] : ['branch']), operation.name, ...(operation.from ? [operation.from] : [])] };
    case 'branchRename': return { args: ['branch', operation.force ? '-M' : '-m', operation.oldName, operation.newName] };
    case 'branchDelete': return { args: ['branch', operation.force ? '-D' : '-d', operation.name] };
    case 'merge': return { args: ['merge', ...(operation.strategy === 'ff-only' ? ['--ff-only'] : operation.strategy === 'no-ff' ? ['--no-ff'] : []), operation.branch] };
    case 'rebase': return { args: ['rebase', operation.onto], env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' } };
    case 'reset': return { args: ['reset', `--${operation.mode}`, operation.target] };
    case 'revert': return { args: ['revert', ...(operation.noCommit ? ['--no-commit'] : []), operation.commit] };
    case 'cherryPick': return { args: ['cherry-pick', ...(operation.noCommit ? ['--no-commit'] : []), ...operation.commits] };
    case 'push': return { args: ['push', ...(operation.force ? ['--force-with-lease'] : []), ...(operation.setUpstream ? ['-u'] : []), ...(operation.remote ? [operation.remote] : []), ...(operation.branch ? [operation.branch] : [])], profile: 'network' };
    case 'fetch': return { args: ['fetch', ...(operation.prune ? ['--prune'] : []), ...(operation.remote ? [operation.remote] : [])], profile: 'network' };
    case 'pull': return { args: ['pull', ...(operation.rebase ? ['--rebase'] : []), ...(operation.remote ? [operation.remote] : []), ...(operation.branch ? [operation.branch] : [])], profile: 'network' };
    case 'stashSave': return { args: ['stash', 'push', ...(operation.includeUntracked ? ['-u'] : []), ...(operation.keepIndex ? ['--keep-index'] : []), ...(operation.message ? ['-m', operation.message] : [])] };
    case 'stashPop': return { args: ['stash', 'pop', operation.ref] };
    case 'stashApply': return { args: ['stash', 'apply', operation.ref] };
    case 'stashDrop': return { args: ['stash', 'drop', operation.ref] };
  }
}

function commandPreview(operation: GitPlanOperation): string {
  const quote = (arg: string) => /^[\w./:@{}+-]+$/.test(arg) ? arg : JSON.stringify(arg);
  return `git ${buildOperation(operation).args.map(quote).join(' ')}`;
}

export function createProjectGitHandlers(deps: HandlerDeps): ProjectGitApi {
  const { db } = deps;
  const statusInflight = new Map<string, Promise<GitStatus>>();
  const STATUS_SNAPSHOT_TTL_MS = Number(process.env.MCP_GIT_STATUS_SNAPSHOT_TTL_MS ?? 30_000);
  const statusSnapshots = new Map<string, {
    projectId: number;
    repoPath?: string;
    status: GitStatus & { files: GitStatusFile[] };
    createdAt: number;
    elapsedMs: number;
  }>();
  const AI_PLAN_TTL_MS = Number(process.env.MCP_GIT_AI_PLAN_TTL_MS ?? 5 * 60_000);
  const aiPlans = new Map<string, {
    projectId: number;
    repoPath?: string;
    expiresAt: number;
    steps: GitPlanStep[];
  }>();
  const LOG_SNAPSHOT_TTL_MS = Number(process.env.MCP_GIT_LOG_SNAPSHOT_TTL_MS ?? 5 * 60_000);
  const logSnapshots = new Map<string, {
    projectId: number;
    repoPath?: string;
    root: string;
    refs: string[];
    path?: string;
    branch?: string;
    all: boolean;
    createdAt: number;
  }>();

  function requireRoot(projectId: number): string {
    const project = db.getProject(projectId);
    if (!project) throw new ApiError('not_found', 404, 'project not found');
    return project.root_path;
  }

  // repoRoot + absolute gitDir are stable for a fixed root_path across a
  // session (branch checkout / commit don't move them), yet resolving them
  // costs an extra git spawn on heavy repos — a tax every method paid first.
  // Cache positives with a short TTL so a burst of reloads shares one lookup
  // while bounding staleness against the rare external `.git` swap; negatives
  // are never cached so a later `git init` is still picked up.
  const REPO_CACHE_MS = Number(process.env.MCP_GIT_REPO_CACHE_MS ?? 30_000);
  const repoRootCache = new Map<string, { repoRoot: string; gitDir: string; at: number }>();
  const repoCacheKey = (value: string) => {
    const resolved = path.resolve(value).replace(/\\/g, '/');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  // branchesDetailed is the heavy one on big repos (for-each-ref over 100s of
  // refs + per-ref ahead/behind). Cache its result per (project, includeRemote,
  // git-revision) so reopening the branch list is instant; a ref change bumps
  // the caller's gitRev and recomputes. One live entry per (project,scope).
  const branchesCache = new Map<string, GitBranch[]>();

  async function detectRepo(
    root: string,
  ): Promise<{ repoRoot: string | null; gitDir: string | null; notARepo: boolean }> {
    const key = repoCacheKey(root);
    const cached = repoRootCache.get(key);
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
    const value = { repoRoot, gitDir, at: Date.now() };
    repoRootCache.set(key, value);
    repoRootCache.set(repoCacheKey(repoRoot), value);
    return { repoRoot, gitDir, notARepo: false };
  }

  // Multi-repo resolver: discovers submodules / nested repos and resolves which
  // root a call targets. `resolveCwd` validates an explicit `repoPath` selection
  // (the Git tool window always sends one) against the discovered set and falls
  // back to the project's main repo when omitted.
  const repoResolver = createRepoResolver({ runGit, requireRoot, detectRepo });
  const resolveCwd = repoResolver.resolveCwd;

  async function ensureBranchName(cwd: string, name: string): Promise<void> {
    const result = await runGit(cwd, ['check-ref-format', '--branch', name], { profile: 'read' });
    if (result.code !== 0) throw new ApiError('git_branch_invalid', 400, `invalid branch name: ${name}`);
  }

  async function ensureCommitRef(cwd: string, ref: string): Promise<void> {
    const result = await runGit(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { profile: 'read' });
    if (result.code !== 0) throw new ApiError('git_ref_invalid', 400, `unknown commit reference: ${ref}`);
  }

  async function ensureLocalBranch(cwd: string, name: string): Promise<void> {
    await ensureBranchName(cwd, name);
    const result = await runGit(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { profile: 'read' });
    if (result.code !== 0) throw new ApiError('git_branch_not_found', 404, `local branch not found: ${name}`);
  }

  async function ensureRemote(cwd: string, remote: string | undefined): Promise<void> {
    if (!remote) return;
    const result = await runGit(cwd, ['remote'], { profile: 'read' });
    const remotes = result.code === 0 ? result.stdout.split('\n').map((item) => item.trim()).filter(Boolean) : [];
    if (!remotes.includes(remote)) throw new ApiError('git_remote_not_found', 404, `remote not found: ${remote}`);
  }

  async function ensureStash(cwd: string, ref: string): Promise<void> {
    if (!/^stash@\{\d+\}$/.test(ref)) throw new ApiError('git_stash_invalid', 400, 'invalid stash reference');
    const result = await runGit(cwd, ['stash', 'list', '--format=%gd'], { profile: 'read' });
    const stashes = result.code === 0 ? result.stdout.split('\n').map((item) => item.trim()).filter(Boolean) : [];
    if (!stashes.includes(ref)) throw new ApiError('git_stash_not_found', 404, `stash not found: ${ref}`);
  }

  async function validateOperation(cwd: string, operation: GitPlanOperation): Promise<void> {
    switch (operation.op) {
      case 'branchCheckout':
        if (operation.create) await ensureBranchName(cwd, operation.name);
        else await ensureCommitRef(cwd, operation.name);
        return;
      case 'branchCreate':
        await ensureBranchName(cwd, operation.name);
        if (operation.from) await ensureCommitRef(cwd, operation.from);
        return;
      case 'branchRename':
        await ensureLocalBranch(cwd, operation.oldName);
        await ensureBranchName(cwd, operation.newName);
        return;
      case 'branchDelete': await ensureLocalBranch(cwd, operation.name); return;
      case 'merge': await ensureCommitRef(cwd, operation.branch); return;
      case 'rebase': await ensureCommitRef(cwd, operation.onto); return;
      case 'reset': await ensureCommitRef(cwd, operation.target); return;
      case 'revert': await ensureCommitRef(cwd, operation.commit); return;
      case 'cherryPick': for (const ref of operation.commits) await ensureCommitRef(cwd, ref); return;
      case 'push':
        await ensureRemote(cwd, operation.remote);
        if (operation.branch) await ensureCommitRef(cwd, operation.branch);
        return;
      case 'fetch': await ensureRemote(cwd, operation.remote); return;
      case 'pull':
        await ensureRemote(cwd, operation.remote);
        if (operation.branch) await ensureBranchName(cwd, operation.branch);
        return;
      case 'stashPop':
      case 'stashApply':
      case 'stashDrop': await ensureStash(cwd, operation.ref); return;
      case 'stashSave': return;
    }
  }

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

  // Git accelerators are opt-in only. Slow status reads return a recommendation
  // through statusPage; configuration changes require an explicit UI action.
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
      if (res.code !== 0) {
        return { repo: r, files: [] as GitStatusFile[], head: null, warning: `${r.name}: ${res.stderr.trim() || 'git status failed'}` };
      }
      const parsed = parsePorcelainV2Status(res.stdout);
      return { repo: r, files: parsed.files, head: parsed.head, warning: null };
    });

    const files: GitStatusFile[] = [];
    const partialWarnings: string[] = [];
    for (const { repo, files: repoFiles } of perRepo) {
      for (const f of repoFiles) {
        const projRel = posixRel(projectRoot, path.resolve(repo.absPath, f.path));
        if (projRel.startsWith('..') || path.isAbsolute(projRel)) continue; // outside the project
        if (repoPrefixes.has(projRel)) continue; // a discovered repo's gitlink → already detailed
        files.push({ path: projRel, oldPath: f.oldPath, state: f.state, staged: f.staged, repo: repo.projectRelPrefix || undefined });
      }
    }
    for (const result of perRepo) if (result.warning) partialWarnings.push(result.warning);
    // Reuse the headers already parsed from the main repo's status invocation.
    const head = perRepo.find((entry) => entry.repo.absPath === main.absPath)?.head ?? {
      branch: null, upstream: null, ahead: 0, behind: 0,
    };
    return { ...head, files, repoRoot: main.absPath, notARepo: false, partialWarnings };
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
      // One process supplies branch, upstream and ahead/behind. Suppressing
      // untracked discovery keeps this summary substantially cheaper than the
      // full snapshot while preserving porcelain-v2's authoritative headers.
      const summary = await runGit(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no'], {
        timeoutMs: GIT_SUMMARY_TIMEOUT_MS,
        maxOutputBytes: GIT_STATUS_MAX_OUTPUT_BYTES,
      });
      if (summary.code !== 0) throwGitReadFailure('git_status_summary', summary, 'git status summary failed');
      return {
        ...parseHeadBranchInfo(summary.stdout),
        repoRoot: cwd,
        notARepo: false,
      };
    }
    const statusRes = await runGit(cwd, ['status', '--porcelain=v2', '--branch', '-z'], {
      timeoutMs: GIT_READ_TIMEOUT_MS,
      maxOutputBytes: GIT_STATUS_MAX_OUTPUT_BYTES,
    });
    if (statusRes.code !== 0) {
      throwGitReadFailure('git_status', statusRes, 'git status failed');
    }
    const { head, files } = parsePorcelainV2Status(statusRes.stdout);
    let projectRoot = requireRoot(projectId);
    try { projectRoot = await realpath(projectRoot); } catch { /* keep raw root */ }
    const scopedFiles = files.map((file) => {
      const absolute = path.resolve(cwd, file.path);
      const projectRel = path.relative(projectRoot, absolute);
      const outsideProject = projectRel.startsWith('..') || path.isAbsolute(projectRel);
      return outsideProject ? { ...file, outsideProject: true } : file;
    });
    return {
      ...head,
      files: scopedFiles,
      repoRoot: cwd,
      notARepo: false,
    };
  }

  function statusSingleFlight(projectId: number, includeFiles: boolean, repoPath?: string): Promise<GitStatus> {
    const key = `${projectId}:${includeFiles ? 'full' : 'summary'}:${repoPath ?? ''}`;
    const existing = statusInflight.get(key);
    if (existing) {
      recordGitCacheDecision(true);
      return existing;
    }
    recordGitCacheDecision(false);
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

    async statusPage({ projectId, repoPath, snapshotId, cursor, pageSize = 250 }) {
      const now = Date.now();
      for (const [id, entry] of statusSnapshots) {
        if (now - entry.createdAt > STATUS_SNAPSHOT_TTL_MS) statusSnapshots.delete(id);
      }
      const size = Math.max(1, Math.min(1_000, Math.trunc(pageSize)));
      let entry = snapshotId ? statusSnapshots.get(snapshotId) : undefined;
      if (snapshotId && !entry) throw new ApiError('git_status_snapshot_expired', 410, 'status snapshot expired; refresh and try again');
      if (entry && (entry.projectId !== projectId || entry.repoPath !== repoPath)) {
        throw new ApiError('git_status_snapshot_scope', 400, 'status snapshot belongs to another repository');
      }
      if (!entry) {
        recordGitCacheDecision(false);
        const startedAt = Date.now();
        const status = await statusSingleFlight(projectId, true, repoPath) as GitStatus & { files: GitStatusFile[] };
        const bytes = Buffer.byteLength(JSON.stringify(status.files), 'utf8');
        if (bytes > GIT_STATUS_MAX_OUTPUT_BYTES) {
          throw new ApiError('git_status_snapshot_too_large', 413, `status snapshot exceeded ${GIT_STATUS_MAX_OUTPUT_BYTES} bytes`);
        }
        entry = { projectId, repoPath, status, createdAt: now, elapsedMs: Date.now() - startedAt };
      } else {
        recordGitCacheDecision(true);
      }
      const offset = cursor ? Number(cursor) : 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > entry.status.files.length) {
        throw new ApiError('git_status_cursor_invalid', 400, 'status cursor is invalid');
      }
      const files = entry.status.files.slice(offset, offset + size);
      const nextOffset = offset + files.length;
      const hasMore = nextOffset < entry.status.files.length;
      let id: string | null = snapshotId ?? null;
      if (hasMore && !id) {
        id = randomUUID();
        statusSnapshots.set(id, entry);
      }
      const all = entry.status.files;
      const counts = {
        total: all.length,
        staged: all.filter((file) => file.staged).length,
        unstaged: all.filter((file) => !file.staged && file.state !== 'untracked').length,
        untracked: all.filter((file) => file.state === 'untracked').length,
        conflicts: all.filter((file) => file.state === 'unmerged').length,
      };
      const result: GitWorkspaceSnapshot = {
        ...entry.status,
        files,
        counts,
        snapshotId: id,
        nextCursor: hasMore ? String(nextOffset) : null,
        pageSize: size,
        partialWarnings: entry.status.partialWarnings ?? [],
        ...(entry.elapsedMs >= 1_000 ? {
          performanceHint: {
            elapsedMs: entry.elapsedMs,
            suggestUntrackedCache: true,
            suggestFsmonitor: true,
          },
        } : {}),
      };
      return result;
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
      await ensureCommitRef(root, branch);
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

    async log({ projectId, limit = 30, skip = 0, path, branch, all = false, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      if (branch) await ensureCommitRef(root, branch);
      const fmt = '%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%P%x1f%D';
      const pageSize = Math.max(1, Math.min(500, Math.trunc(Number.isFinite(limit) ? limit : 30)));
      const pageOffset = Math.max(0, Math.min(1_000_000, Math.trunc(Number.isFinite(skip) ? skip : 0)));
      const args = ['log', `--pretty=format:${fmt}`, '--date=iso-strict', '--decorate=short', `-n${pageSize}`];
      if (pageOffset > 0) args.push(`--skip=${pageOffset}`);
      // Branch filter ALWAYS goes BEFORE the `--` separator. Treating
      // it as a single ref is intentional — the renderer drives a
      // dropdown that emits exact branch names, so we don't need glob
      // expansion (which would also let users `git log --all` here).
      if (all) args.push('--all');
      else if (branch) args.push(branch);
      if (path) args.push('--', path);
      const r = await runGit(root, args, {
        timeoutMs: GIT_READ_TIMEOUT_MS,
        maxOutputBytes: GIT_LIST_MAX_OUTPUT_BYTES,
      });
      if (r.code !== 0) {
        throwGitReadFailure('git_log', r, 'git log failed');
      }
      return parseGitLog(r.stdout);
    },

    async logPage({ projectId, repoPath, branch, all = false, path: filePath, pageSize = 80, snapshotId, cursor }) {
      const now = Date.now();
      for (const [id, stored] of logSnapshots) if (now - stored.createdAt > LOG_SNAPSHOT_TTL_MS) logSnapshots.delete(id);
      let snapshot = snapshotId ? logSnapshots.get(snapshotId) : undefined;
      if (snapshotId && !snapshot) throw new ApiError('git_log_snapshot_expired', 410, 'history snapshot expired; refresh and try again');
      if (snapshot && (
        snapshot.projectId !== projectId ||
        snapshot.repoPath !== repoPath ||
        snapshot.path !== filePath ||
        snapshot.branch !== branch ||
        snapshot.all !== all
      )) {
        throw new ApiError('git_log_snapshot_scope', 400, 'history snapshot belongs to another query');
      }
      if (!snapshot) {
        recordGitCacheDecision(false);
        const root = await resolveCwd(projectId, repoPath);
        let refs: string[] = [];
        if (all) {
          const result = await runGit(root, ['for-each-ref', '--format=%(objectname)', 'refs/heads', 'refs/remotes'], { profile: 'read' });
          if (result.code !== 0) throwGitReadFailure('git_log_refs', result, 'failed to resolve history refs');
          refs = Array.from(new Set(result.stdout.split('\n').map((ref) => ref.trim()).filter(Boolean)));
        } else {
          const source = branch ?? 'HEAD';
          await ensureCommitRef(root, source);
          const result = await runGit(root, ['rev-parse', '--verify', '--end-of-options', `${source}^{commit}`], { profile: 'read' });
          if (result.code !== 0) throwGitReadFailure('git_log_ref', result, 'failed to resolve history ref');
          refs = [result.stdout.trim()];
        }
        snapshot = { projectId, repoPath, root, refs, path: filePath, branch, all, createdAt: now };
      } else {
        recordGitCacheDecision(true);
      }
      const size = Math.max(1, Math.min(500, Math.trunc(pageSize)));
      const offset = cursor ? Number(cursor) : 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new ApiError('git_log_cursor_invalid', 400, 'history cursor is invalid');
      if (snapshot.refs.length === 0) return { commits: [], snapshotId: null, nextCursor: null };
      const fmt = '%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%P%x1f%D';
      const args = ['log', `--pretty=format:${fmt}`, '--date=iso-strict', '--decorate=short', `-n${size + 1}`];
      if (offset > 0) args.push(`--skip=${offset}`);
      args.push(...snapshot.refs);
      if (snapshot.path) args.push('--', snapshot.path);
      const result = await runGit(snapshot.root, args, { timeoutMs: GIT_READ_TIMEOUT_MS, maxOutputBytes: GIT_LIST_MAX_OUTPUT_BYTES });
      if (result.code !== 0) throwGitReadFailure('git_log', result, 'git log failed');
      const parsed = parseGitLog(result.stdout);
      const hasMore = parsed.length > size;
      const commits = parsed.slice(0, size);
      let id = snapshotId ?? null;
      if (hasMore && !id) {
        id = randomUUID();
        logSnapshots.set(id, snapshot);
      }
      return { commits, snapshotId: id, nextCursor: hasMore ? String(offset + commits.length) : null };
    },

    async commitDetail({ projectId, sha, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      await ensureCommitRef(root, sha);
      // Metadata in one pass. `%P` (parents) is space-separated; `%b`
      // (body) can contain anything including our separator, so it's
      // fetched in a second `-s` call where it's the whole output.
      const metaFmt = '%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%P%x1f%s';
      const [meta, bodyRes, files] = await Promise.all([
        runGit(root, ['show', '-s', `--format=${metaFmt}`, '--date=iso-strict', sha], {
          timeoutMs: GIT_READ_TIMEOUT_MS,
          maxOutputBytes: GIT_LIST_MAX_OUTPUT_BYTES,
        }),
        runGit(root, ['show', '-s', '--format=%b', sha], {
          timeoutMs: GIT_READ_TIMEOUT_MS,
          maxOutputBytes: GIT_DETAIL_MAX_OUTPUT_BYTES,
        }),
        collectChangedFiles(root, (flag) => ['show', flag, '--format=', sha]),
      ]);
      if (meta.code !== 0) {
        throwGitReadFailure('git_show', meta, 'git show failed');
      }
      const [fullSha, shortSha, author, authorEmail, date, parentStr, subject] =
        meta.stdout.trim().split('\x1f');
      if (bodyRes.code !== 0) {
        throwGitReadFailure('git_show', bodyRes, 'git show failed');
      }
      const body = bodyRes.stdout.replace(/\s+$/, '');
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
      await ensureCommitRef(root, sha);
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
        const hasHead = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { profile: 'read' });
        const r = hasHead.code === 0
          ? await runGit(cwd, ['restore', '--staged', '--', ...gitPaths], { profile: 'mutation' })
          : await runGit(cwd, ['rm', '--cached', '--ignore-unmatch', '--', ...gitPaths], { profile: 'mutation' });
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
        // Classify the complete batch. Checking only its first item can turn a
        // mixed tracked/untracked request into a recursive delete of tracked
        // content (or make checkout reject every untracked item).
        const trackedResult = await runGit(cwd, ['ls-files', '-z', '--', ...gitPaths], {
          profile: 'read',
          maxOutputBytes: GIT_LIST_MAX_OUTPUT_BYTES,
        });
        if (trackedResult.code !== 0) {
          throwGitReadFailure('git_discard_classify', trackedResult, 'failed to classify discard paths');
        }
        const trackedFiles = trackedResult.stdout
          .split('\0')
          .filter(Boolean)
          .map((file) => file.replace(/\\/g, '/'));
        const isTracked = (candidate: string) => {
          const normalized = candidate.replace(/\\/g, '/').replace(/\/$/, '');
          return trackedFiles.some((file) => file === normalized || file.startsWith(`${normalized}/`));
        };
        const trackedPaths = gitPaths.filter(isTracked);
        const untrackedPaths = gitPaths.filter((gitPath) => !isTracked(gitPath));

        if (trackedPaths.length > 0) {
          const r = await runGit(cwd, ['checkout', '--', ...trackedPaths], { profile: 'mutation' });
          if (r.code !== 0) throw new ApiError('git_discard_failed', 500, r.stderr.trim() || 'git checkout failed');
        }
        // The Changes UI labels untracked discard as Delete. Delete only after
        // the shared validator proved every path is relative and non-escaping.
        for (const gitPath of untrackedPaths) {
          const absolute = path.resolve(cwd, gitPath);
          const relative = path.relative(cwd, absolute);
          if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ApiError('git_discard_escape', 400, 'discard path escapes repository');
          await rm(absolute, { recursive: true, force: true });
        }
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
      if (create) await ensureBranchName(root, name);
      else await ensureCommitRef(root, name);
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
        if (hit) {
          recordGitCacheDecision(true);
          return hit;
        }
        recordGitCacheDecision(false);
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
      await ensureBranchName(root, name);
      if (from) await ensureCommitRef(root, from);
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
      await ensureLocalBranch(root, name);
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
      await ensureLocalBranch(root, oldName);
      await ensureBranchName(root, newName);
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
      await ensureCommitRef(root, branch);
      const args = ['merge'];
      if (ffOnly) args.push('--ff-only');
      if (noFf) args.push('--no-ff');
      if (message) args.push('-m', message);
      args.push(branch);
      return runAsResult(root, 'git', args);
    },

    async reset({ projectId, target, mode, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      await ensureCommitRef(root, target);
      // Whitelist mode — never trust raw input as a git CLI flag.
      const flag =
        mode === 'soft' ? '--soft' : mode === 'hard' ? '--hard' : '--mixed';
      return runAsResult(root, 'git', ['reset', flag, target]);
    },

    async revert({ projectId, commit, noCommit, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      await ensureCommitRef(root, commit);
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
      for (const commit of commits) await ensureCommitRef(root, commit);
      const args = ['cherry-pick'];
      if (noCommit) args.push('--no-commit');
      for (const c of commits) args.push(c);
      return runAsResult(root, 'git', args);
    },

    async rebase({ projectId, onto, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      await ensureCommitRef(root, onto);
      // Non-interactive: suppress the editor (todo list + commit message) so a
      // rebase can never block on it. A conflict stops the rebase and is picked
      // up by mergeState (kind 'rebase') — the resolver + continue/abort flow
      // already handle it, exactly like a conflicting cherry-pick.
      return runAsResult(root, 'git', ['rebase', onto], {
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
      await ensureRemote(root, remote);
      if (branch) await ensureCommitRef(root, branch);
      const args = ['push'];
      // --force-with-lease is the safe variant: rejects when the
      // remote moved since we last fetched. Never expose plain --force
      // from the UI — that's a footgun behind a button.
      if (force) args.push('--force-with-lease');
      if (setUpstream) args.push('-u');
      if (remote) args.push(remote);
      if (branch) args.push(branch);
      return runAsResult(root, 'git', args, { GIT_TERMINAL_PROMPT: '0' }, GIT_NETWORK_TIMEOUT_MS);
    },

    async fetch({ projectId, remote, prune, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      await ensureRemote(root, remote);
      const args = ['fetch'];
      if (prune) args.push('--prune');
      if (remote) args.push(remote);
      // No remote arg → `git fetch` fetches the current branch's upstream
      // (or all configured remotes when there's no upstream). Matches
      // JetBrains "Update Project" intuition.
      return runAsResult(root, 'git', args, { GIT_TERMINAL_PROMPT: '0' }, GIT_NETWORK_TIMEOUT_MS);
    },

    async pull({ projectId, remote, branch, rebase, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      await ensureRemote(root, remote);
      if (branch) await ensureBranchName(root, branch);
      const args = ['pull'];
      if (rebase) args.push('--rebase');
      if (remote) args.push(remote);
      if (branch) args.push(branch);
      return runAsResult(root, 'git', args, { GIT_TERMINAL_PROMPT: '0' }, GIT_NETWORK_TIMEOUT_MS);
    },

    async updateBranch({ projectId, branch, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      await ensureLocalBranch(root, branch);
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
      await ensureRemote(root, remote);
      return runAsResult(root, 'git', ['fetch', remote, `${src}:${branch}`], { GIT_TERMINAL_PROMPT: '0' }, GIT_NETWORK_TIMEOUT_MS);
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
      await ensureStash(root, ref);
      return runAsResult(root, 'git', ['stash', 'pop', ref]);
    },

    async stashApply({ projectId, ref, repoPath }) {
      if (!ref) {
        throw new ApiError('bad_input', 400, 'ref required (e.g. stash@{0})');
      }
      const root = await resolveCwd(projectId, repoPath);
      await ensureStash(root, ref);
      return runAsResult(root, 'git', ['stash', 'apply', ref]);
    },

    async stashDrop({ projectId, ref, repoPath }) {
      if (!ref) {
        throw new ApiError('bad_input', 400, 'ref required (e.g. stash@{0})');
      }
      const root = await resolveCwd(projectId, repoPath);
      await ensureStash(root, ref);
      return runAsResult(root, 'git', ['stash', 'drop', ref]);
    },

    async stashShow({ projectId, ref, repoPath }) {
      if (!ref) {
        throw new ApiError('bad_input', 400, 'ref required (e.g. stash@{0})');
      }
      const root = await resolveCwd(projectId, repoPath);
      await ensureStash(root, ref);
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
      await ensureStash(root, ref);
      // A stash IS a commit object, so `git show -s` reads its metadata.
      // %s is the stash subject ("WIP on <branch>: <sha> <subject>").
      const [meta, files] = await Promise.all([
        runGit(root, ['show', '-s', '--format=%h%x1f%cI%x1f%s', '--date=iso-strict', ref], {
          timeoutMs: GIT_READ_TIMEOUT_MS,
          maxOutputBytes: GIT_LIST_MAX_OUTPUT_BYTES,
        }),
        collectChangedFiles(root, (flag) => ['stash', 'show', flag, ref]),
      ]);
      if (meta.code !== 0) {
        throwGitReadFailure('git_stash_show', meta, 'git show failed');
      }
      const [shortSha, date, message] = meta.stdout.trim().split('\x1f');
      const m = message?.match(/^(?:WIP on|On)\s+([^:]+):/);
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
      await ensureStash(root, ref);
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
        runGit(root, ['branch', '--show-current'], { profile: 'read' }),
        runGit(root, ['for-each-ref', '--count=20', '--sort=-committerdate',
                       '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], { profile: 'read' }),
        runGit(root, ['log', '-n8', '--pretty=format:%h %s'], { profile: 'read' }),
      ]);
      const ctx = {
        currentBranch: curRes.stdout.trim(),
        recentBranches: branchRes.stdout.split('\n').filter(Boolean).slice(0, 20),
        recentCommits: logRes.stdout.split('\n').filter(Boolean).slice(0, 8),
      };
      const draft = await generateAiPlan(deps, cleaned, ctx);
      const planId = randomUUID();
      const expiresAtMs = Date.now() + AI_PLAN_TTL_MS;
      const steps: GitPlanStep[] = draft.steps.map(({ operation, description }) => ({
        id: randomUUID(),
        operation,
        description,
        risk: operationRisk(operation),
        preview: commandPreview(operation),
      }));
      if (steps.length > 0 && !draft.refusal) {
        for (const [id, stored] of aiPlans) if (stored.expiresAt <= Date.now()) aiPlans.delete(id);
        aiPlans.set(planId, { projectId, repoPath, expiresAt: expiresAtMs, steps });
      }
      const plan: GitPlan = {
        planId,
        expiresAt: new Date(expiresAtMs).toISOString(),
        intent: cleaned,
        summary: draft.summary,
        steps,
        ...(draft.refusal ? { refusal: draft.refusal } : {}),
      };
      return plan;
    },

    async aiExecute({ projectId, planId, repoPath }) {
      const root = await resolveCwd(projectId, repoPath);
      const stored = aiPlans.get(planId);
      if (!stored || stored.expiresAt <= Date.now()) {
        aiPlans.delete(planId);
        throw new ApiError('git_ai_plan_expired', 410, 'AI plan expired or was already executed; generate a new plan');
      }
      if (stored.projectId !== projectId || stored.repoPath !== repoPath) {
        throw new ApiError('git_ai_plan_scope', 400, 'AI plan belongs to another repository');
      }
      // One-shot: remove before the first spawn so retries cannot replay a
      // destructive plan after an ambiguous transport failure.
      aiPlans.delete(planId);
      const results: GitRunResult[] = [];
      let aborted = false;
      for (const step of stored.steps) {
        const built = buildOperation(step.operation);
        try {
          await validateOperation(root, step.operation);
        } catch (error) {
          results.push({
            command: 'git',
            args: built.args,
            ok: false,
            code: -1,
            stdout: '',
            stderr: error instanceof Error ? error.message : String(error),
            errorCode: 'git_failed',
          });
          aborted = true;
          break;
        }
        const result = await runAsResult(
          root,
          'git',
          built.args,
          built.env ?? (built.profile === 'network' ? { GIT_TERMINAL_PROMPT: '0' } : undefined),
          built.profile === 'network' ? GIT_NETWORK_TIMEOUT_MS : undefined,
        );
        results.push(result);
        if (!result.ok) {
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
  const api: ProjectGitApi = {
    ...base,
    ...createConflictHandlers({ runGit, runAsResult, resolveCwd, detectRepo, resolveRepoForPath: repoResolver.resolveRepoForPath }),
    gitOptimizations: gitOpt.gitOptimizations,
    configureGitOptimizations: gitOpt.configureGitOptimizations,
  };
  return guardProjectGitApi(api, (_method, input) => {
    for (const key of branchesCache.keys()) {
      if (key.startsWith(`${input.projectId}:`) && key.includes(`:${input.repoPath ?? ''}:`)) branchesCache.delete(key);
    }
    for (const [id, snapshot] of statusSnapshots) {
      if (snapshot.projectId === input.projectId && snapshot.repoPath === input.repoPath) statusSnapshots.delete(id);
    }
    for (const [id, snapshot] of logSnapshots) {
      if (snapshot.projectId === input.projectId && snapshot.repoPath === input.repoPath) logSnapshots.delete(id);
    }
  }, (metric) => {
    try {
      deps.pipelineTelemetryStore?.insert({
        pipeline_name: 'project_git',
        stage: metric.method,
        component_name: 'git_cli',
        duration_ms: metric.durationMs,
        duration_bucket: durationToBucket(metric.durationMs),
        cache_hits: metric.cacheHits,
        cache_misses: metric.cacheMisses,
        errors: metric.ok ? 0 : 1,
        diag: {
          mutation: metric.mutation,
          queue_wait_ms: metric.queueWaitMs,
          process_count: metric.processCount,
          output_bytes: metric.outputBytes,
          timed_out: metric.timedOut,
          truncated: metric.truncated,
        },
      });
    } catch { /* telemetry is fail-open and never contains refs, paths or content */ }
  });
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
  const result = await runGit(cwd, args, {
    env,
    timeoutMs,
    profile: timeoutMs ? 'network' : 'mutation',
    maxOutputBytes: GIT_DETAIL_MAX_OUTPUT_BYTES,
  });
  return {
    command: 'git',
    args,
    ok: result.code === 0,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    errorCode: result.errorCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    truncated: result.truncated,
  };
}

interface AiPlanDraft {
  summary: string;
  refusal?: string;
  steps: Array<{ operation: GitPlanOperation; description: string }>;
}

async function generateAiPlan(
  deps: HandlerDeps,
  intent: string,
  ctx: { currentBranch: string; recentBranches: string[]; recentCommits: string[] },
): Promise<AiPlanDraft> {
  const system = `You are a git expert inside an IDE. Produce only a typed JSON plan; never emit shell commands or argv.

Rules:
- Return { summary, steps: [{ operation, description }], refusal? }.
- operation must be exactly one of:
  {op:"branchCheckout",name,create?}
  {op:"branchCreate",name,from?,checkout?}
  {op:"branchRename",oldName,newName,force?}
  {op:"branchDelete",name,force?}
  {op:"merge",branch,strategy?:"ff-only"|"no-ff"|"default"}
  {op:"rebase",onto}
  {op:"reset",target,mode:"soft"|"mixed"|"hard"}
  {op:"revert",commit,noCommit?}
  {op:"cherryPick",commits:string[],noCommit?}
  {op:"push",remote?,branch?,force?,setUpstream?}
  {op:"fetch",remote?,prune?}
  {op:"pull",remote?,branch?,rebase?}
  {op:"stashSave",message?,includeUntracked?,keepIndex?}
  {op:"stashPop"|"stashApply"|"stashDrop",ref}
- If the intent is unclear, ambiguous, or unsafe, return { summary: "", steps: [], refusal: "<why>" }.
- Keep step descriptions short, in the user's language when possible.
- Configuration, clean, gc, submodules, aliases, arbitrary flags and raw commands are unsupported: refuse them.
- Prefer ff-only for an unspecified merge strategy.

Output ONLY the JSON object. No markdown, no prose.`;

  const userMsg = `Repo context:
  current branch: ${ctx.currentBranch || '(detached)'}
  recent branches: ${ctx.recentBranches.join(', ') || '(none)'}
  recent commits:
${ctx.recentCommits.map((l) => `    ${l}`).join('\n') || '    (no commits)'}

User intent:
${intent}`;

  const result = await callGeneralAiJson(deps, { system, user: userMsg, maxTokens: 800 });
  if ('refusal' in result) return { summary: '', steps: [], refusal: result.refusal };
  const cleaned = stripJsonFences(result.raw);
  try {
    const parsed = JSON.parse(cleaned) as {
      summary?: string;
      refusal?: string;
      steps?: Array<{ operation?: unknown; description?: unknown }>;
    };
    const candidates = Array.isArray(parsed.steps) ? parsed.steps.slice(0, 25) : [];
    const steps = candidates.flatMap((step) => {
      const operation = normalizeAiOperation(step?.operation);
      return operation ? [{ operation, description: typeof step.description === 'string' ? step.description.slice(0, 500) : '' }] : [];
    });
    const refusal = typeof parsed.refusal === 'string' && parsed.refusal.trim() ? parsed.refusal.trim().slice(0, 2_000) : undefined;
    if (candidates.length > 0 && steps.length === 0 && !refusal) {
      return { summary: '', steps: [], refusal: 'The AI proposed unsupported Git operations. Rephrase the request using branches, history, sync, or stash.' };
    }
    return { summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 2_000) : '', steps, ...(refusal ? { refusal } : {}) };
  } catch {
    return { summary: '', steps: [], refusal: 'AI returned an invalid typed plan. No command was accepted or executed.' };
  }
}
