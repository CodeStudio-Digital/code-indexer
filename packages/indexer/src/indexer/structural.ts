/**
 * Structural-only project indexing — IntelliJ's "dumb mode" pass.
 *
 * scanner (stat-first, hash-incremental) → tree-sitter → symbols/deps/refs +
 * content FTS. No LLM, no embeddings, no cost tracking, no provider — which
 * is exactly what lets this run automatically on project open (freemium/BYOK:
 * zero spend) and inside the dedicated indexer worker (no singletons to wire).
 *
 * This is the only code-index build path. Semantic embeddings consume its
 * durable files/symbols after the baseline is ready and remain independently
 * replaceable by generation.
 */
import { join } from 'node:path';
import { StructuralGeneration } from './structural-generation.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { MAX_CONTENT_BYTES, type ContentBackfillCandidate } from '@mcp/store/db/file-contents.js';
import { mergeIndexIgnorePatterns, projectIndexIgnorePatterns } from '@mcp/shared/utils/index-ignore.js';
import { FileScanner } from '@mcp/indexer/indexer/scanner.js';
import { readDeferredScannedFile, readFileContentByHash } from './scanned-file-snapshot.js';
import { buildTreeSitterDispatch } from '@mcp/indexer/indexer/tree-sitter-dispatch.js';
import { withConcurrency } from './indexer/enrich-references.js';
import {
  persistPreparedFileStructural,
  prepareFileStructural,
  type PreparedFileStructural,
} from './indexer/process-file-structural.js';
import { resolveStructuralPipelineSchedule } from './structural-pipeline-schedule.js';
import { removeFilesStructural } from './structural-incremental.js';
import { semanticItemKeysForIndexedPaths } from './indexer/embedding-candidates.js';

export { resolveStructuralPipelineSchedule } from './structural-pipeline-schedule.js';

const MAX_ATOMIC_DELTA_FILES = 1_000;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface StructuralProgress {
  current: number;
  total: number;
  currentFile: string;
  /** 'scanning' (silent tree walk, total may be 0) vs 'indexing' (per-file pass). */
  phase?: 'scanning' | 'indexing';
}

export interface StructuralIndexOptions {
  onProgress?: (p: StructuralProgress) => void;
  /**
   * Exact scanner delta, acknowledged before the first structural mutation.
   * The semantic coordinator uses this fence to capture the previous item keys
   * for deletes/edits instead of falling back to a whole-project wildcard.
   */
  onChanges?: (
    events: ReadonlyArray<{ path: string; kind: 'upsert' | 'delete' }>,
    previousItemKeys: readonly string[],
  ) => void | Promise<void>;
  /** Cooperative abort — remaining files are skipped, run finishes as failed. */
  signal?: AbortSignal;
  /** Cooperative foreground-I/O priority checkpoint. */
  waitForInteractivePriority?: () => Promise<void>;
  /** Candidate-count gate: above this the run bails with `aborted: 'too_large'` (project untouched). */
  maxFiles?: number;
  /** Explicit repair of derived rows from older indexer versions. */
  forceReparse?: boolean;
  verifyPaths?: string[];
  /**
   * Escape hatch for the empty-scan anti-wipe guard (manual reindex only):
   * a scan that finds ZERO files but would remove existing rows is treated
   * as a misconfiguration (wrong root_path, aggressive ignore, unmounted
   * drive) and aborted — wiping a good index is far worse than staleness.
   */
  allowEmptyWipe?: boolean;
  concurrency?: number;
  ignorePatterns?: string[];
  maxFileSizeKB?: number;
}

export interface StructuralPhaseTimings {
  scanMs: number;
  parseMs: number;
  writeMs: number;
  sweepMs: number;
}

export interface StructuralIndexResult {
  unavailableRoots?: string[];
  runId?: number;
  totalFiles: number;
  indexed: number;
  removed: number;
  skipped: number;
  errorCount: number;
  durationMs: number;
  phaseTimings: StructuralPhaseTimings;
  peakRssMb: number;
  aborted?: 'too_large' | 'signal' | 'empty_scan';
}

