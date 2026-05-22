/**
 * IndexDocumentationUseCase — orchestrates the end-to-end ingestion of a
 * single doc source (PDF or URL crawl) into the global doc corpus.
 *
 * Pipeline overview:
 *
 *   acquire source (lock) → fetch raw pages → relevance gate → chunk →
 *     enrich → persist → embed + vector upsert → mark done
 *
 * Each phase emits a progress frame via the optional `IndexDocStreamCallbacks`
 * so the dashboard's SSE endpoint can render a live feed.
 *
 * Concurrency is enforced at the source level by `DocStore.tryAcquireSource`,
 * which atomically flips `status` to `fetching` only when it wasn't already
 * `fetching|indexing`. A second concurrent call gets `DocError('already_running')`.
 */
import { createHash } from 'node:crypto';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import type { VectorRecord } from '@mcp/shared/types.js';
import type {
  DocChunkInput,
  DocCollection,
  DocCrawlConfig,
  DocSource,
  DocStore,
} from '@mcp/store/doc-store.js';
import type { PipelineProviderResolver } from '../../pipelines/index.js';
import { PDF_MAX_BYTES, parsePdf } from './pdf-parser.js';
import { crawlUrl } from './crawler.js';
import { gatePages } from './relevance-gate.js';
import { chunkMarkdown, estimateTokens } from './section-chunker.js';
import { enrichChunks } from './enricher.js';
import { DocError } from './errors.js';
import { vectorIdForChunk } from './search.js';
import type {
  DocIngestEstimate,
  DocIngestProgress,
  DocIngestResult,
  RawPage,
} from './types.js';

/** Approximate token-cost knob for the dry-run preview. */
const DEFAULT_DRY_RUN_TOKEN_COST_USD_PER_1K = 0.00002;
/** Cap on chunks per source — protects FTS5 explosion on giant PDFs. */
const HARD_MAX_CHUNKS_PER_SOURCE = 50_000;
/** Embedding batch size — most providers tolerate 100, our embedder rebatches. */
const EMBED_BATCH_SIZE = 64;
/**
 * Parallel workers in `embedAndUpsert`. Each worker pulls the next
 * `EMBED_BATCH_SIZE` chunks off a shared cursor and runs embed→upsert
 * →SQLite back-to-back. 4 workers × ~1-2 req/s per worker = ~8 req/s
 * peak, comfortably under Cloudflare's free-tier 50/s ceiling. Bump if
 * you switch to a paid plan and want lower wall-clock; lower if you
 * see rate-limit retries in the logs.
 */
const EMBED_CONCURRENCY = 4;

/**
 * Cap on how many times the sweeper retries a single tombstone before
 * giving up. Keeps the queue from growing unbounded when an ID never
 * existed remotely (legacy provider, schema drift) or when the remote
 * keeps rejecting forever. 5 attempts × boot-sweep frequency (each
 * restart + manual `POST /vectors/sweep`) is plenty to cover transient
 * outages.
 */
const MAX_TOMBSTONE_RETRIES = 5;

export interface IndexDocStreamCallbacks {
  onStart?: (p: { source_id: number; collection_id: number; started_at: string }) => void | Promise<void>;
  onProgress?: (p: DocIngestProgress) => void | Promise<void>;
  onDone?: (r: DocIngestResult) => void | Promise<void>;
  onError?: (message: string) => void | Promise<void>;
}

export interface IndexDocUseCaseDeps {
  docStore: DocStore;
  embeddingService: EmbeddingService | null;
  vectorStore: VectorStore | null;
  pipelineProviderResolver: PipelineProviderResolver;
  /**
   * Optional render backend for URL ingestion. When provided, the crawler
   * routes every page fetch through it (typically an `EscalatingFetcher`
   * with plain + browser backends). When omitted, the crawler instantiates
   * a `PlainFetchBackend` wrapping a fresh `UrlFetcher` (backward-compat for
   * tests; loses browser escalation).
   */
  renderBackend?: import('./render-backend.js').RenderBackend;
  /**
   * Optional in-memory progress tracker. Wraps `onProgress` so the latest
   * frame per source is cached and queryable via the HTTP route
   * `GET /api/docs/sources/:id/progress`. When omitted the use-case
   * still works — only the live-poll UI degrades to "no snapshot yet".
   */
  progressTracker?: import('./progress-tracker.js').DocIngestProgressTracker;
  /** Optional context for hierarchical provider resolution. */
  resolveContext?: { sessionId?: number; companySessionId?: number; templateId?: number };
}

export interface IndexPdfInput {
  collectionId: number;
  fileName: string;
  bytes: Uint8Array;
  contentType?: string;
  title?: string;
}

