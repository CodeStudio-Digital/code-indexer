/**
 * Multi-repo discovery + path resolution for the project-local git surface.
 * A project's working tree can hold more than one git root: the main repo, its
 * declared submodules (`.gitmodules`), and nested independent repos (a separate
 * clone checked out inside the tree). This module finds them and resolves which
 * one a call targets — split out of `index.ts` to keep that god-file lean.
 *
 *   - `listRepos` powers the Git tool window's repo selector.
 *   - `resolveCwd(projectId, repoPath?)` validates an explicit repo selection
 *     (a member of the discovered set) and returns the git cwd.
 *   - `resolveRepoForPath(projectId, projectRelPath)` auto-routes a project-
 *     relative path to its containing repo (deepest discovered root) — the seam
 *     the explorer/editor allow-list uses so files inside a submodule get the
 *     right baseline/status.
 *
 * Discovery is cached per project root (short TTL) and bounded (depth-limited
 * BFS with a denylist + a hard dir cap) so it never descends a huge tree.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ApiError, type GitRepoRef } from '@mcp/api-bus';

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

type RunGit = (
  cwd: string,
  args: string[],
  optsOrStdin?: string | { stdin?: string; env?: Record<string, string>; timeoutMs?: number; maxOutputBytes?: number },
) => Promise<GitResult>;

interface DetectRepoResult {
  repoRoot: string | null;
  gitDir: string | null;
  notARepo: boolean;
}

export interface RepoResolverDeps {
  runGit: RunGit;
  requireRoot(projectId: number): string;
  detectRepo(root: string): Promise<DetectRepoResult>;
}

export interface RepoResolver {
  /** Discover all git roots inside the project (cached). */
  listRepos(projectId: number): Promise<GitRepoRef[]>;
  /** Validate an explicit repo selection and return the git cwd. Falls back to
   *  the project's main repo when `repoPath` is omitted. */
  resolveCwd(projectId: number, repoPath?: string): Promise<string>;
  /** Auto-route a project-relative path to the deepest containing repo. */
  resolveRepoForPath(
    projectId: number,
    projectRelPath: string,
  ): Promise<{ repo: GitRepoRef; cwd: string; repoRelPath: string }>;
  /** Drop the cached discovery for a project root (e.g. on `.gitmodules` change). */
  bust(projectId: number): void;
}

const REPO_LIST_CACHE_MS = Number(process.env.MCP_GIT_REPO_LIST_CACHE_MS ?? 15_000);
const SCAN_MAX_DEPTH = Number(process.env.MCP_GIT_REPO_SCAN_DEPTH ?? 3);
const SCAN_MAX_DIRS = Number(process.env.MCP_GIT_REPO_SCAN_MAX_DIRS ?? 4000);
const SUMMARY_TIMEOUT_MS = Number(process.env.MCP_GIT_SUMMARY_TIMEOUT_MS ?? 3_000);

// High-churn / vendored dirs we never descend looking for nested repos. `.git`
// is here so we don't walk an object DB; the rest are build output / deps.
const SCAN_DENYLIST = new Set<string>([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.turbo',
  '.cache', '.venv', 'venv', '__pycache__', 'vendor', 'target', '.idea', '.vscode',
  'bower_components', '.gradle', '.mvn', 'Pods',
]);

/** POSIX path of `to` relative to `from`. */
function posixRel(from: string, to: string): string {
  return path.relative(from, to).replace(/\\/g, '/');
}

/** True when two paths point at the same location (case-insensitive on win32,
 *  separator-agnostic — `path.relative` of identical paths is ''). */
function samePath(a: string, b: string): boolean {
  return path.relative(a, b) === '';
}

/** Is `child` at or below `parent`? */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function makeRef(
  projectRoot: string,
  absPath: string,
  kind: GitRepoRef['kind'],
  initialized: boolean,
  ignoredByParent: boolean,
): GitRepoRef {
  return {
    absPath,
    repoRoot: absPath,
    projectRelPrefix: posixRel(projectRoot, absPath),
    name: path.basename(absPath) || absPath,
    kind,
    initialized,
    ignoredByParent,
    projectRoot,
    extendsBeyondProject: !samePath(projectRoot, absPath) && isInside(absPath, projectRoot),
  };
}

