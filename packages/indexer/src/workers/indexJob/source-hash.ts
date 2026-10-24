/**
 * Deterministic source hash for a package directory.
 *
 * Computes a deterministic sha256 over the contents of `pkgDir`,
 * excluding directories that don't represent semantic source
 * (`node_modules`, `dist`, `storybook-static`, `.git`, `.cache`, etc.).
 *
 * Pure modulo I/O. No side effects beyond reading files.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_EXCLUDES = new Set<string>([
  'node_modules',
  'dist',
  'build',
  'storybook-static',
  '.git',
  '.cache',
  '.turbo',
  '.next',
  'coverage',
]);

export interface SourceHashOptions {
  /** Extra directory names (relative segments) to skip. Merged with defaults. */
  excludeDirs?: string[];
}

export async function computeSourceHash(
  pkgDir: string,
  opts: SourceHashOptions = {},
): Promise<string> {
  const exclude = new Set<string>([...DEFAULT_EXCLUDES, ...(opts.excludeDirs ?? [])]);
  const files = await collectFiles(pkgDir, exclude);
  files.sort();

  const hash = createHash('sha256');
  for (const rel of files) {
    const abs = join(pkgDir, rel);
    const buf = await readFile(abs);
    hash.update(rel);
    hash.update('\0');
    hash.update(buf);
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function collectFiles(root: string, exclude: Set<string>): Promise<string[]> {
  const out: string[] = [];
  await walk(root, '', exclude, out);
  return out;
}

async function walk(
  root: string,
  rel: string,
  exclude: Set<string>,
  out: string[],
): Promise<void> {
  const dir = rel ? join(root, rel) : root;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = String(entry.name);
    if (exclude.has(name)) continue;
    const childRel = rel ? `${rel}/${name}` : name;
    if (entry.isDirectory()) {
      await walk(root, childRel, exclude, out);
    } else if (entry.isFile()) {
      out.push(childRel);
    } else if (entry.isSymbolicLink()) {
      // Hash symlink targets as opaque metadata rather than chasing them —
      // chasing risks loops and inflates the hash with unrelated content.
      try {
        const s = await stat(join(root, childRel));
        if (s.isFile()) out.push(childRel);
      } catch {
        /* unreachable symlink — ignore */
      }
    }
  }
}
