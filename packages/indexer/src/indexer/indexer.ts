import { createHash } from 'node:crypto';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { LLMProvider } from '@mcp/indexer/indexer/providers/base.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import { NullEmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import type { CostTracker } from '@mcp/services/services/costs.js';
import type { IndexerConfig } from '@mcp/shared/utils/config.js';
import type { IndexResult, ProgressCallback, ScannedFile } from '@mcp/shared/types.js';
import { FileScanner } from '@mcp/indexer/indexer/scanner.js';
import { TreeSitterExtractor, type TreeSitterResult } from '@mcp/indexer/indexer/tree-sitter/index.js';
import { getIndexJobPool, isIndexWorkersEnabled } from '@mcp/indexer/workers/indexJob/client.js';
import { NullLshIndexingSink, type LshIndexingSink } from '@mcp/indexer/indexer/lsh-indexing-sink.js';
import type {
  IndexerFilesUpdatedEvent,
  IndexerFilesUpdatedListener,
} from '@mcp/indexer/indexer/indexer-events.js';

import { enrichReferencesWithLines, withConcurrency } from './indexer/enrich-references.js';
import { cosineSimilarity } from './indexer/cosine.js';
import { processFile } from './indexer/process-file.js';
import {
  processEmbeddings,
  retryEmbeddings as retryEmbeddingsFn,
  type EmbeddingProgress,
  type EmbeddingRetryResult,
  type IndexedFileEntry,
} from './indexer/embed-executor.js';
import { generateAutoSnapshots } from './indexer/auto-snapshots.js';

// Re-exports preserved for external consumers.
export { enrichReferencesWithLines, withConcurrency, cosineSimilarity };
export type { EmbeddingProgress, EmbeddingRetryResult };

interface IndexOptions {
  force?: boolean;
  concurrency?: number;
  onProgress?: ProgressCallback;
}

interface WebhookDispatcherLike {
  dispatch(event: string, project: { id: number; name: string; root_path: string }, data: Record<string, unknown>): Promise<void>;
}

export class IndexAgent {
  /**
   * Optional LSH indexing sink. Default (`NullLshIndexingSink`) is a no-op;
   * the application wires `RealLshIndexingSink` to populate the LSH bucket
   * store alongside vector-store upserts.
   */
  private lshSink: LshIndexingSink;

  /**
   * Fire-and-forget listeners notified after each `indexProject()` run
   * completes (I3 — Sprint 1). Listener throws are caught — they cannot
   * affect the indexer's return value or other listeners.
   */
  private fileUpdatedListeners: IndexerFilesUpdatedListener[] = [];

  constructor(
    private db: CodeIndexDB,
    private provider: LLMProvider,
    private embeddingService: EmbeddingService,
    private vectorStore: VectorStore | null,
    private costTracker: CostTracker,
    private webhookDispatcher: WebhookDispatcherLike | null,
    private config: IndexerConfig,
    lshSink?: LshIndexingSink,
  ) {
    this.lshSink = lshSink ?? new NullLshIndexingSink();
  }

  /**
   * Register a listener for `files_updated` events. Returns an unsubscribe
   * function. Listeners fire AFTER the run completes (and after webhooks),
   * sequentially in registration order. Errors are caught and logged.
   */
  onFilesUpdated(listener: IndexerFilesUpdatedListener): () => void {
    this.fileUpdatedListeners.push(listener);
    return () => {
      const idx = this.fileUpdatedListeners.indexOf(listener);
      if (idx >= 0) this.fileUpdatedListeners.splice(idx, 1);
    };
  }

  private async emitFilesUpdated(event: IndexerFilesUpdatedEvent): Promise<void> {
    for (const listener of this.fileUpdatedListeners) {
      try { await listener(event); }
      catch (e) { console.warn(`[indexer] files_updated listener threw: ${(e as Error).message}`); }
    }
  }

