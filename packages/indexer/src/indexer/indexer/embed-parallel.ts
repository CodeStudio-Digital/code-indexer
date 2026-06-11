import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import { withConcurrency } from './enrich-references.js';
import type { EmbeddingCandidate } from './embedding-candidates.js';

/**
 * Bounded-concurrency runner for embedding batches.
 *
 * The embed loops were strictly sequential: one in-flight HTTP request at a
 * time, so a network-bound backend (Cloudflare/Bedrock) idled between
 * round-trips. This module slices candidates into chunks and runs them
 * through `withConcurrency` with a per-service bound.
 *
 * The executor function is injected (not imported) to keep this module free
 * of a cycle with embed-executor.ts.
 */

export interface EmbedChunkFailure {
  chunkIndex: number;
  size: number;
  error: string;
}

export interface RunEmbedChunksResult {
  /** Candidates whose chunk fully succeeded (vectors upserted + hashes committed). */
  embedded: number;
  tokens: number;
  lshFailed: number;
  /** Chunks that threw. Their candidates' hashes never committed — the next run re-emits them. */
  failures: EmbedChunkFailure[];
}

export interface RunEmbedChunksOptions {
  chunkSize: number;
  concurrency: number;
  execute: (chunk: EmbeddingCandidate[]) => Promise<{ tokens: number; lshFailed: number }>;
  onChunkDone?: (progress: { embedded: number; total: number }) => void;
}

/**
 * Resolve how many embedding chunks may be in flight at once.
 * Layered: `MCP_EMBED_CONCURRENCY` env (operator kill switch — `1` restores
 * the historical sequential behavior) → the service's own hint → 1.
 */
export function resolveEmbedConcurrency(service: EmbeddingService): number {
  const env = Number(process.env.MCP_EMBED_CONCURRENCY);
  if (Number.isFinite(env) && env >= 1) return Math.floor(env);
  const hint = service.maxConcurrency?.();
  if (hint !== undefined && Number.isFinite(hint) && hint >= 1) return Math.floor(hint);
  return 1;
}

/**
 * Slice candidates into chunks of ~`chunkSize`, never splitting a group.
 * Multi-window symbol bodies share a `groupKey` and only their LAST window
 * carries the hash commit — with concurrent chunks, a later chunk could
 * commit the hash while an earlier chunk (holding sibling windows) still
 * fails. Keeping the group in one chunk removes that window entirely.
 * Groups are bounded by MCP_INDEX_BODY_MAX_CHUNKS (default 4), so a chunk
 * exceeds `chunkSize` by at most a few candidates.
 */
export function sliceCandidateChunks(
  candidates: EmbeddingCandidate[],
  chunkSize: number,
): EmbeddingCandidate[][] {
  const chunks: EmbeddingCandidate[][] = [];
  let current: EmbeddingCandidate[] = [];
  for (let i = 0; i < candidates.length; i++) {
    current.push(candidates[i]);
    if (current.length < chunkSize) continue;
    const next = candidates[i + 1];
    const continuesGroup = next?.groupKey !== undefined && next.groupKey === candidates[i].groupKey;
    if (!continuesGroup) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Run all chunks with bounded concurrency. A failing chunk never aborts its
 * siblings (strictly better than the old sequential loop, which abandoned
 * everything after the first throw); it is recorded in `failures` and its
 * candidates re-emit on the next run because their hashes never committed.
 * The callback passed to `withConcurrency` must not reject — that helper
 * short-circuits on rejection — so the try/catch lives inside it.
 */
export async function runEmbedChunks(
  candidates: EmbeddingCandidate[],
  opts: RunEmbedChunksOptions,
): Promise<RunEmbedChunksResult> {
  const chunks = sliceCandidateChunks(candidates, opts.chunkSize);
  const result: RunEmbedChunksResult = { embedded: 0, tokens: 0, lshFailed: 0, failures: [] };
  await withConcurrency(chunks, async (chunk, chunkIndex) => {
    try {
      const r = await opts.execute(chunk);
      result.embedded += chunk.length;
      result.tokens += r.tokens;
      result.lshFailed += r.lshFailed;
    } catch (err) {
      result.failures.push({
        chunkIndex,
        size: chunk.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    opts.onChunkDone?.({ embedded: result.embedded, total: candidates.length });
  }, opts.concurrency);
  return result;
}
