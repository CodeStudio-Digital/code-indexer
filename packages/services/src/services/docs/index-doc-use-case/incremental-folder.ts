import { buildItemChunks, runSelectiveEnrichment, mapConcurrent } from './incremental-folder-processing.js';
import type { ProcessedEntry } from './incremental-folder-processing.js';
import type { DocChunkInput, DocCollection, DocSource } from '@mcp/store/doc-store.js';
import { docNamespace } from '@mcp/shared/vector-namespace.js';

import { gatePages, heuristicAccepts } from '../relevance-gate.js';
import { scanFolderFiles } from '../folder-reader.js';
import type { DocIngestProgress, DocIngestResult, RawPage } from '../types.js';
import { DocError } from '../errors.js';

import { retryEmbeddings } from './embed-upsert.js';
import { deleteLocalVectors } from './delete.js';
import { hashContent } from './utils.js';
import type { IndexDocStreamCallbacks, IndexDocUseCaseDeps } from './types.js';
import { createDocExtractionPool, resolveDocWorkerCount, type DocExtractionPool } from './extraction-pool.js';

const ITEM_BATCH_SIZE = 128;
// Keep raw input for one conversion wave below half the 512 MB additional
// memory budget; cheerio/markdown expansion gets the remaining headroom.
const READ_BATCH_RAW_BUDGET_BYTES = 256 * 1024 * 1024;

