import { readdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getProjectIgnoreRules,
  shouldIgnoreProjectPath,
} from '@mcp/shared/utils/project-ignore.js';

import { scanRunnerManifests, clearRunnerManifestCache } from './runner-manifests.js';

const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', 'bin', 'obj']);
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

export async function scanDotnetProjectsAsync(root: string, maxDepth = 6): Promise<DotnetProjectScan> {
  // File-run and dependency lookup need no PHP inventory. A Unity workspace
  // can answer this .NET-only query without walking its Assets directory.
  if ((await stat(join(root, 'ProjectSettings', 'ProjectVersion.txt')).catch(() => null))?.isFile()
      && (await stat(join(root, 'Assets')).catch(() => null))?.isDirectory()) {
    return { unityRoot: true, projects: [], solutions: [] };
  }
  return (await scanRunnerManifests(root, maxDepth)).dotnet;
}

export { clearRunnerManifestCache as clearDotnetProjectScanCache };

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
