import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  getProjectDiscoveryCacheVersion,
  getProjectIgnoreRules,
  scanProjectTree,
  shouldIgnoreProjectPath,
} from '@mcp/shared/utils/project-ignore.js';

const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', 'bin', 'obj']);
const ASYNC_SCAN_MAX_DIRECTORIES = 4_096;
const ASYNC_SCAN_CACHE_MS = 30_000;
const asyncCache = new Map<string, {
  expiresAt: number;
  version: string;
  value: DotnetProjectScan;
}>();
const inFlight = new Map<string, Promise<DotnetProjectScan>>();

export interface DotnetProjectScan {
  /** Project-root-relative, forward-slash paths. */
  projects: string[];
  /** Project-root-relative, forward-slash paths. */
  solutions: string[];
  /** Unity owns its generated .csproj/.sln files; they are not dotnet-run targets. */
  unityRoot: boolean;
}

/**
 * Bounded, symlink-safe discovery for ordinary .NET repository layouts.
 * Dirent#isDirectory deliberately excludes directory symlinks, and the depth
 * cap prevents an unexpectedly large tree from turning a toolbar refresh into
 * an unbounded walk.
 */
export function scanDotnetProjects(root: string, maxDepth = 6): DotnetProjectScan {
  const projects: string[] = [];
  const solutions: string[] = [];
  const ignoreRules = getProjectIgnoreRules(root);
  const unityRoot = ignoreRules.scopes.some((scope) => scope.path === '' && scope.kind === 'unity');
  if (unityRoot) return { projects, solutions, unityRoot };
  const walk = (dir: string, prefix: string, depth: number): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isFile()) {
        if (shouldIgnoreProjectPath(ignoreRules, relative, false)) continue;
        const lower = entry.name.toLowerCase();
        if (lower.endsWith('.csproj')) projects.push(relative);
        else if (lower.endsWith('.sln') || lower.endsWith('.slnx')) solutions.push(relative);
        continue;
      }
      if (
        depth < maxDepth
        && entry.isDirectory()
        && !SKIP_DIRS.has(entry.name.toLowerCase())
        && !entry.name.startsWith('.')
        && !shouldIgnoreProjectPath(ignoreRules, relative, true)
      ) {
        walk(join(dir, entry.name), relative, depth + 1);
      }
    }
  };
  walk(root, '', 0);
  return { projects: projects.sort(), solutions: solutions.sort(), unityRoot };
}

/**
 * Main-process-safe .NET discovery. Scope detection and manifest collection
 * share one async filesystem walk; concurrent toolbar/API requests share the
 * same promise and watcher invalidation prevents stale cache hits.
 */
export async function scanDotnetProjectsAsync(
  root: string,
  maxDepth = 6,
): Promise<DotnetProjectScan> {
  const key = `${resolve(root)}\0${maxDepth}`;
  const version = getProjectDiscoveryCacheVersion(root);
  const now = Date.now();
  const cached = asyncCache.get(key);
  if (cached && cached.expiresAt > now && cached.version === version) return cached.value;
  const pendingKey = `${key}\0${version}`;
  const pending = inFlight.get(pendingKey);
  if (pending) return pending;

  const promise = (async () => {
    const discovered = await scanProjectTree(root, {
      maxDepth,
      maxDirectories: ASYNC_SCAN_MAX_DIRECTORIES,
      acceptFile: (name) => name.endsWith('.csproj') || name.endsWith('.sln') || name.endsWith('.slnx'),
    });
    const unityRoot = discovered.rules.scopes.some((scope) => scope.path === '' && scope.kind === 'unity');
    const value: DotnetProjectScan = unityRoot
      ? { projects: [], solutions: [], unityRoot: true }
      : {
          projects: discovered.files.filter((file) => file.toLowerCase().endsWith('.csproj')).sort(),
          solutions: discovered.files.filter((file) => /\.slnx?$/i.test(file)).sort(),
          unityRoot: false,
        };
    if (getProjectDiscoveryCacheVersion(root) === version) {
      asyncCache.set(key, {
        expiresAt: Date.now() + ASYNC_SCAN_CACHE_MS,
        version,
        value,
      });
    }
    return value;
  })().finally(() => {
    inFlight.delete(pendingKey);
  });
  inFlight.set(pendingKey, promise);
  return promise;
}

export function clearDotnetProjectScanCache(): void {
  asyncCache.clear();
}

/** Exact .csproj files in one directory (used for nearest-ancestor routing). */
export function csprojFilesInDir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.csproj'))
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}
