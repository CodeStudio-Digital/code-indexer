import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TREE_BLOCK_DIRS } from '@mcp/shared/utils/fs-ignore.js';

const MAX_DEPTH = 6;
const MAX_DIRECTORIES = 4_096;
const SKIP_DIRS = new Set([
  ...TREE_BLOCK_DIRS.map((name) => name.toLowerCase()),
  'vendor',
  '.hg',
  '.svn',
]);

interface PendingDirectory {
  absolute: string;
  relative: string;
  depth: number;
}

function childPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function mayDescend(name: string, depth: number, maxDepth: number): boolean {
  return depth < maxDepth && !name.startsWith('.') && !SKIP_DIRS.has(name.toLowerCase());
}

/**
 * Discover project-owned composer manifests without walking dependency/build
 * forests. Directory symlinks are excluded by Dirent#isDirectory and both the
 * depth and visited-directory caps keep detection bounded on large workspaces.
 */
export function scanComposerProjects(root: string, maxDepth = MAX_DEPTH): string[] {
  const files: string[] = [];
  const queue: PendingDirectory[] = [{ absolute: root, relative: '', depth: 0 }];
  let index = 0;

  while (index < queue.length && index < MAX_DIRECTORIES) {
    const current = queue[index++]!;
    let entries;
    try {
      entries = readdirSync(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relative = childPath(current.relative, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === 'composer.json') {
        files.push(relative);
      } else if (entry.isDirectory() && mayDescend(entry.name, current.depth, maxDepth)) {
        queue.push({ absolute: join(current.absolute, entry.name), relative, depth: current.depth + 1 });
      }
    }
  }

  return files.sort();
}

export { clearRunnerManifestCache as clearComposerProjectScanCache } from './runner-manifests.js';