export interface IndexUrlInput {
  collectionId: number;
  url: string;
  crawl?: DocCrawlConfig;
  title?: string;
}

export class IndexDocumentationUseCase {
  constructor(private deps: IndexDocUseCaseDeps) {}

  // ─── PDF entry points ────────────────────────────────────────────

  async indexPdf(input: IndexPdfInput, callbacks?: IndexDocStreamCallbacks): Promise<DocIngestResult> {
    const collection = this.requireCollection(input.collectionId);
    if (input.bytes.byteLength > PDF_MAX_BYTES) {
      throw new DocError('too_large', `PDF exceeds ${PDF_MAX_BYTES} bytes`);
    }
    const uri = `pdf://${sanitizeFileName(input.fileName)}`;
    const source = this.ensureSource({
      collection_id: collection.id,
      type: 'pdf',
      uri,
      title: input.title ?? stripExtension(input.fileName),
      pdf_size_bytes: input.bytes.byteLength,
    });
    return this.runIngest(collection, source, async () => {
      const pages = await parsePdf(input.bytes, {
        sourceId: source.id,
        sourceUri: uri,
        titleHint: stripExtension(input.fileName),
      });
      return pages;
    }, callbacks);
  }

  async dryRunPdf(input: IndexPdfInput): Promise<DocIngestEstimate> {
    if (input.bytes.byteLength > PDF_MAX_BYTES) {
      throw new DocError('too_large', `PDF exceeds ${PDF_MAX_BYTES} bytes`);
    }
    const pages = await parsePdf(input.bytes, {
      sourceId: 0,
      sourceUri: `pdf://${sanitizeFileName(input.fileName)}`,
      titleHint: stripExtension(input.fileName),
    });
    return this.estimateFromPages(pages);
  }

  // ─── URL entry points ────────────────────────────────────────────

  async indexUrl(input: IndexUrlInput, callbacks?: IndexDocStreamCallbacks): Promise<DocIngestResult> {
    const collection = this.requireCollection(input.collectionId);
    const normalizedUrl = normalizeSeedUrl(input.url);
    if (!normalizedUrl) {
      throw new DocError('bad_request', `Invalid URL: "${input.url}"`);
    }
    const source = this.ensureSource({
      collection_id: collection.id,
      type: 'url',
      uri: normalizedUrl,
      title: input.title ?? null,
      crawl: input.crawl,
    });
    return this.runIngest(collection, source, async () => {
      const pages = await crawlUrl({
        seedUrl: normalizedUrl,
        sourceId: source.id,
        crawl: input.crawl ?? defaultCrawlConfig(source),
        renderer: this.deps.renderBackend,
        // Forward the resolver only when the crawl wants LLM-assisted
        // link extraction. The crawler still falls back gracefully when
        // the binding is missing, but skipping the param keeps the
        // call shape obvious in logs.
        linkExtractorResolver: this.deps.pipelineProviderResolver,
        resolveContext: this.deps.resolveContext,
        onPageFetched: ({ totalFetched, ok, reason }) => {
          const frame: DocIngestProgress = {
            phase: 'fetching',
            current: totalFetched,
            total: input.crawl?.max_pages ?? 1,
            label: reason ?? '',
            pages_fetched: totalFetched,
          };
          // Also push into the tracker so the `/progress` poll sees
          // per-page fetch updates (not just the post-crawl summary).
          this.deps.progressTracker?.put(source.id, frame);
          void callbacks?.onProgress?.(frame);
        },
      });
      return pages;
    }, callbacks);
  }

  async dryRunUrl(input: IndexUrlInput): Promise<DocIngestEstimate> {
    const crawl = input.crawl ?? { enabled: false, max_pages: 1, max_depth: 0, same_origin: true };
    const normalized = normalizeSeedUrl(input.url);
    if (!normalized) {
      throw new DocError('bad_request', `Invalid URL: "${input.url}"`);
    }
    const pages = await crawlUrl({
      seedUrl: normalized,
      sourceId: 0,
      crawl,
    });
    // Apply the heuristic gate locally — the LLM gate is what changes
    // between dry-run and full run, so use heuristics as the lower bound.
    const heuristic = pages.filter((p) => {
      const acceptedLength = (p.markdown ?? '').length >= 500;
      return acceptedLength;
    });
    return this.estimateFromPages(heuristic, pages.length);
  }

  // ─── Delete + remote vector cleanup ──────────────────────────────