export async function runStructuralIndex(
  db: CodeIndexDB,
  projectId: number,
  opts: StructuralIndexOptions = {},
): Promise<StructuralIndexResult> {
  const startTime = Date.now();
  const phaseTimings: StructuralPhaseTimings = {
    scanMs: 0,
    parseMs: 0,
    writeMs: 0,
    sweepMs: 0,
  };
  let peakRssMb = Math.ceil(process.memoryUsage().rss / 1024 / 1024);
  const sampleRss = (): void => {
    peakRssMb = Math.max(peakRssMb, Math.ceil(process.memoryUsage().rss / 1024 / 1024));
  };
  const project = db.getProject(projectId);
  if (!project) throw new Error(`project ${projectId} not found`);
  await opts.waitForInteractivePriority?.();

  // Tiered-hybrid split (plan §8): lazily migrate this project's INDEX tables
  // into its own DB before indexing. No-op unless the split flags are on and the
  // project is still 'pending'. Fail-open: a split error never blocks indexing.
  try {
    db.ensureProjectSplit(projectId);
  } catch (e) {
    console.warn(`[structural] project-db split skipped for ${projectId}:`, (e as Error).message);
  }

  const maxFileSizeKB = opts.maxFileSizeKB ?? 200;
  const scanner = new FileScanner(
    project.root_path,
    mergeIndexIgnorePatterns(opts.ignorePatterns, projectIndexIgnorePatterns(project)),
    maxFileSizeKB,
  );
  const scanStarted = Date.now();
  const scan = await scanner.scan(db, projectId, {
    signal: opts.signal,
    deferNewFileReads: true,
    maxFiles: opts.maxFiles,
    forceReparse: opts.forceReparse,
    verifyPaths: opts.verifyPaths?.length ? new Set(opts.verifyPaths) : undefined,
    waitForInteractivePriority: opts.waitForInteractivePriority,
    // Keep the "Scanning…" chip alive during the walk (total unknown → 0).
    onScanProgress: (scanned, total) =>
      opts.onProgress?.({ phase: 'scanning', current: scanned, total, currentFile: '' }),
  }).catch((error: unknown) => {
    if (!opts.signal?.aborted) throw error;
    return undefined;
  });
  phaseTimings.scanMs = Date.now() - scanStarted;
  sampleRss();
  if (!scan || opts.signal?.aborted) {
    return {
      totalFiles: 0, indexed: 0, removed: 0, skipped: 0, errorCount: 0,
      durationMs: Date.now() - startTime, phaseTimings, peakRssMb, aborted: 'signal',
    };
  }
  const totalFiles = scan.totalFiles ?? scan.toIndex.length + scan.unchanged.length;
  const partial = scan.unavailableRoots?.length ? { unavailableRoots: scan.unavailableRoots } : undefined;

  if (scan.aborted === 'too_large' || (opts.maxFiles && totalFiles > opts.maxFiles)) {
    return {
      totalFiles, indexed: 0, removed: 0, skipped: scan.unchanged.length,
      errorCount: 0, durationMs: Date.now() - startTime,
      phaseTimings, peakRssMb, aborted: 'too_large',
    };
  }

  // Anti-wipe guard: a scan that sees ZERO files while the index has rows is
  // almost always a broken root (renamed/unmounted path, ignore file that
  // excludes everything, getByPath mismatch) — removing `toRemove` here would
  // erase the whole index. Bail with a diagnosable marker instead.
  if (totalFiles === 0 && scan.toRemove.length > 0 && !opts.allowEmptyWipe) {
    console.error(
      `[structural] scan found 0 files at ${project.root_path} but the index has ${scan.toRemove.length} — ` +
      `refusing to wipe (ignored by scanner filters: ${scan.stats?.ignored ?? '?'}). ` +
      `Check project root / .gitignore / .mcpindexignore; manual reindex overrides.`,
    );
    return {
      totalFiles: 0, indexed: 0, removed: 0, skipped: 0,
      errorCount: 0, durationMs: Date.now() - startTime,
      phaseTimings, peakRssMb, aborted: 'empty_scan',
    };
  }

  // A reopen reconciliation that found no path/hash changes is a health
  // check, not an indexing job. Keep the integral baseline/counters current
  // (and repair legacy missing content coverage) without polluting `runs` or
  // the user-facing activity history with a fake 0/N execution.
  if (scan.toIndex.length === 0 && scan.toRemove.length === 0) {
    if (partial) return {
      ...partial, totalFiles, indexed: 0, removed: 0, skipped: scan.unchanged.length,
      errorCount: 0, durationMs: Date.now() - startTime, phaseTimings, peakRssMb,
    };
    let coverageErrors = 0;
    await opts.waitForInteractivePriority?.();
    const sweepStarted = Date.now();
    try {
      const sweep = await sweepContentCoverage(db, projectId, project.root_path, opts);
      if (sweep.added > 0) console.error(`[structural] Content coverage sweep: ${sweep.added} file(s) backfilled`);
    } catch (err) {
      coverageErrors++;
      console.error('[structural] Content coverage sweep failed:', err);
    }
    phaseTimings.sweepMs += Date.now() - sweepStarted;
    sampleRss();
    if (opts.signal?.aborted) {
      return {
        totalFiles, indexed: 0, removed: 0, skipped: scan.unchanged.length,
        errorCount: coverageErrors, durationMs: Date.now() - startTime,
        phaseTimings, peakRssMb, aborted: 'signal',
      };
    }
    const stats = db.getStructuralCounts(projectId);
    const checkedAt = new Date().toISOString();
    const needsMetadataRepair = stats.file_count !== project.file_count
      || stats.symbol_count !== project.symbol_count
      || (!project.structural_indexed_at && stats.file_count > 0);
    if (needsMetadataRepair) {
      db.updateProject(projectId, {
        file_count: stats.file_count,
        symbol_count: stats.symbol_count,
        structural_last_checked_at: checkedAt,
        ...(!project.structural_indexed_at && stats.file_count > 0
          ? { structural_indexed_at: checkedAt }
          : {}),
      });
    } else {
      db.markProjectStructuralChecked(projectId, checkedAt);
    }
    return {
      totalFiles,
      indexed: 0,
      removed: 0,
      skipped: scan.unchanged.length,
      errorCount: coverageErrors,
      durationMs: Date.now() - startTime,
      phaseTimings,
      peakRssMb,
    };
  }

  const reportChanges = async (events: Array<{ path: string; kind: 'upsert' | 'delete' }>) => {
    if (!opts.onChanges || events.length === 0) return;
    const previousItemKeys = semanticItemKeysForIndexedPaths(db, projectId, events.map((event) => event.path));
    await opts.onChanges(events, previousItemKeys);
  };
  // Keep full publication atomic for small deltas. Large builds re-use the
  // same per-file transaction and commit the waves directly, so a restart
  // rediscovers only the uncommitted paths and never has to replay staging.
  const batched = scan.toRemove.length + scan.toIndex.length > MAX_ATOMIC_DELTA_FILES;
  if (!batched) {
    await reportChanges([
      ...scan.toRemove.map((path) => ({ path, kind: 'delete' as const })),
      ...scan.toIndex.map((file) => ({ path: file.relativePath, kind: 'upsert' as const })),
    ]);
  }
  await opts.waitForInteractivePriority?.();

  const pipelineSchedule = resolveStructuralPipelineSchedule(
    db.useProjectDb(projectId),
    opts.concurrency ?? 5,
  );

  let removed = 0;
  const generation = new StructuralGeneration(db, projectId);
  const runId = db.startRun(projectId);

  let indexed = 0;
  let unavailable = 0;
  let errorCount = 0;
  let aborted: StructuralIndexResult['aborted'];
  let completed = 0;
  if (scan.toIndex.length > 0) {
    const treeSitter = buildTreeSitterDispatch();
    try {
      for (
        let offset = 0;
        offset < scan.toIndex.length && !opts.signal?.aborted;
        offset += pipelineSchedule.writeBatchSize
      ) {
        await opts.waitForInteractivePriority?.();
        const wave = scan.toIndex.slice(offset, offset + pipelineSchedule.writeBatchSize);
        const outcomes: Array<{
          file: (typeof wave)[number];
          prepared?: PreparedFileStructural;
          error?: unknown;
          aborted?: boolean;
          unavailable?: boolean;
        }> = new Array(wave.length);

        const parseStarted = Date.now();
        await withConcurrency(wave, async (file, index) => {
          if (opts.signal?.aborted) {
            outcomes[index] = { file, aborted: true };
            return;
          }
          try {
            const source = 'deferred' in file ? readDeferredScannedFile(file, maxFileSizeKB * 1024) : file;
            outcomes[index] = source
              ? { file, prepared: await prepareFileStructural(source, treeSitter) }
              : { file, unavailable: true };
          } catch (error) {
            outcomes[index] = { file, error };
          }
        }, pipelineSchedule.parseConcurrency);
        phaseTimings.parseMs += Date.now() - parseStarted;
        sampleRss();

        let waveIndexed = 0;
        let waveErrors = 0;
        const writeStarted = Date.now();
        try {
          if (batched) {
            const events = outcomes.flatMap(({ file, prepared }) =>
              prepared ? [{ path: file.relativePath, kind: 'upsert' as const }] : []);
            if (!opts.signal?.aborted) await reportChanges(events);
            await opts.waitForInteractivePriority?.();
            if (opts.signal?.aborted) { aborted = 'signal'; break; }
          }
          db.indexTransaction(projectId, () => {
            for (const outcome of outcomes) {
              if (outcome.aborted) {
                aborted = 'signal';
                continue;
              }
              if (outcome.unavailable) {
                unavailable++;
                // A previously indexed file that disappeared or became unreadable
                // during repair must keep its rows and cannot certify a full repair.
                if (opts.forceReparse && db.getFile(projectId, outcome.file.relativePath)) waveErrors++;
                continue;
              }
              if (outcome.error || !outcome.prepared) {
                waveErrors++;
                console.error(`[structural] Error preparing ${outcome.file.relativePath}:`, outcome.error);
                continue;
              }
              try {
                if (batched) persistPreparedFileStructural(db, projectId, outcome.prepared);
                else generation.stage(outcome.prepared);
                waveIndexed++;
              } catch (error) {
                waveErrors++;
                console.error(`[structural] Error persisting ${outcome.file.relativePath}:`, error);
              }
            }
          });
          indexed += waveIndexed;
          errorCount += waveErrors;
        } catch (error) {
          // A commit-level failure rolls the whole wave back. Per-file failures
          // above are isolated by nested savepoints and do not reach this path.
          errorCount += outcomes.filter((outcome) => !outcome.aborted && !outcome.unavailable).length;
          console.error('[structural] Error committing structural write wave:', error);
        }
        phaseTimings.writeMs += Date.now() - writeStarted;
        sampleRss();

        for (const outcome of outcomes) {
          if (outcome.aborted) continue;
          const current = ++completed;
          opts.onProgress?.({
            phase: 'indexing',
            current,
            total: scan.toIndex.length,
            currentFile: outcome.file.relativePath,
          });
        }
        if (batched && errorCount > 0) break;
        if (completed % pipelineSchedule.yieldEvery === 0) await yieldToEventLoop();
      }
      if (opts.signal?.aborted) aborted = 'signal';
    } finally {
      treeSitter.dispose();
    }
  }

  if (!aborted && errorCount === 0 && unavailable === totalFiles
      && scan.toRemove.length > 0 && !opts.allowEmptyWipe) {
    aborted = 'empty_scan';
    console.error(`[structural] all deferred files were unavailable for project ${projectId} — preserving the existing index`);
  }
  if (batched) {
    for (let offset = 0; !aborted && errorCount === 0 && offset < scan.toRemove.length; offset += pipelineSchedule.writeBatchSize) {
      const paths = scan.toRemove.slice(offset, offset + pipelineSchedule.writeBatchSize);
      const writeStarted = Date.now();
      try {
        await reportChanges(paths.map((path) => ({ path, kind: 'delete' })));
        await opts.waitForInteractivePriority?.();
        if (opts.signal?.aborted) { aborted = 'signal'; break; }
        removed += db.indexTransaction(projectId, () => removeFilesStructural(db, projectId, paths).removed);
      } catch (error) {
        errorCount++;
        console.error('[structural] Error committing structural removal wave:', error);
      }
      phaseTimings.writeMs += Date.now() - writeStarted;
      await yieldToEventLoop();
    }
  } else if (!aborted && errorCount === 0 && (indexed > 0 || scan.toRemove.length > 0)) {
    try {
      const published = generation.publish(scan.toRemove, opts.signal);
      indexed = published.indexed;
      removed = published.removed;
    } catch (error) {
      errorCount++;
      indexed = 0;
      console.error('[structural] Generation publication failed; prior index retained:', error);
    }
  } else indexed = 0;
  generation.discard();

  await opts.waitForInteractivePriority?.();
  const sweepStarted = Date.now();
  try {
    if (!aborted && errorCount === 0) {
      const sweep = await sweepContentCoverage(db, projectId, project.root_path, opts);
      if (sweep.added > 0) console.error(`[structural] Content coverage sweep: ${sweep.added} file(s) backfilled`);
    }
  } catch (err) {
    errorCount++;
    console.error('[structural] Content coverage sweep failed:', err);
  }
  phaseTimings.sweepMs += Date.now() - sweepStarted;
  sampleRss();
  if (opts.signal?.aborted) aborted = 'signal';

  const status = aborted || errorCount > scan.toIndex.length / 2
    ? 'failed'
    : errorCount > 0 || partial ? 'completed_with_errors' : 'completed';

  // Counters always reflect reality; the READY stamp only lands when the run
  // actually succeeded over a non-empty project — a failed/empty run must
  // never flip the status chip to "Symbols ready".
  const stats = db.getStructuralCounts(projectId);
  const checkedAt = new Date().toISOString();
  db.updateProject(projectId, {
    file_count: stats.file_count,
    symbol_count: stats.symbol_count,
    ...(!partial ? { structural_last_checked_at: checkedAt } : {}),
    ...(status === 'completed' && indexed + scan.unchanged.length > 0
      ? { structural_indexed_at: checkedAt }
      : {}),
    // last_indexed untouched — it keeps meaning "semantic index".
  });
  db.finishRun(runId, {
    status,
    totalFiles,
    indexedFiles: indexed,
    skippedFiles: scan.unchanged.length + unavailable,
    errorCount,
    phaseTimings,
    peakRssMb,
  }, projectId);

  return {
    ...partial, runId, totalFiles, indexed, removed, skipped: scan.unchanged.length + unavailable,
    errorCount, durationMs: Date.now() - startTime,
    phaseTimings, peakRssMb, aborted,
  };
}

