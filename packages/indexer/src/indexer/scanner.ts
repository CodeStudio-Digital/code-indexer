/**
 * Stat-first project scanner.
 *
 * The old scan read + SHA-256'd EVERY candidate file on EVERY scan and kept
 * the content of all changed files in memory. This version:
 *
 *  1. Prunes hard-excluded directories in the glob walk itself
 *     (node_modules, .git, … never get listed, let alone read).
 *  2. Checks `fs.stat` first: size over the cap skips without reading; a
 *     stored `mtime_ms` + `size` match proves "unchanged" with zero bytes
 *     read (`MCP_SCAN_PARANOID=1` forces the old hash-everything behavior).
 *  3. Reads + hashes only when the stat gate can't decide. A hash match
 *     stamps the fresh mtime (`touchFileMtime`) so the NEXT scan takes the
 *     stat-only shortcut — this is also the automatic backfill for rows
 *     created before migration 137.
 *  4. Never returns file content — `ScannedFile.content` stays undefined and
 *     `processFile` reads lazily, so scan peak memory is O(1 file) instead
 *     of O(changed set).
 *
 * Known blind spot (same class as git's index): an edit that keeps BOTH
 * size and mtime (same-ms write, same byte count) passes the stat gate.
 * `MCP_SCAN_PARANOID` and `--force` exist for that.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { glob } from 'glob';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { ScannedFile, ScanResult, ScanStats } from '@mcp/shared/types.js';
import { applyGraphPromotion, classifyPath, isHardExcluded, type FileIndexTier } from '@mcp/indexer/indexer/mapper.js';
import { buildScannerIgnore, GLOB_PRUNE_DIRS, type ScannerIgnore } from '@mcp/indexer/indexer/scanner-ignore.js';
import { hashContent, countLines } from '@mcp/indexer/indexer/content-hash.js';

export class FileScanner {
  private rootPath: string;
  private ig: ScannerIgnore;
  private maxFileSizeBytes: number;

  constructor(rootPath: string, ignorePatterns: string[] = [], maxFileSizeKB: number = 200) {
    this.rootPath = resolve(rootPath);
    this.maxFileSizeBytes = maxFileSizeKB * 1024;
    this.ig = buildScannerIgnore(this.rootPath, ignorePatterns, isHardExcluded);
  }

  async scan(db: CodeIndexDB, projectId: number): Promise<ScanResult> {
    const allFiles = await glob('**/*', {
      cwd: this.rootPath,
      nodir: true,
      dot: false,
      absolute: false,
      // Prune hard-safe dirs in the walk itself — they were 100% filtered
      // out afterwards anyway; this skips listing them at all.
      ignore: GLOB_PRUNE_DIRS.map((d) => `**/${d}/**`),
    });

    const validFiles = allFiles.filter((relPath) => !this.ig.ignores(relPath));
    const ignoredCount = allFiles.length - validFiles.length;

    // Slim metadata (4 columns), not full rows with summaries/concepts.
    const existingMeta = new Map(
      db.listFileScanMeta(projectId).map((m) => [m.path, m]),
    );
    // In-degree from prior indexing — drives mapper promotion. Empty on
    // first run; refined on every subsequent reindex.
    const indegrees = db.getFileIndegrees(projectId);
    const paranoid = process.env.MCP_SCAN_PARANOID === '1';

    const toIndex: ScannedFile[] = [];
    const unchanged: string[] = [];
    const stats: ScanStats = { statOnly: 0, hashed: 0, skippedTooLarge: 0, ignored: ignoredCount };

    for (const relPath of validFiles) {
      const absPath = join(this.rootPath, relPath);
      const normalizedPath = relPath.replace(/\\/g, '/');

      const st = statSync(absPath, { throwIfNoEntry: false });
      if (!st?.isFile()) continue;
      if (st.size > this.maxFileSizeBytes) { stats.skippedTooLarge++; continue; }

      const meta = existingMeta.get(normalizedPath);
      existingMeta.delete(normalizedPath);
      const mtimeMs = Math.trunc(st.mtimeMs);

      // Stat-first shortcut: stored mtime+size match → unchanged, zero reads.
      if (!paranoid && meta && meta.content_hash
          && meta.mtime_ms === mtimeMs && meta.size === st.size) {
        stats.statOnly++;
        unchanged.push(normalizedPath);
        continue;
      }

      let content: string;
      try {
        content = readFileSync(absPath, 'utf-8');
      } catch {
        continue; // unreadable — skip (and forget: deletion handled below)
      }
      stats.hashed++;

      const hash = hashContent(content);
      if (meta && meta.content_hash === hash) {
        // mtime moved but content didn't (git checkout, touch) — stamp the
        // fresh mtime so the next scan is stat-only again.
        db.touchFileMtime(projectId, normalizedPath, mtimeMs);
        unchanged.push(normalizedPath);
        continue;
      }

      const classification = classifyPath(normalizedPath, st.size);
      // `classifyPath` may demote a file to `excluded` based on size or
      // path tokens that the cheap `isHardExcluded` upstream missed.
      if (classification.tier === 'excluded') continue;
      const indegree = indegrees.get(normalizedPath);
      const promotedTier = applyGraphPromotion(classification.tier, indegree);
      const reason =
        promotedTier !== classification.tier
          ? `${classification.reason} + graph promotion (indegree=${indegree})`
          : classification.reason;
      toIndex.push({
        path: absPath,
        relativePath: normalizedPath,
        // content intentionally NOT carried — processFile reads lazily.
        hash,
        sizeBytes: st.size,
        lineCount: countLines(content),
        mtimeMs,
        tier: promotedTier as Exclude<FileIndexTier, 'excluded'>,
        mapperReason: reason,
      });
    }

    // Remaining entries in existingMeta are files to remove.
    const toRemove = Array.from(existingMeta.keys());

    return { toIndex, unchanged, toRemove, stats };
  }

  /** @deprecated kept for callers/tests — use content-hash.ts going forward. */
  static hashContent(content: string): string {
    return hashContent(content);
  }

  static countLines(content: string): number {
    return countLines(content);
  }
}