  /**
   * Delete a source row, cascade-wipe its chunks and chunk_vectors in
   * SQLite, and try to remove the corresponding embeddings from the
   * remote vector store. If the remote call fails (network, store down,
   * 5xx), the leftover ids are written to `doc_vector_tombstones` so a
   * future sweep can retry — the user's intent (source gone) is always
   * fulfilled even when the remote store is unreachable.
   *
   * Returns counts that the HTTP response surfaces to the dashboard:
   *   - `remote_deleted`    — vectors confirmed-deleted upstream
   *   - `queued_for_retry`  — vectors enqueued for sweep (remote failed)
   */
  async deleteSource(sourceId: number): Promise<{ remote_deleted: number; queued_for_retry: number }> {
    return this.deleteAndCleanup(() => this.deps.docStore.listVectorIdsForSource(sourceId), () => {
      this.deps.docStore.deleteSource(sourceId);
    });
  }

  /** Same as `deleteSource` but for an entire collection (two-hop FK cascade). */
  async deleteCollection(collectionId: number): Promise<{ remote_deleted: number; queued_for_retry: number }> {
    return this.deleteAndCleanup(
      () => this.deps.docStore.listVectorIdsForCollection(collectionId),
      () => { this.deps.docStore.deleteCollection(collectionId); },
    );
  }

