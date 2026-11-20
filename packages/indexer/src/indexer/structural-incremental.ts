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
import type { ScannedFile } from '@mcp/shared/types.js';
import { mergeIndexIgnorePatterns, projectIndexIgnorePatterns } from '@mcp/shared/utils/index-ignore.js';
import { buildScannerIgnore } from '@mcp/indexer/indexer/scanner-ignore.js';
import { isHardExcluded } from '@mcp/indexer/indexer/mapper.js';
import { buildTreeSitterDispatch } from '@mcp/indexer/indexer/tree-sitter-dispatch.js';
import { hashContent, countLines } from './content-hash.js';
import { withConcurrency } from './indexer/enrich-references.js';
import {
  persistPreparedFileStructural,
  prepareFileStructural,
  type PreparedFileStructural,
} from './indexer/process-file-structural.js';
import { resolveStructuralPipelineSchedule } from './structural-pipeline-schedule.js';
import { assignWorkspaceSlugs } from '@mcp/shared/utils/workspace-slug.js';
import { canEnumerate } from './scanner.js';

export interface IndexFilesStructuralOptions {
  ignorePatterns?: string[];
  maxFileSizeKB?: number;
  concurrency?: number;
}

export interface IndexFilesStructuralResult {
  indexed: number;
  skippedUnchanged: number;
  skippedIgnored: number;
  /** Paths that turned out missing/oversized on disk and were removed. */
  removed: number;
  errors: number;
  failedPaths: string[];
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
  const linkedRoots = project.is_synthetic
    ? new Map(assignWorkspaceSlugs(db.listUnionProjectIds(projectId)).map(source => [source.slug, source.root_path]))
    : undefined;
  const ig = buildScannerIgnore(
    root,
    mergeIndexIgnorePatterns(opts.ignorePatterns, projectIndexIgnorePatterns(project)),
    isHardExcluded,
  );
  const maxBytes = (opts.maxFileSizeKB ?? 200) * 1024;

  const result: IndexFilesStructuralResult = {
    indexed: 0, skippedUnchanged: 0, skippedIgnored: 0, removed: 0, errors: 0, failedPaths: [],
  };
  const candidates: ScannedFile[] = [];
  const removals: string[] = [];
  const touches: Array<{ path: string; mtimeMs: number }> = [];

  for (const rel of new Set(relPaths.map((p) => p.replace(/\\/g, '/')))) {
    try {
      if (ig.ignores(rel)) {
        result.skippedIgnored++;
        removals.push(rel);
        continue;
      }
      const [prefix] = rel.split('/', 1);
      const sourceRoot = linkedRoots ? linkedRoots.get(prefix!) : root;
      if (!sourceRoot) {
        removals.push(rel);
        continue;
      }
      const abs = join(sourceRoot, linkedRoots ? rel.slice(prefix!.length + 1) : rel);
      const st = statSync(abs, { throwIfNoEntry: false });
      if (!st?.isFile() || st.size > maxBytes) {
        if (!st && !canEnumerate(sourceRoot)) throw new Error('Source unavailable: ' + sourceRoot);
        // Gone or over the cap — match the full scanner, which drops
        // oversized files from the index (they land in toRemove).
        removals.push(rel);
        continue;
      }
      const content = readFileSync(abs, 'utf-8');
      const hash = hashContent(content);
      const mtimeMs = Math.trunc(st.mtimeMs);
      const existing = db.getFile(projectId, rel);
      if (existing && existing.content_hash === hash) {
        touches.push({ path: rel, mtimeMs });
        continue;
      }
      candidates.push({
        path: abs,
        relativePath: rel,
        content,
        hash,
        sizeBytes: st.size,
        lineCount: countLines(content),
        mtimeMs,
      });
    } catch (err) {
      result.errors++;
      result.failedPaths.push(rel);
      console.warn(`[structural-incremental] ${rel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const schedule = resolveStructuralPipelineSchedule(
    db.useProjectDb(projectId),
    opts.concurrency ?? 5,
  );

  // Validation above is read-only. All SQLite mutations now flow through this
  // single writer stage before parser work begins.
  const maintenance = [
    ...removals.map((path) => ({ kind: 'remove' as const, path })),
    ...touches.map((touch) => ({ kind: 'touch' as const, ...touch })),
  ];
  for (let offset = 0; offset < maintenance.length; offset += schedule.writeBatchSize) {
    const wave = maintenance.slice(offset, offset + schedule.writeBatchSize);
    let waveRemoved = 0;
    let waveSkippedUnchanged = 0;
    let waveErrors = 0;
    try {
      db.indexTransaction(projectId, () => {
        for (const item of wave) {
          try {
            if (item.kind === 'remove') {
              waveRemoved += removeFilesStructural(db, projectId, [item.path]).removed;
            } else {
              db.touchFileMtime(projectId, item.path, item.mtimeMs);
              waveSkippedUnchanged++;
            }
          } catch (error) {
            waveErrors++;
            result.failedPaths.push(item.path);
            console.warn(
              `[structural-incremental] ${item.path}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      });
      result.removed += waveRemoved;
      result.skippedUnchanged += waveSkippedUnchanged;
      result.errors += waveErrors;
    } catch (error) {
      // Commit failure rolls back the whole wave, including successful items.
      result.errors += wave.length;
      result.failedPaths.push(...wave.map((item) => item.path));
      console.warn(
        `[structural-incremental] maintenance wave: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if ((offset + wave.length) % schedule.yieldEvery === 0) await yieldToEventLoop();
  }

  const treeSitter = buildTreeSitterDispatch();
  try {
    for (let offset = 0; offset < candidates.length; offset += schedule.writeBatchSize) {
      const wave = candidates.slice(offset, offset + schedule.writeBatchSize);
      const outcomes: Array<{
        file: ScannedFile;
        prepared?: PreparedFileStructural;
        error?: unknown;
      }> = new Array(wave.length);

      await withConcurrency(wave, async (file, index) => {
        try {
          outcomes[index] = {
            file,
            prepared: await prepareFileStructural(file, treeSitter),
          };
        } catch (error) {
          outcomes[index] = { file, error };
        }
      }, schedule.parseConcurrency);

      let waveIndexed = 0;
      let waveErrors = 0;
      try {
        db.indexTransaction(projectId, () => {
          for (const outcome of outcomes) {
            if (outcome.error || !outcome.prepared) {
              waveErrors++;
              result.failedPaths.push(outcome.file.relativePath);
              console.warn(
                `[structural-incremental] ${outcome.file.relativePath}: ` +
                `${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`,
              );
              continue;
            }
            try {
              // A failed file must not leave half its symbols/FTS committed in the wave.
              db.indexTransaction(projectId, () => persistPreparedFileStructural(db, projectId, outcome.prepared!));
              waveIndexed++;
            } catch (error) {
              waveErrors++;
              result.failedPaths.push(outcome.file.relativePath);
              console.warn(
                `[structural-incremental] ${outcome.file.relativePath}: ` +
                `${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        });
        result.indexed += waveIndexed;
        result.errors += waveErrors;
      } catch (error) {
        // Every prepared item was rolled back; parse failures still count once.
        result.errors += outcomes.length;
        result.failedPaths.push(...outcomes.map((outcome) => outcome.file.relativePath));
        console.warn(
          `[structural-incremental] write wave: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if ((offset + wave.length) % schedule.yieldEvery === 0) await yieldToEventLoop();
    }
  } finally {
    treeSitter.dispose();
  }
  result.failedPaths = [...new Set(result.failedPaths)];
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
