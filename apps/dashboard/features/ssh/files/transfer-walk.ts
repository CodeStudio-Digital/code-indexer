/**
 * Pure transfer planning — no React, no I/O beyond the adapter's `list`. Given a
 * set of top-level items, BFS the source into a flat file list plus the relative
 * directories to pre-create on the destination (parent-first, so a non-recursive
 * remote `mkdir` succeeds in order). Guards against symlink-dir loops and
 * runaway trees. Kept side-effect-free so it's unit-testable with a fake adapter.
 */

import { mapLimit } from '@mcp/shared/utils/map-limit.js';
import type { FsAdapter, FsItem } from './fs-adapter.js';

/**
 * Concurrent directory listings during the walk. Each remote listing rides the
 * shared SFTP browse session, so this is bounded by politeness rather than by
 * OpenSSH's per-connection channel limit (that constrains TRANSFERS — see
 * TRANSFER_CONCURRENCY in transfer-controller.ts).
 */
const WALK_CONCURRENCY = 6;

export interface PlannedFile {
  /** Source path (adapter-native). */
  srcPath: string;
  /** Path relative to the transfer root (starts with the top-level item's name). */
  relPath: string;
  size: number;
}

export interface TransferPlan {
  /** Relative directory paths to pre-create on the destination, parent-first. */
  dirs: string[];
  files: PlannedFile[];
}

const MAX_DEPTH = 40;
const MAX_ENTRIES = 20_000;

export async function planTransfer(items: FsItem[], src: FsAdapter): Promise<TransferPlan> {
  const dirs: string[] = [];
  const files: PlannedFile[] = [];
  const queue: Array<{ path: string; rel: string; depth: number }> = [];

  for (const it of items) {
    if (it.type === 'dir') {
      dirs.push(it.name);
      queue.push({ path: it.path, rel: it.name, depth: 0 });
    } else if (it.type === 'file') {
      files.push({ srcPath: it.path, relPath: it.name, size: it.size });
    }
    // symlink/other are skipped — not safe to blindly copy.
  }

  // BFS a LEVEL at a time, listing siblings concurrently. Each remote `list` is
  // a full SFTP round-trip, and doing them one at a time meant a 100-directory
  // tree spent 100 sequential round-trips before a single byte moved. Levels
  // stay ordered (parents before children) so `dirs` remains parent-first,
  // which the destination's non-recursive mkdir depends on.
  let count = 0;
  let level = queue.splice(0, queue.length);
  while (level.length > 0) {
    const listings = await mapLimit(level, WALK_CONCURRENCY, (cur) =>
      cur.depth >= MAX_DEPTH ? Promise.resolve([]) : src.list(cur.path),
    );
    const nextLevel: typeof level = [];
    for (let i = 0; i < level.length; i += 1) {
      const cur = level[i];
      for (const e of listings[i]) {
        if (++count > MAX_ENTRIES) throw new Error('too_many_files');
        const rel = `${cur.rel}/${e.name}`;
        if (e.type === 'dir') {
          dirs.push(rel);
          nextLevel.push({ path: e.path, rel, depth: cur.depth + 1 });
        } else if (e.type === 'file') {
          files.push({ srcPath: e.path, relPath: rel, size: e.size });
        }
      }
    }
    level = nextLevel;
  }
  return { dirs, files };
}

/** Fold a relative posix path onto a base using the destination adapter's `join`. */
export function foldPath(join: (dir: string, name: string) => string, base: string, rel: string): string {
  if (!rel) return base;
  return rel.split('/').reduce((acc, seg) => join(acc, seg), base);
}

/** Rewrite the leading path segment of every entry (`keep both` renames the root). */
export function remapRoot(plan: TransferPlan, oldRoot: string, newRoot: string): TransferPlan {
  const swap = (p: string): string =>
    p === oldRoot ? newRoot : p.startsWith(`${oldRoot}/`) ? `${newRoot}${p.slice(oldRoot.length)}` : p;
  return { dirs: plan.dirs.map(swap), files: plan.files.map((f) => ({ ...f, relPath: swap(f.relPath) })) };
}

/** Split a name into [base, ext] — ext kept only for files (`a.txt` → `a` + `.txt`). */
export function splitNameExt(name: string, isFile: boolean): [string, string] {
  if (!isFile) return [name, ''];
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
}

/** First `name (n)` not already present in `taken` (the "keep both" rename). */
export function nextFreeName(name: string, taken: Set<string>, isFile: boolean): string {
  const [base, ext] = splitNameExt(name, isFile);
  for (let i = 1; i < 1000; i += 1) {
    const cand = `${base} (${i})${ext}`;
    if (!taken.has(cand)) return cand;
  }
  return `${base} (${taken.size + 1})${ext}`;
}
