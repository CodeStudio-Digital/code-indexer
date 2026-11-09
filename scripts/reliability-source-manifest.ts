import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Include untracked implementation sources, never profile/config secrets. */
export function captureReliabilitySource(root: string) {
  const files: { path: string; sha256: string }[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', '.tmp', '.git', '.smoke', '__screenshots__'].includes(entry.name)) visit(path);
      } else if (/\.(?:ts|tsx|js|mjs|cjs|json|txt|md)$/.test(entry.name)) {
        files.push({ path: relative(root, path).replaceAll('\\', '/'), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
      }
    }
  };
  for (const directory of ['packages', 'apps']) visit(join(root, directory));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root, files: files.length, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    scope: 'packages/apps source including untracked files; excludes build outputs, dependencies and user data' };
}
