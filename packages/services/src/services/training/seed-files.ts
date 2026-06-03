/**
 * Raw filesystem seed source — reads real code straight from the project root
 * on disk, NO index required. This is the fallback that makes generation work
 * when `files`/`symbols` are empty (project added but never code-indexed).
 *
 * Dependency-free recursive walk honoring a default ignore set; filters by the
 * profile's extensions + import markers, reads bodies, caps the count.
 */
import { readFile, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, join } from 'node:path';
import type { StackProfile } from './stack-profiles.js';
import type { Seed } from './types.js';

const MAX_BODY_CHARS = 8_000;
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage',
  '__pycache__', '.cache', '.vscode', '.idea', 'out', '.turbo', '.venv', 'vendor',
]);

function matches(path: string, content: string, profile: StackProfile): boolean {
  if (!profile.extensions.some((ext) => path.endsWith(ext))) return false;
  if (profile.importMarkers.length === 0) return true;
  return profile.importMarkers.some((m) => content.includes(m));
}

/** Walk `root`, yielding files matching the profile, until `limit` seeds collected. */
export async function listProjectFileSeeds(
  root: string,
  profile: StackProfile,
  limit: number,
): Promise<Seed[]> {
  const seeds: Seed[] = [];

  async function walk(dir: string): Promise<void> {
    if (seeds.length >= limit) return;
    let entries: Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
    } catch {
      return;
    }
    for (const e of entries) {
      if (seeds.length >= limit) return;
      if (e.name.startsWith('.') && e.isDirectory()) continue;
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        await walk(join(dir, e.name));
        continue;
      }
      if (!profile.extensions.some((ext) => e.name.endsWith(ext))) continue;
      const full = join(dir, e.name);
      let content: string;
      try {
        content = await readFile(full, 'utf-8');
      } catch {
        continue;
      }
      if (!matches(e.name, content, profile)) continue;
      seeds.push({
        name: basename(e.name),
        filePath: full.slice(root.length + 1) || e.name,
        body: content.slice(0, MAX_BODY_CHARS),
        kind: 'file',
        source: 'project',
      });
    }
  }

  await walk(root);
  return seeds;
}
