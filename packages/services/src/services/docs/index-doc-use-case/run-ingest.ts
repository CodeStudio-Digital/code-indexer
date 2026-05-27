import type { DocChunkInput, DocCollection, DocSource } from '@mcp/store/doc-store.js';
import { chunkMarkdown } from '../section-chunker.js';
import { enrichChunks } from '../enricher.js';
import { gatePages } from '../relevance-gate.js';
import { DocError } from '../errors.js';
import type { RawPage } from '../types.js';
import { embedAndUpsert } from './embed-upsert.js';
import { hashContent } from './utils.js';
import {
  HARD_MAX_CHUNKS_PER_SOURCE,
  type IndexDocStreamCallbacks,
  type IndexDocUseCaseDeps,
} from './types.js';
import type { DocIngestResult } from '../types.js';

/**
 * Core ingestion orchestrator: drives the 7-phase pipeline for one source.
 *
 *   1. acquire (lock)  2. fetch  3. gate (skippable)
 *   4. chunk           5. enrich 6. embed+upsert         7. finalize
 *
 * Each phase emits a progress frame via `IndexDocStreamCallbacks`. Wraps the
 * caller's callbacks to ALSO push every frame into the optional
 * `progressTracker` so the `/progress` HTTP poll always sees the latest state.
 *
 * Concurrency is enforced by `DocStore.tryAcquireSource` — a second concurrent
 * call gets `DocError('already_running')`. On error, both the source and the
 * collection are flipped to `error` with the message slice so the UI shows
 * something actionable.
 */
export async function runIngest(
  deps: IndexDocUseCaseDeps,
  collection: DocCollection,
  source: DocSource,
  produceRawPages: () => Promise<RawPage[]>,
  callbacks?: IndexDocStreamCallbacks,
  runOpts?: { skipGate?: boolean },
): Promise<DocIngestResult> {
  const { docStore, progressTracker, embeddingService, vectorStore } = deps;
  const startedAt = Date.now();
  if (!docStore.tryAcquireSource(source.id)) {
    throw new DocError('already_running', `Source ${source.id} is already being indexed`);
  }
  // Drop any prior snapshot so a fresh run doesn't show stale "done" numbers
  // from a previous attempt before the first onProgress fires.
  progressTracker?.clear(source.id);
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
    // ── Phase 1: fetch ─────────────────────────────────────────────
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

    // ── Phase 2: gate (skippable) ──────────────────────────────────
    const { accepted, rejected } = await runGate(deps, source, rawPages, tracked, runOpts?.skipGate ?? false);

    // ── Phase 3-5: chunk + enrich + persist ────────────────────────
    docStore.updateSourceStatus(source.id, 'indexing');
    const chunkInputs = buildChunks(collection, source, accepted);
    await tracked.onProgress?.({
      phase: 'chunking',
      current: chunkInputs.length,
      total: chunkInputs.length,
      chunks_indexed: chunkInputs.length,
      pages_accepted: accepted.length,
      pages_rejected: rejected,
    });
    console.log(`[doc-indexer] phase=enriching source=${source.id} chunks=${chunkInputs.length}`);
    await enrichChunkInputs(deps, chunkInputs, accepted.length, rejected, tracked);
    console.log(`[doc-indexer] persisting ${chunkInputs.length} chunk(s) source=${source.id}`);
    docStore.replaceChunksForSource(source.id, chunkInputs);

    // ── Phase 6: embed + vector upsert ─────────────────────────────
    console.log(`[doc-indexer] phase=embedding source=${source.id}`);
    if (embeddingService && vectorStore) {
      const embedTokens = await embedAndUpsert(
        { docStore, embeddingService, vectorStore }, collection, source.id, callbacks,
      );
      console.log(`[doc-indexer] embedded ${embedTokens} tokens source=${source.id}`);
    }

    // ── Phase 7: finalize ──────────────────────────────────────────
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

async function runGate(
  deps: IndexDocUseCaseDeps,
  source: DocSource,
  rawPages: RawPage[],
  tracked: IndexDocStreamCallbacks,
  skipGate: boolean,
): Promise<{ accepted: RawPage[]; rejected: number }> {
  if (skipGate) {
    // Folder bypass path: trata cada page como aceita sem chamar o LLM. Marca
    // o `gate_reason` pra telemetria diferenciar "passou sem ser avaliada".
    const accepted = rawPages.map((page) => {
      page.is_documentation = true;
      page.gate_reason = 'gate_skipped';
      return page;
    });
    await tracked.onProgress?.({
      phase: 'gating',
      current: rawPages.length,
      total: rawPages.length,
      pages_accepted: accepted.length,
      pages_rejected: 0,
    });
    console.log(
      `[doc-indexer] gate SKIPPED source=${source.id} (folder source w/ bypass=true) — all ${rawPages.length} pages accepted`,
    );
    return { accepted, rejected: 0 };
  }

  await tracked.onProgress?.({ phase: 'gating', current: 0, total: rawPages.length });
  console.log(`[doc-indexer] phase=gating source=${source.id} pages=${rawPages.length}`);
  const verdicts = await gatePages(rawPages, {
    resolver: deps.pipelineProviderResolver,
    resolveContext: deps.resolveContext,
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
  console.log(`[doc-indexer] gate done source=${source.id} accepted=${accepted.length} rejected=${rejected}`);
  return { accepted, rejected };
}

function buildChunks(
  collection: DocCollection,
  source: DocSource,
  accepted: RawPage[],
): DocChunkInput[] {
  const chunkInputs: DocChunkInput[] = [];
  let globalOrd = 0;
  for (const page of accepted) {
    const sections = chunkMarkdown(page.markdown, { defaultRootTitle: page.title ?? 'Document' });
    for (const s of sections) {
      if (chunkInputs.length >= HARD_MAX_CHUNKS_PER_SOURCE) break;
      const ord = globalOrd++;
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
    }
    if (chunkInputs.length >= HARD_MAX_CHUNKS_PER_SOURCE) break;
  }
  return chunkInputs;
}

async function enrichChunkInputs(
  deps: IndexDocUseCaseDeps,
  chunkInputs: DocChunkInput[],
  pagesAccepted: number,
  pagesRejected: number,
  tracked: IndexDocStreamCallbacks,
): Promise<void> {
  const headingsForEnrich = chunkInputs.map((c, idx) => ({
    chunk_index: idx,
    heading_path: c.heading_path ?? '',
    content: c.content,
  }));
  const enrichments = await enrichChunks(headingsForEnrich, {
    resolver: deps.pipelineProviderResolver,
    resolveContext: deps.resolveContext,
    onProgress: (done, total) => {
      void tracked.onProgress?.({
        phase: 'enriching',
        current: done,
        total,
        chunks_indexed: chunkInputs.length,
        pages_accepted: pagesAccepted,
        pages_rejected: pagesRejected,
      });
    },
  });
  for (const e of enrichments) {
    const c = chunkInputs[e.chunk_index];
    if (!c) continue;
    c.summary = e.summary;
    c.concepts = e.concepts;
  }
}