/**
 * Backfill `file_contents_fts` for rows without an entry — covers the first
 * upgrade (vtab born empty under existing hashes, so the scanner skips every
 * file), post-corruption recovery (repair recreates empty) and individual
 * failed writes. A policy-versioned exclusion keeps rejected contents out of
 * later sweeps until their snapshot or the policy changes.
 */
export async function sweepContentCoverage(
  db: CodeIndexDB,
  projectId: number,
  rootPath: string,
  opts: Pick<StructuralIndexOptions, 'signal' | 'waitForInteractivePriority'> = {},
): Promise<{ added: number; skipped: number }> {
  let afterId = 0;
  let added = 0;
  let skipped = 0;
  while (!opts.signal?.aborted) {
    await opts.waitForInteractivePriority?.();
    const candidates = db.contentBackfillCandidates(projectId, afterId, 100);
    if (candidates.length === 0 || opts.signal?.aborted) break;
    afterId = candidates[candidates.length - 1].id;

    const ready: Array<{ file: ContentBackfillCandidate; content: string }> = [];
    for (const file of candidates) {
      if (file.size === 0 || file.size > MAX_CONTENT_BYTES) {
        ready.push({ file, content: '' });
        continue;
      }
      const content = readFileContentByHash(join(rootPath, file.path), file.size, file.content_hash);
      if (content !== undefined) ready.push({ file, content });
    }
    skipped += candidates.length - ready.length;
    if (ready.length > 0) {
      db.indexTransaction(projectId, () => {
        for (const { file, content } of ready) {
          if (db.backfillFileContent(projectId, file, content)) added++;
          else skipped++;
        }
      });
    }
    await yieldToEventLoop();
  }
  return { added, skipped };
}