  async indexProject(projectNameOrPath: string, options?: IndexOptions): Promise<IndexResult> {
    const startTime = Date.now();
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const totalEmbeddingTokens = 0;
    let totalCostUsd = 0;
    let errorCount = 0;

    const project = this.db.resolveProject(undefined, projectNameOrPath) ?? this.db.resolveProject(projectNameOrPath);

    // Detect an embedding-model change. If this project was last indexed with
    // a different model/backend, clear embedding hashes so everything re-embeds
    // under the new model — otherwise the incremental hash check skips re-embed
    // and the new vector store (e.g. sqlite-vec) stays empty / dim-mismatched.
    const embFingerprint = this.embeddingService.fingerprint?.();
    if (embFingerprint) {
      const prevFingerprint = this.db.getProjectEmbeddingFingerprint(project.id);
      if (prevFingerprint && prevFingerprint !== embFingerprint) {
        console.error(`[indexer] Embedding model changed (${prevFingerprint} → ${embFingerprint}) — clearing embedding hashes for a full re-embed`);
        this.db.clearEmbeddingHashes(project.id);
      }
      this.db.setProjectEmbeddingFingerprint(project.id, embFingerprint);
    }

    const scanner = new FileScanner(project.root_path, this.config.ignorePatterns, this.config.maxFileSize);
    const scanResult = await scanner.scan(this.db, project.id);

    const toIndex = options?.force
      ? [...scanResult.toIndex, ...this.rebuildForcedScans(project.id, scanResult.unchanged)]
      : scanResult.toIndex;

    await this.removeDeletedFiles(project.id, scanResult.toRemove);

    // Estimate cost + budget check.
    const estimate = this.costTracker.estimateCost({
      fileCount: toIndex.length,
      provider: this.provider.name,
      model: this.provider.model,
      embeddingsEnabled: !(this.embeddingService instanceof NullEmbeddingService),
    });
    console.error(`[indexer] Estimated cost: $${estimate.estimatedCostUsd.toFixed(4)} for ${toIndex.length} files`);

    if (this.config.budget && estimate.estimatedCostUsd > this.config.budget) {
      throw new Error(
        `Budget exceeded: estimated cost $${estimate.estimatedCostUsd.toFixed(4)} exceeds budget $${this.config.budget.toFixed(4)}. Use --budget to increase or remove the limit.`,
      );
    }

    const runId = this.db.startRun(project.id, this.provider.name, this.provider.model);

    const treeSitter = this.buildTreeSitter();
    let treeSitterHits = 0;
    let llmSkipped = 0;
    const indexedFiles: IndexedFileEntry[] = [];

    await withConcurrency(toIndex, async (file, idx) => {
      try {
        const result = await processFile(
          { db: this.db, provider: this.provider, embeddingService: this.embeddingService, costTracker: this.costTracker },
          project, runId, file, treeSitter,
        );
        if (result.treeSitterHit) treeSitterHits++;
        if (result.llmSkipped) llmSkipped++;
        totalInputTokens += result.inputTokens;
        totalOutputTokens += result.outputTokens;
        totalCostUsd += result.costUsd;
        indexedFiles.push({
          path: file.relativePath, fileId: result.fileId, analysis: result.analysis,
          content: result.content, tier: file.tier,
        });
        // Release scanner copy + indexedFiles content kept for the embedding step.
        (file as { content: string }).content = '';
        options?.onProgress?.({
          current: idx + 1, total: toIndex.length, currentFile: file.relativePath,
          elapsedMs: Date.now() - startTime, costUsd: totalCostUsd,
        });
      } catch (err) {
        errorCount++;
        console.error(`[indexer] Error processing ${file.relativePath}:`, err);
      }
    }, options?.concurrency ?? this.config.concurrency);

    // Embeddings (if available).
    const vectorsAvailable = this.vectorStore && !(this.embeddingService instanceof NullEmbeddingService)
      ? await this.vectorStore.isAvailable() : false;
    if (vectorsAvailable && this.vectorStore) {
      try {
        await processEmbeddings(this.embedDeps(), project, runId, indexedFiles);
      } catch (err) {
        console.error('[indexer] Embedding pipeline error:', err);
      }
    }

    // Release file content from indexedFiles — embeddings are done, these
    // strings can be hundreds of MB in aggregate for large codebases.
    for (const f of indexedFiles) (f as { content: string }).content = '';

    treeSitter.dispose();
    if (treeSitterHits > 0) {
      console.error(`[indexer] Tree-sitter: ${treeSitterHits}/${toIndex.length} files from AST; ${llmSkipped} LLM calls skipped (structure unchanged)`);
    }

    // Update project counters + finish run.
    const stats = this.db.getStats(project.id);
    this.db.updateProject(project.id, { file_count: stats.file_count, symbol_count: stats.symbol_count, last_indexed: new Date().toISOString() });
    const status = errorCount > toIndex.length / 2 ? 'failed' : 'completed';
    this.db.finishRun(runId, {
      status: status as 'completed' | 'failed',
      totalFiles: scanResult.toIndex.length + scanResult.unchanged.length,
      indexedFiles: indexedFiles.length,
      skippedFiles: scanResult.unchanged.length,
      errorCount,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      embeddingTokens: totalEmbeddingTokens,
      estimatedCostUsd: totalCostUsd,
    });

    await this.dispatchWebhook(status, project, { run_id: runId, indexed_files: indexedFiles.length, error_count: errorCount, cost_usd: totalCostUsd });

    await this.emitFilesUpdated({
      projectId: project.id, projectName: project.name, runId,
      indexedCount: indexedFiles.length,
      removedCount: scanResult.toRemove?.length ?? 0,
      status: status as 'completed' | 'failed',
      finishedAtMs: Date.now(),
    });

    await generateAutoSnapshots(this.db, project);

    return {
      runId,
      totalFiles: scanResult.toIndex.length + scanResult.unchanged.length,
      indexedFiles: indexedFiles.length,
      skippedFiles: scanResult.unchanged.length,
      errorCount,
      durationMs: Date.now() - startTime,
      costUsd: totalCostUsd,
    };
  }