export async function runIncrementalFolderIngest(
  deps: IndexDocUseCaseDeps,
  collection: DocCollection,
  source: DocSource,
  callbacks?: IndexDocStreamCallbacks,
  resumeRunId?: number,
): Promise<DocIngestResult> {
  const { docStore } = deps;
  const startedAt = Date.now();
  const pausedRun = resumeRunId != null ? docStore.getIngestRun(resumeRunId) : null;
  if (resumeRunId != null && (!pausedRun || pausedRun.source_id !== source.id || !['paused', 'paused_limit'].includes(pausedRun.state))) {
    throw new DocError('bad_request', `Run ${resumeRunId} is not resumable for source ${source.id}`);
  }
  if (!docStore.tryAcquireSource(source.id)) {
    throw new DocError('already_running', `Source ${source.id} is already being indexed`);
  }
  const initialWorkers = resolveDocWorkerCount(source.folder_performance_profile, source.folder_worker_count);
  const run = pausedRun
    ? docStore.resumeIngestRun(pausedRun.id)!
    : docStore.createIngestRun(source.id, {
        rootPath: source.folder_root_path,
        includeGlob: source.folder_include_glob,
        excludeGlob: source.folder_exclude_glob,
        maxFiles: source.folder_max_files,
        enrichmentMode: source.enrichment_mode,
      }, source.folder_performance_profile, initialWorkers);
  let extractionPool: DocExtractionPool | null = null;
  let extractionPoolSize = 0;
  const emit = async (frame: DocIngestProgress): Promise<void> => {
    const decorated = { ...frame, run_id: run.id, state: frame.state ?? 'running' as const };
    deps.progressTracker?.put(source.id, decorated);
    await callbacks?.onProgress?.(decorated);
  };

  docStore.updateCollectionStatus(collection.id, 'indexing');
  await callbacks?.onStart?.({ source_id: source.id, collection_id: collection.id, started_at: new Date().toISOString() });
  try {
    const rootPath = source.folder_root_path;
    if (!rootPath) throw new Error('Folder source has no folder_root_path');
    const scan = await scanFolderFiles({
      rootPath,
      includeGlob: source.folder_include_glob,
      excludeGlob: source.folder_exclude_glob,
      maxFiles: source.folder_max_files,
    });
    const limited = scan.totalMatches > scan.entries.length;
    docStore.updateIngestRun(run.id, { phase: 'reading', total_items: scan.totalMatches });
    await callbacks?.onScan?.({ totalMatches: scan.totalMatches, willProcess: scan.entries.length, cap: scan.cap });

    let processed = 0;
    let changed = 0;
    let unchanged = 0;
    let skipped = 0;
    let errored = 0;
    let acceptedPages = 0;
    let rejectedPages = 0;
    let legacyRemoved = false;
    let extractionMs = 0;

    for (let offset = 0; offset < scan.entries.length;) {
      if (docStore.isIngestCancelRequested(run.id)) {
        return finishInterrupted('cancelled');
      }
      if (docStore.isIngestPauseRequested(run.id)) {
        return finishInterrupted('paused');
      }
      const latestRun = docStore.getIngestRun(run.id);
      const desiredWorkers = Math.max(1, latestRun?.worker_count ?? initialWorkers);
      if (!extractionPool || extractionPoolSize !== desiredWorkers) {
        await extractionPool?.close();
        extractionPool = createDocExtractionPool(desiredWorkers);
        extractionPoolSize = desiredWorkers;
      }
      let end = offset;
      let rawBytes = 0;
      const batchItemLimit = Math.min(ITEM_BATCH_SIZE, Math.max(desiredWorkers * 2, desiredWorkers));
      while (end < scan.entries.length && end - offset < batchItemLimit) {
        const next = scan.entries[end]!;
        if (end > offset && rawBytes + next.size > READ_BATCH_RAW_BUDGET_BYTES) break;
        rawBytes += next.size;
        end++;
      }
      const entries = scan.entries.slice(offset, end);
      offset = end;
      const batch = await mapConcurrent(entries, desiredWorkers, async (entry) => {
        const prior = docStore.getSourceItem(source.id, entry.relPath);
        if (prior && prior.status === 'done' && prior.size_bytes === entry.size && prior.mtime_ms === Math.trunc(entry.mtimeMs)) {
          return { entry, kind: 'unchanged' } satisfies ProcessedEntry;
        }
        try {
          const extracted = await extractionPool!.extract(entry, rootPath, source.id);
          extractionMs += extracted.durationMs;
          const result = extracted.result;
          if (typeof result === 'string') return { entry, kind: 'skipped', error: result } satisfies ProcessedEntry;
          const contentHash = hashContent(result.map((p) => p.markdown).join('\n\0\n'));
          if (prior?.content_hash === contentHash && prior.status === 'done') {
            return { entry, kind: 'unchanged', contentHash } satisfies ProcessedEntry;
          }
          return {
            entry,
            kind: 'changed',
            pages: result,
            contentHash,
            sectionsByPage: Object.fromEntries(extracted.sections.map((page) => [page.candidateId, page.chunks])),
          } satisfies ProcessedEntry;
        } catch (error) {
          return { entry, kind: 'error', error: error instanceof Error ? error.message : String(error) } satisfies ProcessedEntry;
        }
      });

      const changedPages = batch.flatMap((item) => item.kind === 'changed' ? item.pages ?? [] : []);
      const verdicts = source.folder_bypass_relevance_gate
        ? changedPages.map(heuristicAccepts)
        : await gatePages(changedPages, {
            resolver: deps.pipelineProviderResolver,
            resolveContext: deps.resolveContext,
          });
      let verdictCursor = 0;
      const chunkWrites: Array<{ itemKey: string; inputs: DocChunkInput[] }> = [];
      const manifestWrites: Array<Parameters<typeof docStore.upsertSourceItem>[0]> = [];

      for (const item of batch) {
        processed++;
        if (item.kind === 'unchanged') {
          unchanged++;
          const prior = docStore.getSourceItem(source.id, item.entry.relPath);
          manifestWrites.push({
            source_id: source.id,
            item_key: item.entry.relPath,
            source_uri: prior?.source_uri ?? null,
            size_bytes: item.entry.size,
            mtime_ms: Math.trunc(item.entry.mtimeMs),
            content_hash: item.contentHash ?? prior?.content_hash ?? null,
            status: 'done',
            last_seen_run_id: run.id,
            chunk_count: prior?.chunk_count ?? 0,
          });
          continue;
        }
        if (item.kind === 'skipped' || item.kind === 'error') {
          if (item.kind === 'skipped') skipped++; else errored++;
          manifestWrites.push({
            source_id: source.id,
            item_key: item.entry.relPath,
            size_bytes: item.entry.size,
            mtime_ms: Math.trunc(item.entry.mtimeMs),
            status: item.kind,
            last_seen_run_id: run.id,
            error_message: item.error ?? null,
          });
          continue;
        }

        changed++;
        const accepted: RawPage[] = [];
        for (const page of item.pages ?? []) {
          const verdict = verdicts[verdictCursor++] ?? { accept: false, reason: 'missing verdict' };
          page.gate_reason = verdict.reason;
          page.is_documentation = verdict.accept;
          if (verdict.accept) {
            accepted.push(page);
            acceptedPages++;
          } else rejectedPages++;
        }
        const inputs = buildItemChunks(
          collection, source, item.entry, accepted, run.id,
          deps.embeddingService?.fingerprint?.() ?? 'none', item.sectionsByPage,
        );
        chunkWrites.push({ itemKey: item.entry.relPath, inputs });
        manifestWrites.push({
          source_id: source.id,
          item_key: item.entry.relPath,
          source_uri: accepted[0]?.canonical_uri ?? accepted[0]?.uri ?? null,
          size_bytes: item.entry.size,
          mtime_ms: Math.trunc(item.entry.mtimeMs),
          content_hash: item.contentHash ?? null,
          status: 'done',
          last_seen_run_id: run.id,
          chunk_count: inputs.length,
        });
      }

      // One ordered transaction per extraction wave instead of one commit per
      // file. FTS triggers still publish the whole wave atomically, while the
      // single writer avoids SQLite writer contention from worker threads.
      const chunkResults = docStore.upsertChunksForItems(source.id, run.id, chunkWrites);
      const obsoleteVectors = chunkResults.flatMap((result) => result.removedVectors);
      if (!legacyRemoved && chunkResults.some((result) => result.ids.length > 0)) {
        obsoleteVectors.push(...docStore.removeLegacyChunks(source.id));
        legacyRemoved = true;
      }
      await deleteLocalVectors(docStore, deps.vectorStore, obsoleteVectors, docNamespace(collection.id));
      docStore.upsertSourceItems(manifestWrites);

      const chunksPersisted = docStore.countChunksBySource(source.id);
      const elapsed = Math.max(1, Date.now() - startedAt);
      const rate = processed / (elapsed / 1000);
      const remaining = Math.max(0, scan.entries.length - processed);
      docStore.updateSourceStats(source.id, {
        chunk_count: chunksPersisted,
        page_count: acceptedPages + rejectedPages,
        pages_accepted: acceptedPages,
        pages_rejected: rejectedPages,
      });
      docStore.refreshCollectionCounts(collection.id);
      docStore.updateIngestRun(run.id, {
        phase: 'chunking',
        processed_items: processed,
        changed_items: changed,
        unchanged_items: unchanged,
        skipped_items: skipped,
        errored_items: errored,
        chunks_persisted: chunksPersisted,
      });
      await emit({
        phase: 'reading',
        current: processed,
        total: scan.entries.length,
        label: entries.at(-1)?.relPath,
        files_changed: changed,
        files_unchanged: unchanged,
        files_skipped: skipped,
        chunks_indexed: chunksPersisted,
        chunks_persisted: chunksPersisted,
        searchable: chunksPersisted > 0,
        rate_per_sec: rate,
        eta_ms: rate > 0 ? Math.round((remaining / rate) * 1000) : null,
        workers_active: extractionPool.size(),
        workers_configured: desiredWorkers,
        extraction_ms: Math.round(extractionMs),
      });
    }

    if (!limited) {
      const stale = docStore.listSourceItemsNotSeen(source.id, run.id);
      const obsoleteVectors = docStore.removeChunksForItems(source.id, stale.map((i) => i.item_key));
      await deleteLocalVectors(docStore, deps.vectorStore, obsoleteVectors, docNamespace(collection.id));
      docStore.deleteSourceItems(stale.map((i) => i.id));
    }

    const chunksPersisted = docStore.countChunksBySource(source.id);
    let embeddingsCompleted = 0;
    if (docStore.isIngestCancelRequested(run.id)) return finishInterrupted('cancelled');
    if (docStore.isIngestPauseRequested(run.id)) return finishInterrupted('paused');
    if (deps.embeddingService && deps.vectorStore && deps.embeddingService.fingerprint?.() !== 'null') {
      docStore.updateIngestRun(run.id, { phase: 'embedding' });
      const embedded = await retryEmbeddings(deps, { sourceId: source.id }, {
        shouldStop: () => docStore.isIngestCancelRequested(run.id)
          ? 'cancelled'
          : docStore.isIngestPauseRequested(run.id)
            ? 'paused'
            : null,
        onProgress: async (p) => {
          embeddingsCompleted = p.current;
          docStore.updateIngestRun(run.id, { embeddings_completed: p.current });
          await emit({
            phase: 'embedding', current: p.current, total: p.total,
            chunks_persisted: chunksPersisted,
            embeddings_completed: p.current,
            embeddings_pending: Math.max(0, p.total - p.current),
            searchable: chunksPersisted > 0,
          });
        },
      });
      embeddingsCompleted = embedded.embedded;
      if (embedded.stopped) return finishInterrupted(embedded.stopped);
      docStore.updateSourceStats(source.id, { embedding_fingerprint: deps.embeddingService.fingerprint?.() ?? null });
    }

    const state = limited ? 'paused_limit' as const : 'completed' as const;
    const elapsed = Date.now() - startedAt;
    docStore.updateIngestRun(run.id, {
      state,
      phase: limited ? 'paused_limit' : 'done',
      chunks_persisted: chunksPersisted,
      embeddings_completed: embeddingsCompleted,
      completed: true,
    });
    docStore.updateSourceStats(source.id, {
      chunk_count: chunksPersisted,
      last_indexed_at: new Date().toISOString(),
      last_ingest_run_id: run.id,
    });
    docStore.updateSourceStatus(source.id, 'done', limited ? `Limite de ${scan.cap} arquivos atingido; retome após aumentar o limite.` : null);
    docStore.refreshCollectionCounts(collection.id);
    docStore.updateCollectionStatus(collection.id, 'idle', limited ? 'Indexação parcial pesquisável; limite atingido.' : null);
    const result: DocIngestResult = {
      source_id: source.id,
      chunks_indexed: chunksPersisted,
      pages_fetched: acceptedPages + rejectedPages,
      pages_accepted: acceptedPages,
      pages_rejected: rejectedPages,
      pages_via_browser: 0,
      cost_usd: 0,
      elapsed_ms: elapsed,
      run_id: run.id,
      state,
      searchable: chunksPersisted > 0,
    };
    await emit({
      phase: limited ? 'paused_limit' : 'done', current: processed, total: scan.entries.length,
      state, chunks_indexed: chunksPersisted, chunks_persisted: chunksPersisted,
      embeddings_completed: embeddingsCompleted,
      embeddings_pending: docStore.getSourceHealth(source.id)?.missing_count ?? chunksPersisted,
      searchable: chunksPersisted > 0, elapsed_ms: elapsed,
    });
    await callbacks?.onDone?.(result);

    // Enrichment is deliberately post-publication. API-reference chunks have
    // deterministic metadata and never enter this queue.
    void runSelectiveEnrichment(deps, source.id, run.id, emit).catch((error) => {
      console.warn(`[doc-indexer] async enrichment source=${source.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return result;

    async function finishInterrupted(state: 'paused' | 'cancelled'): Promise<DocIngestResult> {
      const chunks = docStore.countChunksBySource(source.id);
      const elapsed = Date.now() - startedAt;
      docStore.updateIngestRun(run.id, {
        state, phase: state, chunks_persisted: chunks,
        completed: state === 'cancelled',
      });
      const message = state === 'paused'
        ? 'Indexação pausada; o mesmo run pode ser retomado.'
        : 'Indexação cancelada; uma nova indexação pode reaproveitar o manifesto.';
      docStore.updateSourceStatus(source.id, chunks > 0 ? 'done' : 'queued', message);
      docStore.updateCollectionStatus(collection.id, 'idle');
      const result: DocIngestResult = {
        source_id: source.id, chunks_indexed: chunks, pages_fetched: acceptedPages + rejectedPages,
        pages_accepted: acceptedPages, pages_rejected: rejectedPages, pages_via_browser: 0,
        cost_usd: 0, elapsed_ms: elapsed, run_id: run.id, state, searchable: chunks > 0,
      };
      await emit({ phase: state, current: processed, total: scan.entries.length, state, searchable: chunks > 0 });
      await callbacks?.onDone?.(result);
      return result;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    docStore.updateIngestRun(run.id, { state: 'failed', phase: 'error', error_message: message, completed: true });
    docStore.updateSourceStatus(source.id, 'error', message.slice(0, 1000));
    docStore.updateCollectionStatus(collection.id, 'error', message.slice(0, 1000));
    await callbacks?.onError?.(message);
    throw error instanceof DocError ? error : new DocError('internal', message);
  } finally {
    await extractionPool?.close();
  }
}
