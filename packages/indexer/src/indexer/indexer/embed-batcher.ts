/**
 * Streaming embed batcher — bounds the embed pipeline's memory.
 *
 * The old flow held EVERY analyzed file's content until one big
 * `buildEmbeddingCandidates` pass after the analyze loop ("hundreds of MB in
 * aggregate for large codebases", as the old release comment admitted). The
 * batcher builds candidates PER FILE the moment it finishes analysis — the
 * caller drops the content right after `addFile` returns — and flushes waves
 * of candidates once `flushThreshold` accumulate.
 *
 * Backpressure is deliberate and hard: `addFile` awaits an in-flight wave
 * (single-flight), so an analyze loop can never out-produce the embedder by
 * more than ~one wave of candidate texts.
 */
import type { EmbeddingCandidate, CandidateFile } from './embedding-candidates.js';
import { buildEmbeddingCandidates } from './embedding-candidates.js';
import { executeEmbedding, type EmbedExecutorDeps, type IndexedFileEntry } from './embed-executor.js';
import { EMBED_CHUNK_SIZE, resolveEmbedConcurrency, runEmbedChunks, type EmbedChunkFailure } from './embed-parallel.js';

export interface EmbedBatchSummary {
  embedded: number;
  tokens: number;
  lshFailed: number;
  failures: EmbedChunkFailure[];
  /** Files skipped by the aggressive-profile on_demand gate. */
  skippedOnDemand: number;
}

const DEFAULT_FLUSH_THRESHOLD = 500;

const resolveFlushThreshold = (): number => {
  const raw = Number(process.env.MCP_EMBED_FLUSH_THRESHOLD);
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return DEFAULT_FLUSH_THRESHOLD;
};

export interface EmbedBatcher {
  /** Build + queue this file's candidates. May await a flush (backpressure). */
  addFile(entry: IndexedFileEntry): Promise<void>;
  /** Flush the tail and return the run's aggregate. */
  finish(): Promise<EmbedBatchSummary>;
}

export function createEmbedBatcher(
  deps: EmbedExecutorDeps,
  project: { id: number; name: string },
  runId: number,
  opts?: { flushThreshold?: number },
): EmbedBatcher {
  const threshold = opts?.flushThreshold ?? resolveFlushThreshold();
  const profile = deps.indexProfile ?? 'balanced';
  const concurrency = resolveEmbedConcurrency(deps.embeddingService);
  const pending: EmbeddingCandidate[] = [];
  const summary: EmbedBatchSummary = { embedded: 0, tokens: 0, lshFailed: 0, failures: [], skippedOnDemand: 0 };
  let flushing: Promise<void> | null = null;

  const flushWave = (): Promise<void> => {
    if (flushing) return flushing;
    if (pending.length === 0) return Promise.resolve();
    // Wave cut happens at a file boundary by construction (addFile only
    // checks the threshold AFTER pushing a whole file's candidates), so a
    // multi-window body group never straddles two waves.
    const wave = pending.splice(0);
    console.error(`[indexer] Embedding wave: ${wave.length} record(s) (concurrency ${concurrency})`);
    flushing = runEmbedChunks(wave, {
      chunkSize: EMBED_CHUNK_SIZE,
      concurrency,
      execute: (chunk) => executeEmbedding(deps, project, runId, chunk),
    }).then((r) => {
      summary.embedded += r.embedded;
      summary.tokens += r.tokens;
      summary.lshFailed += r.lshFailed;
      summary.failures.push(...r.failures);
    }).finally(() => {
      flushing = null;
    });
    return flushing;
  };

  return {
    async addFile(entry: IndexedFileEntry): Promise<void> {
      if (profile === 'aggressive' && entry.tier === 'on_demand') {
        summary.skippedOnDemand++;
        return;
      }
      const file: CandidateFile = {
        path: entry.path,
        fileId: entry.fileId,
        language: entry.analysis.language,
        summary: entry.analysis.summary,
        concepts: entry.analysis.concepts,
        symbols: entry.analysis.symbols,
        content: entry.content,
      };
      pending.push(...buildEmbeddingCandidates(deps.db, project, [file]));
      if (pending.length >= threshold) await flushWave();
    },

    async finish(): Promise<EmbedBatchSummary> {
      for (;;) {
        if (flushing) { await flushing; continue; }
        if (pending.length === 0) break;
        await flushWave();
      }
      if (summary.skippedOnDemand > 0) {
        console.error(`[indexer] Skipped ${summary.skippedOnDemand} on_demand embedding(s) (aggressive profile)`);
      }
      return summary;
    },
  };
}

/**
 * Batch convenience over the streaming batcher — preserved entry point for
 * callers that already hold the full `indexedFiles` list. Throws an
 * aggregate error when any chunk failed, so the run is marked
 * completed_with_errors instead of a silent green.
 */
export async function processEmbeddings(
  deps: EmbedExecutorDeps,
  project: { id: number; name: string },
  runId: number,
  indexedFiles: IndexedFileEntry[],
): Promise<void> {
  const batcher = createEmbedBatcher(deps, project, runId);
  for (const f of indexedFiles) await batcher.addFile(f);
  const res = await batcher.finish();
  if (res.embedded === 0 && res.failures.length === 0) {
    console.error('[indexer] All embeddings up to date — skipping embed pipeline');
    return;
  }
  if (res.failures.length > 0) {
    const attempted = res.embedded + res.failures.reduce((n, f) => n + f.size, 0);
    throw new Error(
      `Embedding failed for ${res.failures.length} batch(es) — ${res.embedded}/${attempted} records embedded. First error: ${res.failures[0].error}`,
    );
  }
}
