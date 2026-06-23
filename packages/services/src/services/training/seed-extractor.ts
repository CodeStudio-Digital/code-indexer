/**
 * Seed extraction — pulls REAL code from the project index to ground the
 * teacher's example generation. Files are filtered by the active stack
 * profile (extensions + import markers); bodies are read from disk (the
 * index stores metadata, not content) and capped.
 *
 * For `react-shadcn-vite` the caller may additionally inject shadcn block
 * "golden examples" as `source: 'shadcn-block'` seeds (fetched via the
 * Shadcn_UI MCP at the orchestration layer) — this module stays pure I/O.
 */
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import * as filesDb from '@mcp/store/db/files.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { StackProfile } from './stack-profiles.js';
import type { Seed } from './types.js';

const MAX_BODY_CHARS = 8_000;

function matchesProfile(path: string, content: string, profile: StackProfile): boolean {
  if (!profile.extensions.some((ext) => path.endsWith(ext))) return false;
  if (profile.importMarkers.length === 0) return true;
  return profile.importMarkers.some((m) => content.includes(m));
}

export async function extractSeeds(
  db: CodeIndexDB,
  projectId: number,
  projectRoot: string,
  profile: StackProfile,
  limit: number,
): Promise<Seed[]> {
  const files = filesDb.list(db.raw(), projectId);
  const seeds: Seed[] = [];

  for (const f of files) {
    if (seeds.length >= limit) break;
    if (f.is_test || f.is_generated) continue;
    if (!profile.extensions.some((ext) => f.path.endsWith(ext))) continue;

    let content: string;
    try {
      content = await readFile(join(projectRoot, f.path), 'utf-8');
    } catch {
      continue; // file moved/deleted since indexing — skip
    }
    if (!matchesProfile(f.path, content, profile)) continue;

    seeds.push({
      symbolId: undefined,
      name: basename(f.path),
      filePath: f.path,
      body: content.slice(0, MAX_BODY_CHARS),
      kind: 'file',
      source: 'project',
    });
  }

  return seeds;
}
