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
import { globIterate } from 'glob';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { ScannedFile, ScanResult, ScanStats } from '@mcp/shared/types.js';
import { globPrunesForIndexIgnore, normalizeIndexIgnorePatterns } from '@mcp/shared/utils/index-ignore.js';
import { getProjectIgnoreRulesAsync, projectGlobPrunePatterns } from '@mcp/shared/utils/project-ignore.js';
import { applyGraphPromotion, classifyPath, isHardExcluded, type FileIndexTier } from '@mcp/indexer/indexer/mapper.js';
import { buildScannerIgnore, GLOB_PRUNE_DIRS, type ScannerIgnore } from '@mcp/indexer/indexer/scanner-ignore.js';
import { hashContent, countLines } from '@mcp/indexer/indexer/content-hash.js';
import { assignWorkspaceSlugs } from '@mcp/shared/utils/workspace-slug.js';

export interface ScanOptions {
  maxFiles?: number;
  /** Rebuild derived structure even when source bytes have not changed. */
  forceReparse?: boolean;
  /** Yield background disk work while an interactive operation has priority. */
  waitForInteractivePriority?: () => Promise<void>;
  /**
   * Liveness callback for the (otherwise silent) walk. `scanned` is files seen
   * so far; `total` is 0 until the candidate list is known (glob phase), then
   * the candidate count (stat phase). Throttled here by count — the service
   * coalesces again by time before it reaches the UI.
   */
  onScanProgress?: (scanned: number, total: number) => void;
}

/** Files between progress emits during the stat walk. */
const SCAN_STEP = 500;
/** Bound how long an interactive operation waits for the synchronous stat loop. */
const PRIORITY_YIELD_STEP = 100;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export class FileScanner {
  private rootPath: string;
  private ignorePatterns: string[];
  private maxFileSizeBytes: number;

  constructor(rootPath: string, ignorePatterns: string[] = [], maxFileSizeKB: number = 200) {
    this.rootPath = resolve(rootPath);
    this.ignorePatterns = normalizeIndexIgnorePatterns(ignorePatterns);
    this.maxFileSizeBytes = maxFileSizeKB * 1024;
  }

  async scan(db: CodeIndexDB, projectId: number, opts: ScanOptions = {}): Promise<ScanResult> {
    const project = db.getProject(projectId);
    const sources = project?.is_synthetic
      ? assignWorkspaceSlugs(db.listUnionProjectIds(projectId)).map((p) => ({
          rootPath: resolve(p.root_path),
          prefix: p.slug,
        }))
      : [{ rootPath: this.rootPath, prefix: '' }];
    const validFiles: Array<{ absolutePath: string; relativePath: string }> = [];
    let ignoredCount = 0;
    for (const source of sources) {
      await opts.waitForInteractivePriority?.();
      const sourceStat = statSync(source.rootPath, { throwIfNoEntry: false });
      if (!sourceStat?.isDirectory()) continue;
      // Synthetic projects are scanned as an explicit list of real roots from
      // the DB. We never ask glob to follow symlinks, so nested/untrusted links
      // cannot escape the declared workspace.
      const projectRules = await getProjectIgnoreRulesAsync(source.rootPath);
      const sourceIgnore: ScannerIgnore = buildScannerIgnore(
        source.rootPath,
        this.ignorePatterns,
        isHardExcluded,
        projectRules,
      );
      const projectPrunes = projectGlobPrunePatterns(projectRules);
      for await (const rawRelPath of globIterate('**/*', {
        cwd: source.rootPath,
        nodir: true,
        dot: false,
        absolute: false,
        ignore: [
          ...GLOB_PRUNE_DIRS.map((d) => `**/${d}/**`),
          ...projectPrunes,
          ...globPrunesForIndexIgnore(this.ignorePatterns),
        ],
      })) {
        const sourceRel = String(rawRelPath).replace(/\\/g, '/');
        if (sourceIgnore.ignores(sourceRel)) {
          ignoredCount++;
          continue;
        }
        validFiles.push({
          absolutePath: join(source.rootPath, sourceRel),
          relativePath: source.prefix ? `${source.prefix}/${sourceRel}` : sourceRel,
        });
        // Discovery liveness — total unknown (0) until the walk finishes. The
        // for-await already yields to the loop on each async tick.
        if (validFiles.length % PRIORITY_YIELD_STEP === 0) {
          if (validFiles.length % SCAN_STEP === 0) {
            opts.onScanProgress?.(validFiles.length, 0);
          }
          await opts.waitForInteractivePriority?.();
        }
        if (opts.maxFiles && validFiles.length > opts.maxFiles) {
          return {
            toIndex: [],
            unchanged: [],
            toRemove: [],
            totalFiles: validFiles.length,
            aborted: 'too_large',
            stats: { statOnly: 0, hashed: 0, skippedTooLarge: 0, ignored: ignoredCount },
          };
        }
      }
    }

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

    let processed = 0;
    for (const file of validFiles) {
      // Cooperative yield: this loop is fully synchronous (statSync/readFileSync)
      // and, in the in-process fallback, runs on the Electron MAIN thread — a
      // large project would block it solid (frozen UI that "never recovers").
      // Yielding every PRIORITY_YIELD_STEP files keeps IPC/foreground-priority
      // signals live; progress itself remains throttled to SCAN_STEP.
      if (processed > 0 && processed % PRIORITY_YIELD_STEP === 0) {
        if (processed % SCAN_STEP === 0) {
          opts.onScanProgress?.(processed, validFiles.length);
        }
        await yieldToEventLoop();
        await opts.waitForInteractivePriority?.();
      }
      processed++;

      const absPath = file.absolutePath;
      const normalizedPath = file.relativePath;

      const st = statSync(absPath, { throwIfNoEntry: false });
      if (!st?.isFile()) continue;
      if (st.size > this.maxFileSizeBytes) { stats.skippedTooLarge++; continue; }

      const meta = existingMeta.get(normalizedPath);
      existingMeta.delete(normalizedPath);
      const mtimeMs = Math.trunc(st.mtimeMs);

      // Stat-first shortcut: stored mtime+size match → unchanged, zero reads.
      if (!opts.forceReparse && !paranoid && meta && meta.content_hash
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
      if (!opts.forceReparse && meta && meta.content_hash === hash) {
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

    return { toIndex, unchanged, toRemove, totalFiles: toIndex.length + unchanged.length, stats };
  }

  /** @deprecated kept for callers/tests — use content-hash.ts going forward. */
  static hashContent(content: string): string {
    return hashContent(content);
  }

  static countLines(content: string): number {
    return countLines(content);
  }
}