/** Parse `git config --file <.gitmodules> --get-regexp path` into abs submodule roots. */
async function readSubmodules(
  runGit: RunGit,
  mainRoot: string,
): Promise<{ absPath: string }[]> {
  const gmFile = path.join(mainRoot, '.gitmodules');
  // Most repositories have no submodules. Do not launch git merely to learn
  // that the config file is absent on every discovery-cache expiration.
  try {
    await fs.access(gmFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    // Preserve Git's existing handling of permission errors and unusual paths.
  }
  const r = await runGit(mainRoot, ['config', '--file', gmFile, '--get-regexp', 'path'], {
    timeoutMs: SUMMARY_TIMEOUT_MS,
  });
  if (r.code !== 0) return []; // no .gitmodules / no submodules
  const out: { absPath: string }[] = [];
  for (const line of r.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sp = trimmed.indexOf(' ');
    if (sp < 0) continue;
    const key = trimmed.slice(0, sp);
    const rel = trimmed.slice(sp + 1).trim();
    if (!key.endsWith('.path') || !rel) continue;
    out.push({ absPath: path.resolve(mainRoot, rel) });
  }
  return out;
}

/** Bounded BFS from the project root for nested `.git` repos (excluding the main
 *  repo and known submodules). Never descends INTO a found repo or a denylisted
 *  dir, and bails after SCAN_MAX_DIRS dirs. */
async function scanNestedRepos(
  runGit: RunGit,
  projectRoot: string,
  mainRoot: string,
  submoduleAbs: string[],
): Promise<GitRepoRef[]> {
  const found: GitRepoRef[] = [];
  let visited = 0;
  const queue: { dir: string; depth: number }[] = [{ dir: projectRoot, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    if (visited++ >= SCAN_MAX_DIRS) break;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const hasGit = entries.some((e) => e.name === '.git');
    if (hasGit && !samePath(dir, projectRoot) && !samePath(dir, mainRoot)) {
      const abs = path.resolve(dir);
      if (!submoduleAbs.some((s) => samePath(s, abs))) {
        const relToMain = posixRel(mainRoot, abs);
        // `check-ignore -q` exits 0 when the path is ignored by the parent.
        const ig = await runGit(mainRoot, ['check-ignore', '-q', relToMain], { timeoutMs: SUMMARY_TIMEOUT_MS });
        found.push(makeRef(projectRoot, abs, 'nested', true, ig.code === 0));
      }
      continue; // a repo root: do not descend into its internals
    }
    if (depth >= SCAN_MAX_DEPTH) continue;
    for (const e of entries) {
      if (!e.isDirectory() || SCAN_DENYLIST.has(e.name)) continue;
      queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  return found;
}

export function createRepoResolver(deps: RepoResolverDeps): RepoResolver {
  const { runGit, requireRoot, detectRepo } = deps;
  // Cache discovered repos per project root (root_path is stable for a project).
  const cache = new Map<string, { repos: GitRepoRef[]; canonicalRoot: string; at: number }>();
  const inflight = new Map<string, Promise<{ repos: GitRepoRef[]; canonicalRoot: string }>>();
  // Reverse index projectId → root so `bust(projectId)` can drop the entry.
  const rootByProject = new Map<number, string>();

  // `projectRoot` is the CANONICAL (realpath'd) root — getRepos resolves it once
  // so every prefix/containment computation here AND in resolveRepoForPath shares
  // the same namespace as the realpath'd toplevel git reports.
  async function discover(projectRoot: string): Promise<GitRepoRef[]> {
    const det = await detectRepo(projectRoot);
    if (det.notARepo || !det.repoRoot) return [];
    const mainRoot = det.repoRoot;
    const repos: GitRepoRef[] = [makeRef(projectRoot, mainRoot, 'main', true, false)];

    // Submodules from .gitmodules (authoritative; includes uninitialized ones).
    const submodules = await readSubmodules(runGit, mainRoot);
    const submoduleAbs = submodules.map((s) => s.absPath);
    for (const s of submodules) {
      // Only surface submodules that live inside the project subtree (a nested
      // project may sit under a bigger repo with unrelated sibling submodules).
      if (!isInside(projectRoot, s.absPath)) continue;
      let initialized = false;
      try {
        await fs.access(path.join(s.absPath, '.git'));
        initialized = true;
      } catch {
        /* declared but not checked out */
      }
      repos.push(makeRef(projectRoot, s.absPath, 'submodule', initialized, false));
    }

    // Nested independent repos via bounded scan (deduped against submodules).
    const nested = await scanNestedRepos(runGit, projectRoot, mainRoot, submoduleAbs);
    for (const n of nested) {
      if (repos.some((r) => samePath(r.absPath, n.absPath))) continue;
      repos.push(n);
    }

    return repos;
  }

  async function getRepos(projectId: number): Promise<{ repos: GitRepoRef[]; canonicalRoot: string }> {
    const root = requireRoot(projectId);
    rootByProject.set(projectId, root);
    const hit = cache.get(root);
    if (hit && Date.now() - hit.at < REPO_LIST_CACHE_MS) {
      return { repos: hit.repos, canonicalRoot: hit.canonicalRoot };
    }
    const pending = inflight.get(root);
    if (pending) return pending;
    // Canonicalize once (symlink/junction in root_path) so file-path containment
    // below matches the realpath'd repo roots discovery resolves.
    const work = (async () => {
      let canonicalRoot = root;
      try {
        canonicalRoot = await fs.realpath(root);
      } catch {
        /* keep raw root */
      }
      const repos = await discover(canonicalRoot);
      cache.set(root, { repos, canonicalRoot, at: Date.now() });
      return { repos, canonicalRoot };
    })().finally(() => inflight.delete(root));
    inflight.set(root, work);
    return work;
  }

  return {
    listRepos: (projectId) => getRepos(projectId).then((r) => r.repos),

    async resolveCwd(projectId, repoPath) {
      const root = requireRoot(projectId);
      if (!repoPath) return root;
      const norm = repoPath.replace(/\\/g, '/');
      const abs = path.isAbsolute(norm) ? path.resolve(norm) : path.resolve(root, norm);
      const { repos } = await getRepos(projectId);
      const match = repos.find((r) => samePath(r.absPath, abs));
      if (!match) {
        throw new ApiError('unknown_repo', 400, `repoPath is not a known repository in this project: ${repoPath}`);
      }
      if (!match.initialized) {
        throw new ApiError('submodule_uninitialized', 409, `repository is not checked out: ${match.projectRelPrefix || match.name}`);
      }
      return match.absPath;
    },

    async resolveRepoForPath(projectId, projectRelPath) {
      const { repos, canonicalRoot } = await getRepos(projectId);
      // Build the absolute file path on the SAME canonical namespace as the repo
      // roots — else a symlinked/junctioned root_path makes every isInside() fail
      // and the file misroutes to main with a broken ../ repo-relative path.
      const absFile = path.resolve(canonicalRoot, projectRelPath.replace(/\\/g, '/'));
      let best: GitRepoRef | null = null;
      for (const r of repos) {
        if (!r.initialized) continue;
        if (isInside(r.absPath, absFile) && (!best || r.absPath.length > best.absPath.length)) {
          best = r;
        }
      }
      // Fall back to the main repo (or the canonical root) when nothing matched —
      // e.g. a project nested under a bigger repo whose main root is an ancestor.
      const main = repos.find((r) => r.kind === 'main');
      const repo = best ?? main ?? makeRef(canonicalRoot, canonicalRoot, 'main', true, false);
      return { repo, cwd: repo.absPath, repoRelPath: posixRel(repo.absPath, absFile) };
    },

    bust(projectId) {
      const root = rootByProject.get(projectId);
      if (root) {
        cache.delete(root);
        inflight.delete(root);
      }
    },
  };
}
