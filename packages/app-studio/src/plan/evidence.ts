import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const INCLUDED_ROOTS = ['src', 'worker', 'migrations', 'seeds', 'tests'] as const;
const IGNORED = new Set(['node_modules', '.git', '.wrangler', 'dist', 'coverage']);

/** Stable proof that the implementation/database files still match recorded evidence. */
export function appWorkspaceFingerprint(workspaceDir: string): string {
  const hash = createHash('sha256');
  const visit = (path: string): void => {
    let entries;
    try { entries = readdirSync(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (IGNORED.has(entry.name)) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) {
        try {
          if (statSync(child).size > 2_000_000) continue;
          hash.update(relative(workspaceDir, child).replaceAll('\\', '/'));
          hash.update(readFileSync(child));
        } catch { /* a concurrent edit invalidates the next fingerprint */ }
      }
    }
  };
  for (const root of INCLUDED_ROOTS) visit(join(workspaceDir, root));
  return hash.digest('hex');
}