  /**
   * Shared body of `deleteSource` / `deleteCollection`. Collects the
   * (vector_id, provider) refs BEFORE the SQLite delete (cascade wipes
   * the mapping table), then runs the delete, then issues the remote
   * delete call OUTSIDE any transaction (network I/O must never block
   * the writer thread). Single-process server + `tryAcquireSource`
   * ingestion gate means there's no concurrent inserter racing between
   * the two SQL ops — sequential calls are safe here.
   */
  private async deleteAndCleanup(
    collectVectorRefs: () => Array<{ vector_id: string; provider: string }>,
    runSqliteDelete: () => void,
  ): Promise<{ remote_deleted: number; queued_for_retry: number }> {
    const { docStore, vectorStore } = this.deps;
    const refs = collectVectorRefs();
    runSqliteDelete();

    if (refs.length === 0 || !vectorStore) {
      return { remote_deleted: 0, queued_for_retry: 0 };
    }

    const ids = refs.map((r) => r.vector_id);
    try {
      const removed = await vectorStore.deleteByIds(ids);
      if (removed >= ids.length) {
        // Full cleanup. Tombstone queue stays empty for these IDs.
        console.log(`[doc-indexer] vector cleanup: removed ${removed}/${ids.length} vector(s) remotely`);
        return { remote_deleted: removed, queued_for_retry: 0 };
      }
      // Partial — either some IDs were already gone (Cloudflare returns
      // count of actually-removed) OR the store silently rejected some.
      // We can't distinguish from the API surface, so the conservative
      // path is to queue the full set for retry. The UNIQUE constraint
      // on tombstones dedupes; the sweep's retry cap (`MAX_TOMBSTONE_RETRIES`)
      // bounds the loop for IDs that were already gone — they'll be
      // dropped from the queue after `MAX_TOMBSTONE_RETRIES` attempts.
      console.warn(
        `[doc-indexer] vector cleanup partial: removed ${removed}/${ids.length} — queuing remainder for retry`,
      );
      const queued = docStore.recordTombstones(
        refs.map((r) => ({ ...r, error: `partial_delete:${removed}/${ids.length}` })),
      );
      return { remote_deleted: removed, queued_for_retry: queued };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[doc-indexer] vector cleanup deferred (${refs.length} ids): ${msg}`);
      const queued = docStore.recordTombstones(refs.map((r) => ({ ...r, error: msg.slice(0, 500) })));
      return { remote_deleted: 0, queued_for_retry: queued };
    }
  }

  /**
   * Drain pending tombstones — try `vectorStore.deleteByIds` for the
   * batch, then remove the rows that succeeded and bump retry_count on
   * those that didn't. Called best-effort at boot from `server.ts` and
   * also exposed via `POST /api/docs/vectors/sweep` for manual drains.
   *
   * Groups by provider so heterogeneous deployments (legacy rows for a
   * provider that's no longer active) don't poison the whole batch.
   */
  async sweepTombstones(limit: number = 500): Promise<{ drained: number; still_pending: number; dropped_exhausted: number }> {
    const { docStore, vectorStore } = this.deps;

    // First, drop tombstones that have hit the retry ceiling. They're
    // almost always IDs the remote already deleted (or never had) — we
    // can't tell from the API, so we give up after `MAX_TOMBSTONE_RETRIES`
    // attempts. Keeps the queue from growing forever.
    const { dropped: dropped_exhausted } = docStore.dropExhaustedTombstones(MAX_TOMBSTONE_RETRIES);
    if (dropped_exhausted > 0) {
      console.warn(
        `[doc-indexer] dropped ${dropped_exhausted} tombstone(s) after ${MAX_TOMBSTONE_RETRIES} unsuccessful retries`,
      );
    }

    const pending = docStore.listPendingTombstones(limit);
    if (pending.length === 0 || !vectorStore) {
      return { drained: 0, still_pending: docStore.countPendingTombstones(), dropped_exhausted };
    }

    // Group by provider so each batch hits the right backend. Right now
    // the deps wire a single vectorStore, but the grouping leaves room
    // to route by provider in the future.
    const byProvider = new Map<string, typeof pending>();
    for (const row of pending) {
      const list = byProvider.get(row.provider) ?? [];
      list.push(row);
      byProvider.set(row.provider, list);
    }

    let drained = 0;
    for (const [, batch] of byProvider) {
      const ids = batch.map((r) => r.vector_id);
      try {
        const removed = await vectorStore.deleteByIds(ids);
        if (removed >= ids.length) {
          // Full success — drop every tombstone in the batch.
          for (const row of batch) {
            docStore.deleteTombstone(row.id);
            drained++;
          }
        } else {
          // Partial — we can't tell WHICH ids were removed. Bump retry
          // counter on the whole batch; next sweep tries the rest. The
          // exhausted-drop above eventually clears IDs that never come
          // back. Better than dropping randomly here.
          const note = `partial_delete:${removed}/${ids.length}`;
          for (const row of batch) {
            docStore.markTombstoneRetried(row.id, note);
          }
          console.warn(
            `[doc-indexer] sweep partial: removed ${removed}/${ids.length}, retrying remainder next sweep`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        for (const row of batch) {
          docStore.markTombstoneRetried(row.id, msg.slice(0, 500));
        }
      }
    }
    return { drained, still_pending: docStore.countPendingTombstones(), dropped_exhausted };
  }

  // ─── Re-embed missing ────────────────────────────────────────────

  /**
   * Re-embed chunks whose `embedding_hash IS NULL`. Scope is explicit:
   * `sourceId` (preferred for the "this source got stuck halfway"
   * recovery path), `collectionId`, or nothing (entire corpus — used by
   * the global `POST /api/docs/embeddings/retry` endpoint).
   *
   * Uses the same worker-pool pattern as `embedAndUpsert` so a stuck
   * source with 5000 missing chunks doesn't take 15 minutes
   * sequentially. Emits `onProgress` per completed batch so the UI can
   * render a live bar in the source row while retry is running.
   */
  async retryEmbeddings(
    scope: { sourceId?: number; collectionId?: number; force?: boolean } = {},
    callbacks?: {
      onProgress?: (p: { current: number; total: number; phase: 'embedding' }) => void | Promise<void>;
    },
  ): Promise<{ embedded: number; tokens: number; total: number }> {
    const { docStore, embeddingService, vectorStore, progressTracker } = this.deps;
    if (!embeddingService || !vectorStore) {
      return { embedded: 0, tokens: 0, total: 0 };
    }
    // `force` wipes existing embedding state before re-running. Use
    // when the remote vector store silently rejected previous upserts
    // (badge says "✓ embedded" but search returns 0). Source-scoped
    // only — refuse on collection-wide force to avoid foot-gun.
    if (scope.force && scope.sourceId != null) {
      const { cleared } = docStore.clearEmbeddingsForSource(scope.sourceId);
      console.log(`[doc-indexer] force re-embed source=${scope.sourceId} → cleared ${cleared} chunk(s)`);
    }
    // Snapshot the missing set up-front. Doing this incrementally would
    // race with the writes we make as we go (each `updateChunkEmbedding`
    // removes a chunk from the pending set on the next query, but a
    // concurrent fresh ingest could ADD new ones — out of scope for a
    // single retry call).
    const allPending = docStore.listChunksMissingEmbedding({ ...scope, limit: 100_000 });
    const total = allPending.length;
    if (total === 0) return { embedded: 0, tokens: 0, total: 0 };

    // Resolve collection objects once — used for vector metadata.
    const collectionsById = new Map<number, DocCollection | null>();
    const getCollection = (id: number): DocCollection | null => {
      let c = collectionsById.get(id);
      if (c === undefined) {
        c = docStore.getCollection(id);
        collectionsById.set(id, c);
      }
      return c;
    };

    let embedded = 0;
    let totalTokens = 0;
    let cursor = 0;

    const runWorker = async (): Promise<void> => {
      while (true) {
        const start = cursor;
        if (start >= allPending.length) return;
        cursor = start + EMBED_BATCH_SIZE;
        const batch = allPending.slice(start, start + EMBED_BATCH_SIZE);
        const texts = batch.map((c) => buildEmbeddingText(c.heading_path, c.summary, c.content));
        const { vectors, tokens } = await embeddingService.embed(texts);
        totalTokens += tokens;
        const records: VectorRecord[] = [];
        for (let i = 0; i < batch.length; i++) {
          const chunk = batch[i]!;
          const collection = getCollection(chunk.collection_id);
          if (!collection) continue;
          const vec = vectors[i];
          if (!vec) continue;
          records.push({
            id: vectorIdForChunk(chunk.id),
            values: vec,
            metadata: {
              corpus: 'docs',
              type: 'doc_chunk',
              collection: collection.name,
              chunk_id: String(chunk.id),
              source_id: String(chunk.source_id),
              heading_path: chunk.heading_path ?? '',
            },
          });
        }
        // See `embedAndUpsert` — only register the mapping when remote
        // actually accepted. Silent 0-returns from the vector store
        // would otherwise produce a "✓ embedded" badge that doesn't
        // match remote reality.
        let upserted = 0;
        if (records.length > 0) {
          upserted = await vectorStore.upsert(records);
        }
        if (upserted < records.length) {
          console.warn(
            `[doc-indexer] retry vector upsert returned ${upserted}/${records.length} — leaving these chunks pending`,
          );
        }
        if (upserted > 0) {
          for (let i = 0; i < batch.length; i++) {
            const chunk = batch[i]!;
            if (!vectors[i]) continue;
            docStore.recordChunkVector(chunk.id, vectorIdForChunk(chunk.id), 'default');
            docStore.updateChunkEmbedding(chunk.id, hashEmbeddingInput(texts[i]!), 'default');
          }
        }
        embedded += batch.length;
        await callbacks?.onProgress?.({ phase: 'embedding', current: Math.min(embedded, total), total });
        // Bonus: push into the progress tracker for THIS source too, so
        // the source-list live bar lights up during retry just like a
        // fresh ingest. Only meaningful when `scope.sourceId` is set.
        if (scope.sourceId != null) {
          progressTracker?.put(scope.sourceId, {
            phase: 'embedding',
            current: Math.min(embedded, total),
            total,
            chunks_indexed: total,
          });
        }
      }
    };

    const workerCount = Math.min(
      EMBED_CONCURRENCY,
      Math.max(1, Math.ceil(allPending.length / EMBED_BATCH_SIZE)),
    );
    const workers = Array.from({ length: workerCount }, () => runWorker());
    await Promise.all(workers);
    return { embedded, tokens: totalTokens, total };
  }

  // ─── Core orchestrator ───────────────────────────────────────────

  private async runIngest(
    collection: DocCollection,
    source: DocSource,
    produceRawPages: () => Promise<RawPage[]>,
    callbacks?: IndexDocStreamCallbacks,
  ): Promise<DocIngestResult> {
    const { docStore, progressTracker } = this.deps;
    const startedAt = Date.now();
    if (!docStore.tryAcquireSource(source.id)) {
      throw new DocError('already_running', `Source ${source.id} is already being indexed`);
    }
    // Drop any prior snapshot so a fresh run doesn't show stale "done"
    // numbers from a previous attempt before the first onProgress fires.
    progressTracker?.clear(source.id);
    // Wrap callbacks so every onProgress also updates the tracker.
    // Keeping `callbacks` unchanged at the call sites means the rest
    // of the file stays purely event-driven.
    const tracked: IndexDocStreamCallbacks = {
      onStart: callbacks?.onStart,
      onDone: callbacks?.onDone,
      onError: callbacks?.onError,
      onProgress: async (p) => {
        progressTracker?.put(source.id, p);
        await callbacks?.onProgress?.(p);
      },
    };
    docStore.updateCollectionStatus(collection.id, 'indexing');
    await tracked.onStart?.({
      source_id: source.id,
      collection_id: collection.id,
      started_at: new Date(startedAt).toISOString(),
    });
    console.log(
      `[doc-indexer] START source=${source.id} collection=${collection.name} type=${source.type} uri=${source.uri}`,
    );

    try {
      // ── Phase 1: fetch ───────────────────────────────────────────
      docStore.updateSourceStatus(source.id, 'fetching');
      await tracked.onProgress?.({ phase: 'fetching', current: 0, total: 1 });
      console.log(`[doc-indexer] phase=fetching source=${source.id}`);
      const rawPages = await produceRawPages();
      const pagesViaBrowser = rawPages.reduce((acc, p) => acc + (p.via === 'browser' ? 1 : 0), 0);
      console.log(
        `[doc-indexer] fetched ${rawPages.length} raw page(s) source=${source.id} via_browser=${pagesViaBrowser}`,
      );
      await tracked.onProgress?.({
        phase: 'fetching',
        current: rawPages.length,
        total: rawPages.length,
        pages_fetched: rawPages.length,
        pages_via_browser: pagesViaBrowser,
      });

      // ── Phase 2: gate ────────────────────────────────────────────
      await tracked.onProgress?.({
        phase: 'gating',
        current: 0,
        total: rawPages.length,
      });
      console.log(`[doc-indexer] phase=gating source=${source.id} pages=${rawPages.length}`);
      const verdicts = await gatePages(rawPages, {
        resolver: this.deps.pipelineProviderResolver,
        resolveContext: this.deps.resolveContext,
      });
      const accepted: RawPage[] = [];
      let rejected = 0;
      for (let i = 0; i < rawPages.length; i++) {
        const v = verdicts[i];
        const page = rawPages[i]!;
        if (v?.accept) {
          page.is_documentation = true;
          page.gate_reason = v.reason;
          accepted.push(page);
        } else {
          page.is_documentation = false;
          page.gate_reason = v?.reason ?? 'rejected';
          rejected++;
        }
      }
      await tracked.onProgress?.({
        phase: 'gating',
        current: rawPages.length,
        total: rawPages.length,
        pages_accepted: accepted.length,
        pages_rejected: rejected,
      });

      console.log(
        `[doc-indexer] gate done source=${source.id} accepted=${accepted.length} rejected=${rejected}`,
      );

      // ── Phase 3: chunk ───────────────────────────────────────────
      docStore.updateSourceStatus(source.id, 'indexing');
      console.log(`[doc-indexer] phase=chunking source=${source.id}`);
      const chunkInputs: DocChunkInput[] = [];
      const headingsForEnrich: Array<{ chunk_index: number; heading_path: string; content: string }> = [];
      let globalOrd = 0;
      for (const page of accepted) {
        const sections = chunkMarkdown(page.markdown, { defaultRootTitle: page.title ?? 'Document' });
        for (const s of sections) {
          if (chunkInputs.length >= HARD_MAX_CHUNKS_PER_SOURCE) break;
          const ord = globalOrd++;
          const idx = chunkInputs.length;
          chunkInputs.push({
            collection_id: collection.id,
            source_id: source.id,
            ord,
            heading_path: s.heading_path,
            content: s.content,
            content_hash: hashContent(s.content),
            token_count: s.token_count,
            source_uri: page.uri,
          });
          headingsForEnrich.push({
            chunk_index: idx,
            heading_path: s.heading_path,
            content: s.content,
          });
        }
        if (chunkInputs.length >= HARD_MAX_CHUNKS_PER_SOURCE) break;
      }
      await tracked.onProgress?.({
        phase: 'chunking',
        current: chunkInputs.length,
        total: chunkInputs.length,
        chunks_indexed: chunkInputs.length,
        pages_accepted: accepted.length,
        pages_rejected: rejected,
      });

      console.log(
        `[doc-indexer] phase=enriching source=${source.id} chunks=${chunkInputs.length}`,
      );

      // ── Phase 4: enrich ──────────────────────────────────────────
      const enrichments = await enrichChunks(headingsForEnrich, {
        resolver: this.deps.pipelineProviderResolver,
        resolveContext: this.deps.resolveContext,
        onProgress: (done, total) => {
          void tracked.onProgress?.({
            phase: 'enriching',
            current: done,
            total,
            chunks_indexed: chunkInputs.length,
            pages_accepted: accepted.length,
            pages_rejected: rejected,
          });
        },
      });
      for (const e of enrichments) {
        const c = chunkInputs[e.chunk_index];
        if (!c) continue;
        c.summary = e.summary;
        c.concepts = e.concepts;
      }

      // ── Phase 5: persist ─────────────────────────────────────────
      console.log(`[doc-indexer] persisting ${chunkInputs.length} chunk(s) source=${source.id}`);
      docStore.replaceChunksForSource(source.id, chunkInputs);

      // ── Phase 6: embed + vector upsert ───────────────────────────
      console.log(`[doc-indexer] phase=embedding source=${source.id}`);
      const embedTokens = await this.embedAndUpsert(collection, source.id, callbacks);
      console.log(`[doc-indexer] embedded ${embedTokens} tokens source=${source.id}`);

      // ── Phase 7: finalize ────────────────────────────────────────
      docStore.updateSourceStats(source.id, {
        chunk_count: chunkInputs.length,
        page_count: rawPages.length,
        pages_accepted: accepted.length,
        pages_rejected: rejected,
        last_indexed_at: new Date().toISOString(),
      });
      docStore.updateSourceStatus(source.id, 'done');
      docStore.refreshCollectionCounts(collection.id);
      docStore.updateCollectionStatus(collection.id, 'idle');

      const elapsed = Date.now() - startedAt;
      const result: DocIngestResult = {
        source_id: source.id,
        chunks_indexed: chunkInputs.length,
        pages_fetched: rawPages.length,
        pages_accepted: accepted.length,
        pages_rejected: rejected,
        pages_via_browser: pagesViaBrowser,
        cost_usd: 0,
        elapsed_ms: elapsed,
      };
      await tracked.onProgress?.({
        phase: 'done',
        current: chunkInputs.length,
        total: chunkInputs.length,
        chunks_indexed: chunkInputs.length,
        pages_fetched: rawPages.length,
        pages_accepted: accepted.length,
        pages_rejected: rejected,
        pages_via_browser: pagesViaBrowser,
        elapsed_ms: elapsed,
      });
      await tracked.onDone?.(result);
      console.log(
        `[doc-indexer] DONE source=${source.id} chunks=${chunkInputs.length} pages=${rawPages.length} via_browser=${pagesViaBrowser} elapsed=${elapsed}ms`,
      );
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[doc-indexer] ERROR source=${source.id}: ${msg}`);
      docStore.updateSourceStatus(source.id, 'error', msg.slice(0, 1000));
      docStore.updateCollectionStatus(collection.id, 'error', msg.slice(0, 1000));
      await tracked.onError?.(msg);
      if (err instanceof DocError) throw err;
      throw new DocError('internal', msg);
    }
  }

  private async embedAndUpsert(
    collection: DocCollection,
    sourceId: number,
    callbacks?: IndexDocStreamCallbacks,
  ): Promise<number> {
    const { docStore, embeddingService, vectorStore } = this.deps;
    if (!embeddingService || !vectorStore) return 0;
    const allChunks = docStore.listChunksBySource(sourceId);
    if (allChunks.length === 0) return 0;

    // Worker-pool pattern (mirrors enricher.ts). Sequential I/O wins
    // when one round-trip dominates wall-clock; here each batch is
    // embed-then-upsert-then-SQLite which the network dominates.
    // Sequential was ~5-7 chunks/s; concurrency=4 gives ~4x throughput
    // while staying well inside Cloudflare free-tier rate limits
    // (each worker emits ~1-2 req/s, totals ~8 req/s vs the 50/s cap).
    //
    // SQLite writes inside `recordChunkVector` / `updateChunkEmbedding`
    // are synchronous (better-sqlite3) — the engine serializes them
    // for us, so no journal-mode lock contention.
    const total = allChunks.length;
    let totalTokens = 0;
    let done = 0;
    let cursor = 0;

    const runWorker = async (): Promise<void> => {
      while (true) {
        const start = cursor;
        if (start >= allChunks.length) return;
        cursor = start + EMBED_BATCH_SIZE;
        const batch = allChunks.slice(start, start + EMBED_BATCH_SIZE);
        const texts = batch.map((c) => buildEmbeddingText(c.heading_path, c.summary, c.content));
        const { vectors, tokens } = await embeddingService.embed(texts);
        totalTokens += tokens;
        const records: VectorRecord[] = batch.map((chunk, j) => ({
          id: vectorIdForChunk(chunk.id),
          values: vectors[j] ?? [],
          metadata: {
            corpus: 'docs',
            type: 'doc_chunk',
            collection: collection.name,
            chunk_id: String(chunk.id),
            source_id: String(chunk.source_id),
            heading_path: chunk.heading_path ?? '',
          },
        })).filter((r) => r.values.length > 0);
        // Validate that the remote store actually accepted the vectors.
        // If Cloudflare Vectorize / Qdrant / etc. returns 0 (silent
        // rejection — invalid metadata schema, quota, etc.), we MUST
        // NOT register the mapping in `doc_chunk_vectors` — otherwise
        // the badge says "✓ embedded" while remote search returns 0
        // forever (exactly the failure mode that surfaced 2026-05-20).
        // Leaving `embedding_hash=NULL` lets `retryEmbeddings` pick
        // these up later when the remote issue is fixed.
        let upserted = 0;
        if (records.length > 0) {
          upserted = await vectorStore.upsert(records);
        }
        if (upserted < records.length) {
          console.warn(
            `[doc-indexer] vector upsert returned ${upserted}/${records.length} — leaving these chunks pending for retry`,
          );
        }
        if (upserted > 0) {
          for (let j = 0; j < batch.length; j++) {
            const chunk = batch[j]!;
            if (!vectors[j]) continue;
            docStore.recordChunkVector(chunk.id, vectorIdForChunk(chunk.id), 'default');
            docStore.updateChunkEmbedding(chunk.id, hashEmbeddingInput(texts[j]!), 'default');
          }
        }
        done += batch.length;
        await callbacks?.onProgress?.({
          phase: 'embedding',
          current: Math.min(done, total),
          total,
          chunks_indexed: total,
        });
      }
    };

    const workerCount = Math.min(
      EMBED_CONCURRENCY,
      Math.max(1, Math.ceil(allChunks.length / EMBED_BATCH_SIZE)),
    );
    const workers = Array.from({ length: workerCount }, () => runWorker());
    await Promise.all(workers);
    return totalTokens;
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  private requireCollection(id: number): DocCollection {
    const c = this.deps.docStore.getCollection(id);
    if (!c) throw new DocError('not_found', `collection ${id} not found`);
    return c;
  }

  /**
   * Find an existing source by (collection, uri) or create one. Used so
   * repeated re-indexes on the same URL update the same row.
   */
  private ensureSource(input: {
    collection_id: number;
    type: 'pdf' | 'url';
    uri: string;
    title?: string | null;
    crawl?: DocCrawlConfig;
    pdf_size_bytes?: number;
  }): DocSource {
    const { docStore } = this.deps;
    const existing = docStore.listSourcesByCollection(input.collection_id).find(
      (s) => s.uri === input.uri,
    );
    if (existing) {
      // Persist the crawl config from THIS request so that:
      //   1) `runIngest` reads it back via `defaultCrawlConfig(source)` if
      //      the caller didn't pass `crawl` explicitly,
      //   2) the next "Re-indexar" click (which reads from the source row,
      //      not from a fresh request body) sees the user's latest intent
      //      (e.g. they toggled `llm_extract_links` ON and re-submitted).
      // Without this, the very common flow "I changed a setting and clicked
      // Indexar again on the same URL" silently keeps the old config and
      // the user sees no behavior change.
      if (input.crawl) {
        docStore.updateSourceCrawlConfig(existing.id, input.crawl);
        return docStore.getSource(existing.id) ?? existing;
      }
      return existing;
    }
    return docStore.createSource(input);
  }

  private estimateFromPages(pages: RawPage[], totalPagesFetched?: number): DocIngestEstimate {
    let chunks = 0;
    let tokens = 0;
    for (const page of pages) {
      const sections = chunkMarkdown(page.markdown ?? '', { defaultRootTitle: page.title ?? 'Document' });
      chunks += sections.length;
      tokens += sections.reduce((acc, s) => acc + s.token_count, 0);
    }
    const estimated_cost_usd = (tokens / 1000) * DEFAULT_DRY_RUN_TOKEN_COST_USD_PER_1K;
    const notes: string[] = [];
    if (chunks >= HARD_MAX_CHUNKS_PER_SOURCE) {
      notes.push(`Capped at ${HARD_MAX_CHUNKS_PER_SOURCE} chunks per source.`);
    }
    return {
      pages_to_fetch: totalPagesFetched ?? pages.length,
      pages_likely_accepted: pages.length,
      estimated_chunks: Math.min(chunks, HARD_MAX_CHUNKS_PER_SOURCE),
      estimated_tokens: tokens,
      estimated_cost_usd,
      notes,
    };
  }
}

