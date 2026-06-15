import type { CodeIndexDB } from '@mcp/store/db.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import type { CostTracker } from '@mcp/services/services/costs.js';
import type { VectorRecord } from '@mcp/shared/types.js';
import { codeNamespace } from '@mcp/shared/vector-namespace.js';
import type { LshIndexingSink } from '@mcp/indexer/indexer/lsh-indexing-sink.js';
import type { LLMFileAnalysis } from '@mcp/shared/types.js';

import type { EmbeddingCandidate } from './embedding-candidates.js';

export interface EmbedExecutorDeps {
  db: CodeIndexDB;
  embeddingService: EmbeddingService;
  vectorStore: VectorStore | null;
  costTracker: CostTracker;
  lshSink: LshIndexingSink;
  indexProfile?: 'aggressive' | 'balanced' | 'conservative';
}

/** A file that finished the analyze phase — input shape for the embed batcher. */
export interface IndexedFileEntry {
  path: string;
  fileId: number;
  analysis: LLMFileAnalysis;
  content: string;
  tier?: 'core' | 'support' | 'on_demand';
}

/**
 * Provider/model labels for cost rows, derived from the service fingerprint
 * (`cloudflare:bge-m3`, `local:Xenova/…`, `bedrock:amazon.titan…`). Hardcoding
 * cloudflare/bge-m3 here made cost history lie whenever the embedder was
 * local or Bedrock. The Cloudflare label keeps its historical model id so
 * existing cost series and model_prices rows still line up.
 */
export function embeddingCostIdentity(service: EmbeddingService): { provider: string; model: string } {
  const fp = service.fingerprint?.() ?? 'embedding:unknown';
  if (fp === 'cloudflare:bge-m3') return { provider: 'cloudflare', model: '@cf/baai/bge-m3' };
  const sep = fp.indexOf(':');
  return sep > 0
    ? { provider: fp.slice(0, sep), model: fp.slice(sep + 1) }
    : { provider: fp, model: fp };
}

export interface ExecuteEmbeddingResult {
  /** Embedding tokens consumed, for cost accounting. */
  tokens: number;
  /** Records the LSH sink failed to index (best-effort, but counted). */
  lshFailed: number;
}

/**
 * Embed candidates and upsert to vector store. Shared by the embed batcher
 * (after LLM analysis) and `retryEmbeddings` (DB+disk path).
 *
 * Ordering invariant: vector upsert → vector_ids save → LSH sink →
 * `onCommit()` (hash write) LAST — a candidate's hash is only persisted
 * after its vectors verifiably landed.
 */
export async function executeEmbedding(
  deps: EmbedExecutorDeps,
  project: { id: number; name: string },
  runId: number | null,
  candidates: EmbeddingCandidate[],
): Promise<ExecuteEmbeddingResult> {
  if (!deps.vectorStore) throw new Error('vectorStore is required for executeEmbedding');
  const { vectors, tokens } = await deps.embeddingService.embed(candidates.map((c) => c.text));

  if (runId !== null) {
    const identity = embeddingCostIdentity(deps.embeddingService);
    deps.costTracker.record({
      projectId: project.id,
      runId,
      provider: identity.provider,
      model: identity.model,
      operation: 'embedding',
      inputTokens: tokens,
      outputTokens: 0,
    });
  }

  const vectorRecords: VectorRecord[] = candidates.map((c, i) => ({
    id: c.id,
    values: vectors[i],
    metadata: c.metadata,
  }));

  // Isolate by project namespace so another project's code never pollutes
  // this project's search top-K (and a project delete can drop it wholesale).
  await deps.vectorStore.upsert(vectorRecords, codeNamespace(project.name));

  deps.db.saveVectorIds(
    project.id,
    candidates.map((c) => ({
      vectorId: c.id,
      filePath: c.filePath,
      type: c.metadata.type as 'file' | 'symbol' | 'symbol_body',
    })),
  );

  // LSH bucket sink. Optional — default is no-op. When `RealLshIndexingSink`
  // is wired this populates `embedding_simhash_signatures` + `_lsh_buckets`
  // alongside the vector store so the hybrid search can narrow candidates
  // via integer bucket lookup before doing full-precision cosine.
  let lshFailed = 0;
  try {
    await deps.lshSink.afterUpsert(project.id, vectorRecords);
  } catch (err) {
    // LSH is best-effort — indexing continues — but a silently asymmetric
    // LSH index degrades hybrid search, so the failure is counted and logged.
    lshFailed = vectorRecords.length;
    console.warn(`[indexer] LSH sink failed for ${vectorRecords.length} record(s): ${err instanceof Error ? err.message : String(err)}`);
  }

  // Stale extra windows (bodies that shrank from N to M chunks). Deleted
  // only after the replacement windows upserted; remote failure → tombstone
  // queue. The local vector_ids rows go either way.
  const superseded = candidates.flatMap((c) => c.supersededIds ?? []);
  if (superseded.length > 0) {
    try {
      await deps.vectorStore.deleteByIds(superseded, codeNamespace(project.name));
    } catch (err) {
      deps.db.enqueuePendingVectorDeletes(superseded.map((vector_id) => ({
        vector_id,
        project_name: project.name,
        error: err instanceof Error ? err.message : String(err),
      })));
    }
    deps.db.deleteVectorIdRows(project.id, superseded);
  }

  // One transaction for the chunk's hash commits — these were 50 individual
  // autocommit UPDATEs (each its own WAL commit) per chunk. `onCommit` is
  // synchronous by contract (see EmbeddingCandidate.onCommit).
  deps.db.transaction(() => {
    for (const c of candidates) c.onCommit();
  });
  return { tokens, lshFailed };
}
