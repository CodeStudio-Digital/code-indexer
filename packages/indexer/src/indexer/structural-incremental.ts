/**
 * Watcher-grade structural indexing — single files, full bookkeeping.
 *
 * Unlike `indexFileNow` (in-session symbol refresh: existing rows only, no
 * content_hash update), these create/update the `files` row, advance
 * `content_hash` (the anti-double-index guard for chokidar + agent-write +
 * Monaco fast-path all touching the same save) and maintain the content FTS.
 *
 * Path contract: project-relative, forward slashes (`scanner.ts` form).
 * Backslashes are normalized at this boundary.
 */
import { join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { mergeIndexIgnorePatterns, projectIndexIgnorePatterns } from '@mcp/shared/utils/index-ignore.js';
import { buildScannerIgnore } from '@mcp/indexer/indexer/scanner-ignore.js';
import { isHardExcluded } from '@mcp/indexer/indexer/mapper.js';
import { buildTreeSitterDispatch } from '@mcp/indexer/indexer/tree-sitter-dispatch.js';
import { hashContent, countLines } from './content-hash.js';
import { processFileStructural } from './indexer/process-file-structural.js';

export interface IndexFilesStructuralOptions {
  ignorePatterns?: string[];
  maxFileSizeKB?: number;
}

export interface IndexFilesStructuralResult {
  indexed: number;
  skippedUnchanged: number;
  skippedIgnored: number;
  /** Paths that turned out missing/oversized on disk and were removed. */
  removed: number;
  errors: number;
}

export async function indexFilesStructural(
  db: CodeIndexDB,
  projectId: number,
  relPaths: string[],
  opts: IndexFilesStructuralOptions = {},
): Promise<IndexFilesStructuralResult> {
  const project = db.getProject(projectId);
  if (!project) throw new Error(`project ${projectId} not found`);
  const root = project.root_path;
  const ig = buildScannerIgnore(
    root,
    mergeIndexIgnorePatterns(opts.ignorePatterns, projectIndexIgnorePatterns(project)),
    isHardExcluded,
  );
  const maxBytes = (opts.maxFileSizeKB ?? 200) * 1024;

  const result: IndexFilesStructuralResult = {
    indexed: 0, skippedUnchanged: 0, skippedIgnored: 0, removed: 0, errors: 0,
  };
  const treeSitter = buildTreeSitterDispatch();
  try {
    for (const rel of new Set(relPaths.map((p) => p.replace(/\\/g, '/')))) {
      try {
        if (ig.ignores(rel)) {
          result.skippedIgnored++;
          result.removed += removeFilesStructural(db, projectId, [rel]).removed;
          continue;
        }
        const abs = join(root, rel);
        const st = statSync(abs, { throwIfNoEntry: false });
        if (!st?.isFile() || st.size > maxBytes) {
          // Gone or over the cap — match the full scanner, which drops
          // oversized files from the index (they land in toRemove).
          result.removed += removeFilesStructural(db, projectId, [rel]).removed;
          continue;
        }
        const content = readFileSync(abs, 'utf-8');
        const hash = hashContent(content);
        const mtimeMs = Math.trunc(st.mtimeMs);
        const existing = db.getFile(projectId, rel);
        if (existing && existing.content_hash === hash) {
          // Already indexed under this content (in-session hook or an earlier
          // event in the same burst) — stamp mtime so scans stay stat-only.
          db.touchFileMtime(projectId, rel, mtimeMs);
          result.skippedUnchanged++;
          continue;
        }
        await processFileStructural(db, projectId, {
          path: abs, relativePath: rel, content, hash,
          sizeBytes: st.size, lineCount: countLines(content), mtimeMs,
        }, treeSitter);
        result.indexed++;
      } catch (err) {
        result.errors++;
        console.warn(`[structural-incremental] ${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    treeSitter.dispose();
  }
  return result;
}

/**
 * Remove files from the structural index. This worker owns no vector handles;
 * the semantic catch-up reconciles semantic_items against the remaining
 * source ids after the structural transaction. files_ad + FK cascades +
 * files_contents_ad clear every derived relational row.
 */
export function removeFilesStructural(
  db: CodeIndexDB,
  projectId: number,
  relPaths: readonly string[],
): { removed: number } {
  let removed = 0;
  for (const raw of relPaths) {
    const rel = raw.replace(/\\/g, '/');
    if (!db.getFile(projectId, rel)) continue;
    db.deleteFile(projectId, rel);
    removed++;
  }
  return { removed };
}