// ─── Utilities ──────────────────────────────────────────────────────

function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 16);
}

function hashEmbeddingInput(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
}

function stripExtension(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '');
}

function buildEmbeddingText(headingPath: string | null, summary: string | null, content: string): string {
  const head = headingPath ? `# ${headingPath}\n\n` : '';
  const intro = summary ? `${summary}\n\n` : '';
  return `${head}${intro}${content}`;
}

function defaultCrawlConfig(source: DocSource): DocCrawlConfig {
  return {
    enabled: source.crawl_enabled,
    max_pages: source.crawl_max_pages,
    max_depth: source.crawl_max_depth,
    same_origin: source.crawl_same_origin,
    include_pattern: source.crawl_include_pattern,
    exclude_pattern: source.crawl_exclude_pattern,
    required_path: source.crawl_required_path,
    llm_extract_links: source.crawl_llm_extract_links,
    force_browser: source.crawl_force_browser,
  };
}

/**
 * Estimate the per-token cost a dry-run preview should advertise.
 * Exported for tests so they can pin the value.
 */
export const DRY_RUN_TOKEN_COST_USD_PER_1K = DEFAULT_DRY_RUN_TOKEN_COST_USD_PER_1K;

/**
 * Auto-prepend `https://` when the user typed a bare host. Without this,
 * `new URL('docs.unity3d.com/foo')` throws → the crawler's `normalizeUrl`
 * silently drops the seed → ingestion "DONE" with 0 pages and no error.
 * Returns null when the input still isn't parseable after the prepend
 * (caller should turn that into a 400-style DocError).
 *
 * Exported for tests.
 */
export function normalizeSeedUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Reject bare paths / leading slashes — there's no host to assume.
  if (trimmed.startsWith('/')) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    // Require an actual host with a dot — rejects `https://localhost` of course,
    // but the indexer is for public docs and `localhost` is already SSRF-blocked
    // elsewhere. The dot-check catches typos like `https://docs` (no TLD).
    if (!u.host.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}
