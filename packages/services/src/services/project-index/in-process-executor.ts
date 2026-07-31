import type { CodeIndexDB } from '@mcp/store/db.js';
import { runStructuralIndex } from '@mcp/indexer/indexer/structural.js';
import { indexFilesStructural, removeFilesStructural } from '@mcp/indexer/indexer/structural-incremental.js';
import { InteractivePriorityGate } from '@mcp/indexer/indexer/interactive-priority-gate.js';
import type { StructuralExecutor } from './types.js';

export interface InProcessExecutorConfig {
  ignorePatterns?: string[];
  maxFileSizeKB?: number;
  concurrency?: number;
}

/**
 * Fallback executor running the structural pipeline on the current thread.
 * Tree-sitter still offloads to the index-job worker pool when enabled
 * (tree-sitter-dispatch default), but the scanner + SQLite writes stay
 * here — acceptable for small projects and as the no-worker-build safety
 * net; the indexer worker client replaces this at app boot.
 */
export function createInProcessStructuralExecutor(
  db: CodeIndexDB,
  config: InProcessExecutorConfig = {},
): StructuralExecutor {
  const priorityGate = new InteractivePriorityGate();
  return {
    setInteractivePriority(projectId, busy) {
      priorityGate.setBusy(projectId, busy);
    },
    async runStructuralIndex(projectId, opts) {
      const r = await runStructuralIndex(db, projectId, {
        ignorePatterns: config.ignorePatterns,
        maxFileSizeKB: config.maxFileSizeKB,
        concurrency: config.concurrency,
        maxFiles: opts.maxFiles,
        allowEmptyWipe: opts.allowEmptyWipe,
        onProgress: opts.onProgress,
        onChanges: opts.onChanges,
        waitForInteractivePriority: () => priorityGate.wait(projectId),
      });
      return {
        totalFiles: r.totalFiles, indexed: r.indexed, removed: r.removed,
        skipped: r.skipped, errorCount: r.errorCount, durationMs: r.durationMs,
        phaseTimings: r.phaseTimings, peakRssMb: r.peakRssMb, aborted: r.aborted,
      };
    },
    async indexFiles(projectId, relPaths) {
      return indexFilesStructural(db, projectId, relPaths, {
        ignorePatterns: config.ignorePatterns,
        maxFileSizeKB: config.maxFileSizeKB,
        concurrency: config.concurrency,
      });
    },
    async removeFiles(projectId, relPaths) {
      return removeFilesStructural(db, projectId, relPaths);
    },
  };
}