  async retryEmbeddings(
    projectNameOrPath: string,
    options?: { onProgress?: (p: EmbeddingProgress) => void },
  ): Promise<EmbeddingRetryResult> {
    return retryEmbeddingsFn(this.embedDeps(), projectNameOrPath, options);
  }

  private embedDeps() {
    return {
      db: this.db,
      embeddingService: this.embeddingService,
      vectorStore: this.vectorStore,
      costTracker: this.costTracker,
      lshSink: this.lshSink,
      indexProfile: this.config.indexProfile,
    };
  }

  /**
   * Tree-sitter parsing is CPU-bound and was the largest source of main-thread
   * blocking during indexing. When `MCP_INDEX_WORKERS=1`, dispatch to a worker
   * pool sized to ~min(8, available cores). Result objects are plain JS and
   * structured-clone safe. Worker lifecycle is managed at the process level.
   */
  private buildTreeSitter(): { extract(filePath: string, content: string): Promise<TreeSitterResult>; dispose(): void } {
    if (isIndexWorkersEnabled()) {
      return {
        extract: (filePath, content) => getIndexJobPool().extract(filePath, content),
        dispose: () => { /* pool persists across runs */ },
      };
    }
    return new TreeSitterExtractor();
  }

  /** Re-read unchanged files for force mode by faking ScannedFile entries from DB rows. */
  private rebuildForcedScans(projectId: number, unchangedPaths: string[]): ScannedFile[] {
    const out: ScannedFile[] = [];
    for (const path of unchangedPaths) {
      const file = this.db.getFile(projectId, path);
      if (!file) continue;
      out.push({
        path: `${this.db.getProject(projectId)?.root_path ?? ''}/${path}`,
        relativePath: path,
        content: '',  // will need to re-read
        hash: file.content_hash,
        sizeBytes: file.size,
        lineCount: file.line_count,
      } as ScannedFile);
    }
    return out;
  }

  private async removeDeletedFiles(projectId: number, paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      const vectorIds = this.db.deleteVectorIdsByFile(projectId, path);
      if (vectorIds.length > 0 && this.vectorStore) {
        try { await this.vectorStore.deleteByIds(vectorIds); } catch { /* ignore */ }
      }
      this.db.deleteFile(projectId, path);
    }
  }

  private async dispatchWebhook(
    status: string,
    project: { id: number; name: string; root_path: string },
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!this.webhookDispatcher) return;
    const event = status === 'completed' ? 'index.done' : 'index.failed';
    try { await this.webhookDispatcher.dispatch(event, project, data); }
    catch { /* ignore webhook errors */ }
  }
}
