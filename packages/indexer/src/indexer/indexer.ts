import { createHash } from 'node:crypto';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { LLMProvider } from '@mcp/indexer/indexer/providers/base.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import { NullEmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import type { CostTracker } from '@mcp/services/services/costs.js';
import type { IndexerConfig } from '@mcp/shared/utils/config.js';
import type { IndexResult, ProgressCallback, RunStatus, ScannedFile, ScanResult } from '@mcp/shared/types.js';
import { codeNamespace } from '@mcp/shared/vector-namespace.js';
import { FileScanner } from '@mcp/indexer/indexer/scanner.js';
import type { TreeSitterResult } from '@mcp/indexer/indexer/tree-sitter/index.js';
import { buildTreeSitterDispatch } from '@mcp/indexer/indexer/tree-sitter-dispatch.js';
import { NullLshIndexingSink, type LshIndexingSink } from '@mcp/indexer/indexer/lsh-indexing-sink.js';
import type {
  IndexerFilesUpdatedEvent,
  IndexerFilesUpdatedListener,
} from '@mcp/indexer/indexer/indexer-events.js';

import { enrichReferencesWithLines, withConcurrency } from './indexer/enrich-references.js';
import { cosineSimilarity } from './indexer/cosine.js';
import { processFile } from './indexer/process-file.js';
import { createEmbedBatcher } from './indexer/embed-batcher.js';
import {
  retryEmbeddings as retryEmbeddingsFn,
  type EmbeddingProgress,
  type EmbeddingRetryResult,
} from './indexer/embed-retry.js';
import { flushStructEmbeddings, type StructEmbedItem } from './indexer/struct-embed-queue.js';
import { createRunTelemetry, resolveRssWarnMb, type RunTelemetry } from './indexer/run-telemetry.js';
import { sweepOrphanVectors } from './indexer/post-run-sweep.js';
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
    // Telemetry wrapper: `finish()` in finally stops the RSS sampler on
    // EVERY exit path (budget throw included) — an unstopped interval per
    // failed run would be its own small leak.
    const telemetry = createRunTelemetry();
    try {
      return await this.indexProjectInner(projectNameOrPath, telemetry, options);
    } finally {
      telemetry.finish();
    }
  }

  private async indexProjectInner(
    projectNameOrPath: string,
    telemetry: RunTelemetry,
    options?: IndexOptions,
  ): Promise<IndexResult> {
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
    // The new fingerprint is stamped only AFTER the re-embed sweep succeeds
    // (below): stamping up-front made a crash mid-run lose the "sweep still
    // needed" signal, leaving the project half-embedded under the new model.
    const embFingerprint = this.embeddingService.fingerprint?.();
    let fingerprintChanged = false;
    if (embFingerprint) {
      const prevFingerprint = this.db.getProjectEmbeddingFingerprint(project.id);
      if (prevFingerprint && prevFingerprint !== embFingerprint) {
        console.error(`[indexer] Embedding model changed (${prevFingerprint} → ${embFingerprint}) — clearing embedding hashes for a full re-embed`);
        this.db.clearEmbeddingHashes(project.id);
        fingerprintChanged = true;
      } else {
        // First index or unchanged model — stamping now is safe (no stale vectors).
        this.db.setProjectEmbeddingFingerprint(project.id, embFingerprint);
      }
    }

    const scanner = new FileScanner(project.root_path, this.config.ignorePatterns, this.config.maxFileSize);
    const scanResult = await telemetry.phase('scan', () => scanner.scan(this.db, project.id));
    if (scanResult.stats) {
      console.error(`[indexer] Scan: ${scanResult.stats.statOnly} stat-only, ${scanResult.stats.hashed} hashed, ${scanResult.stats.skippedTooLarge} too large`);
    }

    // Dumb→smart catch-up: structural runs (project open / watcher) advance
    // content_hash without a semantic pass, so the scanner reports those
    // files unchanged — without this they would never re-enter the LLM
    // pipeline. Force mode already reprocesses all of `unchanged`.
    const toIndex = options?.force
      ? [...scanResult.toIndex, ...this.rebuildForcedScans(project.id, scanResult.unchanged)]
      : [...scanResult.toIndex, ...this.rebuildForcedScans(project.id, this.staleSemanticPaths(project.id, scanResult))];

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

    // Resolved BEFORE the analyze loop — the embed batcher streams candidates
    // per analyzed file (content is released immediately after addFile; the
    // old flow retained every file's content until a single post-loop pass).
    const vectorsAvailable = this.vectorStore && !(this.embeddingService instanceof NullEmbeddingService)
      ? await this.vectorStore.isAvailable() : false;
    const batcher = vectorsAvailable && this.vectorStore
      ? createEmbedBatcher(this.embedDeps(), project, runId)
      : null;

    const treeSitter = this.buildTreeSitter();
    let treeSitterHits = 0;
    let llmSkipped = 0;
    let indexedCount = 0;
    let pipelineErrorCount = 0;
    const structQueue: StructEmbedItem[] = [];

    try {
      await telemetry.phase('analyze', () => withConcurrency(toIndex, async (file, idx) => {
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
          indexedCount++;
          if (result.pendingStructSig && vectorsAvailable) {
            structQueue.push({ fileId: result.fileId, structSig: result.pendingStructSig });
          }
          // Hard backpressure: addFile may await an embedding wave, which is
          // exactly what bounds this loop's memory. Content is unreferenced
          // once addFile returns.
          await batcher?.addFile({
            path: file.relativePath, fileId: result.fileId, analysis: result.analysis,
            content: result.content, tier: file.tier,
          });
          options?.onProgress?.({
            current: idx + 1, total: toIndex.length, currentFile: file.relativePath,
            elapsedMs: Date.now() - startTime, costUsd: totalCostUsd,
          });
        } catch (err) {
          errorCount++;
          console.error(`[indexer] Error processing ${file.relativePath}:`, err);
        }
      }, options?.concurrency ?? this.config.concurrency));

      await telemetry.phase('embed', async () => {
        // Deferred structure-signature embeddings (storage-only — see
        // struct-embed-queue.ts): one batched call per 50 files instead of one
        // embedQuery HTTP round-trip per file inside the analyze loop.
        if (structQueue.length > 0 && vectorsAvailable) {
          const structRes = await flushStructEmbeddings(
            { db: this.db, embeddingService: this.embeddingService, costTracker: this.costTracker },
            project, runId, structQueue,
          );
          if (structRes.embedded > 0) {
            console.error(`[indexer] Structure embeddings: ${structRes.embedded} stored in batch (${structRes.failed} failed)`);
          }
        }

        // Embeddings tail. Pipeline failures are tracked separately from
        // per-file errors: they must surface as completed_with_errors, but
        // they shouldn't trip the "failed" majority rule that is calibrated to
        // file counts (1 pipeline error on a 1-file run is not a failed run).
        if (batcher) {
          const embedRes = await batcher.finish();
          if (embedRes.failures.length > 0) {
            pipelineErrorCount++;
            const attempted = embedRes.embedded + embedRes.failures.reduce((n, f) => n + f.size, 0);
            console.error(
              `[indexer] Embedding pipeline error: ${embedRes.failures.length} batch(es) failed — ${embedRes.embedded}/${attempted} records embedded. First error: ${embedRes.failures[0].error}`,
            );
          }
        }
      });
    } finally {
      // In-process extractors are per-run (workers-off path or the broken-
      // pool fallback) — without the finally an exception leaked the wasm
      // parsers of the run. Pool dispatch dispose is a no-op by design.
      treeSitter.dispose();
    }

    // Model-change sweep: the pass above only embedded files CHANGED in this
    // run, but a fingerprint change invalidated every stored vector. The
    // retry path reads all DB files from disk and embeds exactly the
    // cleared-hash set (= the whole project). Stamp the new fingerprint only
    // on success — a crash or failure re-detects the mismatch next run
    // (re-clearing already-NULL hashes is idempotent).
    if (fingerprintChanged && vectorsAvailable && embFingerprint) {
      try {
        const sweep = await telemetry.phase('embed', () =>
          retryEmbeddingsFn(this.embedDeps(), project.root_path, { runId }));
        if (sweep.failedBatches > 0) {
          // Partial sweep — some hashes never committed. Keep the OLD
          // fingerprint so the mismatch re-triggers the sweep next run.
          pipelineErrorCount++;
          console.error(`[indexer] Model-change sweep incomplete (${sweep.failedBatches} batch(es) failed) — fingerprint NOT updated`);
        } else {
          console.error(`[indexer] Model-change sweep: re-embedded ${sweep.embedded} record(s) under ${embFingerprint}`);
          this.db.setProjectEmbeddingFingerprint(project.id, embFingerprint);
        }
      } catch (err) {
        pipelineErrorCount++;
        console.error('[indexer] Model-change re-embed sweep failed (will retry next run):', err);
      }
    }

    if (treeSitterHits > 0) {
      console.error(`[indexer] Tree-sitter: ${treeSitterHits}/${toIndex.length} files from AST; ${llmSkipped} LLM calls skipped (structure unchanged)`);
    }

    // Post-run orphan sweep — vector_ids rows whose file no longer exists.
    // Failure is counted but never blocks the run from finishing.
    try {
      const sweep = await telemetry.phase('sweep', () =>
        sweepOrphanVectors(this.db, this.vectorStore, this.lshSink, project));
      if (sweep.orphans > 0) {
        console.error(`[indexer] Orphan sweep: ${sweep.orphans} stale vector id(s) (${sweep.remoteDeleted} deleted remotely, ${sweep.tombstoned} tombstoned)`);
      }
    } catch (err) {
      pipelineErrorCount++;
      console.error('[indexer] Orphan sweep failed:', err);
    }

    // Update project counters + finish run.
    const stats = this.db.getStats(project.id);
    this.db.updateProject(project.id, { file_count: stats.file_count, symbol_count: stats.symbol_count, last_indexed: new Date().toISOString() });
    const totalErrors = errorCount + pipelineErrorCount;
    const status: RunStatus = errorCount > toIndex.length / 2
      ? 'failed'
      : totalErrors > 0
        ? 'completed_with_errors'
        : 'completed';
    const phases = telemetry.finish();
    console.error(`[indexer] run ${runId} phases: ${telemetry.summary()}`);
    const endRssMb = Math.round(process.memoryUsage().rss / 1e6);
    const warnMb = resolveRssWarnMb();
    if (endRssMb > warnMb) {
      console.warn(`[indexer] rss ${endRssMb}MB > ${warnMb}MB after run — possible leak (check dispose paths / ONNX sessions / worker pools)`);
    }
    this.db.finishRun(runId, {
      status,
      totalFiles: scanResult.toIndex.length + scanResult.unchanged.length,
      indexedFiles: indexedCount,
      skippedFiles: scanResult.unchanged.length,
      errorCount: totalErrors,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      embeddingTokens: totalEmbeddingTokens,
      estimatedCostUsd: totalCostUsd,
      phaseTimingsJson: JSON.stringify({
        scan_ms: phases.scan_ms, analyze_ms: phases.analyze_ms,
        embed_ms: phases.embed_ms, sweep_ms: phases.sweep_ms,
      }),
      peakRssMb: phases.peak_rss_mb,
    });

    await this.dispatchWebhook(status, project, { run_id: runId, indexed_files: indexedCount, error_count: totalErrors, cost_usd: totalCostUsd });

    await this.emitFilesUpdated({
      projectId: project.id, projectName: project.name, runId,
      indexedCount,
      removedCount: scanResult.toRemove?.length ?? 0,
      status,
      finishedAtMs: Date.now(),
    });

    await generateAutoSnapshots(this.db, project);

    return {
      runId,
      totalFiles: scanResult.toIndex.length + scanResult.unchanged.length,
      indexedFiles: indexedCount,
      skippedFiles: scanResult.unchanged.length,
      errorCount: totalErrors,
      durationMs: Date.now() - startTime,
      costUsd: totalCostUsd,
      phases,
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
   * blocking during indexing — dispatched to the worker pool by default
   * (`MCP_INDEX_WORKERS=0` opts out), with a per-process in-process fallback
   * when workers can't run in this environment. See tree-sitter-dispatch.ts.
   */
  private buildTreeSitter(): { extract(filePath: string, content: string): Promise<TreeSitterResult>; dispose(): void } {
    return buildTreeSitterDispatch();
  }

  /** Files advanced by structural runs whose semantic layer never caught up. */
  private staleSemanticPaths(projectId: number, scan: ScanResult): string[] {
    const inRun = new Set(scan.toIndex.map((f) => f.relativePath));
    const removeSet = new Set(scan.toRemove);
    const stale = this.db.listSemanticStalePaths(projectId)
      .filter((p) => !inRun.has(p) && !removeSet.has(p));
    if (stale.length > 0) {
      console.error(`[indexer] Semantic catch-up: ${stale.length} structurally-indexed file(s) joined this run`);
    }
    return stale;
  }

  /** Rebuild ScannedFile entries from DB rows for force mode — processFile reads content lazily. */
  private rebuildForcedScans(projectId: number, unchangedPaths: string[]): ScannedFile[] {
    const out: ScannedFile[] = [];
    for (const path of unchangedPaths) {
      const file = this.db.getFile(projectId, path);
      if (!file) continue;
      out.push({
        path: `${this.db.getProject(projectId)?.root_path ?? ''}/${path}`,
        relativePath: path,
        hash: file.content_hash,
        sizeBytes: file.size,
        lineCount: file.line_count,
      } as ScannedFile);
    }
    return out;
  }

  private async removeDeletedFiles(projectId: number, paths: readonly string[]): Promise<void> {
    // Namespace is needed for backends where ids are namespace-scoped (Pinecone);
    // harmless on the others. Resolve the project name once for the batch.
    const projectName = this.db.getProject(projectId)?.name;
    const namespace = projectName ? codeNamespace(projectName) : undefined;
    let tombstoned = 0;
    for (const path of paths) {
      const vectorIds = this.db.deleteVectorIdsByFile(projectId, path);
      if (vectorIds.length > 0 && this.vectorStore) {
        try {
          await this.vectorStore.deleteByIds(vectorIds, namespace);
          try { await this.lshSink.afterDelete?.(projectId, vectorIds); }
          catch { /* LSH is best-effort; orphaned buckets only cost recall */ }
        } catch (err) {
          // Remote delete failed — tombstone the ids so the hygiene queue
          // (HygienePanel button / CLI `hygiene vectorize-retry`) retries
          // later, instead of leaving orphans in the remote store forever.
          tombstoned += this.db.enqueuePendingVectorDeletes(vectorIds.map((vid) => ({
            vector_id: vid,
            project_name: projectName ?? null,
            error: err instanceof Error ? err.message : String(err),
          })));
        }
      }
      this.db.deleteFile(projectId, path);
    }
    if (tombstoned > 0) {
      console.warn(`[indexer] ${tombstoned} vector delete(s) failed remotely — queued for hygiene retry`);
    }
  }

  private async dispatchWebhook(
    status: string,
    project: { id: number; name: string; root_path: string },
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!this.webhookDispatcher) return;
    // completed_with_errors still maps to index.done — the payload carries
    // error_count, and consumers treat "done" as "the index was updated".
    const event = status === 'failed' ? 'index.failed' : 'index.done';
    try { await this.webhookDispatcher.dispatch(event, project, data); }
    catch { /* ignore webhook errors */ }
  }
}
