import type { CodeIndexDB } from '@mcp/store/db.js';
import {
  embedDocumentsForNamespace,
  type EmbeddingService,
} from '@mcp/indexer/search/embeddings.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import type { CostTracker } from '@mcp/services/services/costs.js';
import type { VectorRecord } from '@mcp/shared/types.js';
import { codeNamespace } from '@mcp/shared/vector-namespace.js';
import type { LshIndexingSink } from '@mcp/indexer/indexer/lsh-indexing-sink.js';
import type { EmbeddingCandidate } from './embedding-candidates.js';

export interface EmbedExecutorDeps {
  db: CodeIndexDB;
  embeddingService: EmbeddingService;
  vectorStore: VectorStore | null;
  costTracker: CostTracker;
  lshSink: LshIndexingSink;
  indexProfile?: 'aggressive' | 'balanced' | 'conservative';
}

/**
 * Provider/model labels for cost rows, derived from the service fingerprint
 * (`cloudflare:bge-m3`, `local:Xenova/…`, `bedrock:amazon.titan…`). Hardcoding
 * cloudflare/bge-m3 here made cost history lie whenever the embedder was
 * local or Bedrock. The Cloudflare label keeps its historical model id so
 * existing cost series and model_prices rows still line up.
 */
export function embeddingCostIdentity(service: EmbeddingService): { provider: string; model: string } {
  return embeddingCostIdentityFromFingerprint(
    service.fingerprint?.() ?? 'embedding:unknown',
  );
}

function embeddingCostIdentityFromFingerprint(fp: string): { provider: string; model: string } {
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
 * Ordering invariant: vector upsert (which atomically records semantic_items)
 * → stale-chunk delete → LSH sink. semantic_items is the only durable vector
 * id/hash ledger; structural rows no longer cache embedding completion.
 */
export async function executeEmbedding(
  deps: EmbedExecutorDeps,
  project: { id: number; name: string },
  runId: number | null,
  candidates: EmbeddingCandidate[],
): Promise<ExecuteEmbeddingResult> {
  if (!deps.vectorStore) throw new Error('vectorStore is required for executeEmbedding');
  const namespace = codeNamespace(project.id);
  const { vectors, tokens, writeTarget } = await embedDocumentsForNamespace(
    deps.embeddingService,
    namespace,
    candidates.map((c) => c.text),
  );
  const sourceHashes = candidates.map((candidate) => {
    if (!writeTarget) return candidate.hash;
    if (candidate.hashForFingerprint) {
      return candidate.hashForFingerprint(writeTarget.embeddingFingerprint);
    }
    if (candidate.embeddingFingerprint
      && candidate.embeddingFingerprint !== writeTarget.embeddingFingerprint) {
      throw new Error(
        `cannot re-hash ${candidate.id} from ${candidate.embeddingFingerprint} `
        + `to ${writeTarget.embeddingFingerprint}`,
      );
    }
    return candidate.hash;
  });

  if (runId !== null) {
    const identity = writeTarget
      ? embeddingCostIdentityFromFingerprint(writeTarget.embeddingFingerprint)
      : embeddingCostIdentity(deps.embeddingService);
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
    metadata: { ...c.metadata, embedding_hash: sourceHashes[i] },
  }));

  // Capture the old physical identities before upsert atomically replaces
  // their semantic_items rows. Reading this afterwards loses the only durable
  // pointer to an id changed by symbol disambiguation or another migration.
  const expectedVectorIds = new Map<string, Map<number, string>>();
  const cleanupKeys = new Set<string>();
  for (const candidate of candidates) {
    const type = candidate.metadata.type ?? 'vector';
    const ref = candidate.metadata.ref_id ?? candidate.id;
    const key = `${type}:${ref}`;
    const chunkIndex = Number(candidate.metadata.chunk_index ?? 0) || 0;
    const chunks = expectedVectorIds.get(key) ?? new Map<number, string>();
    chunks.set(chunkIndex, candidate.id);
    expectedVectorIds.set(key, chunks);
    cleanupKeys.add(key);
    // A symbol can move between a standalone body and a sibling group. The
    // alternate logical item is stale when this candidate form is emitted.
    if (type === 'symbol_body') cleanupKeys.add(`symbol_group:${ref}`);
    if (type === 'symbol_group') cleanupKeys.add(`symbol_body:${ref}`);
  }
  const previousLedgerRows = await (writeTarget
    ? deps.vectorStore.listItems?.(namespace, [...cleanupKeys], writeTarget)
    : deps.vectorStore.listItems?.(namespace, [...cleanupKeys])) ?? [];

  // Isolate by project namespace so another project's code never pollutes
  // this project's search top-K (and a project delete can drop it wholesale).
  const accepted = await (writeTarget
    ? deps.vectorStore.upsert(vectorRecords, namespace, writeTarget)
    : deps.vectorStore.upsert(vectorRecords, namespace));
  if (accepted !== vectorRecords.length) {
    throw new Error(
      `vector store accepted ${accepted}/${vectorRecords.length} code embedding record(s)`,
    );
  }

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

  // Delete stale identities only after every replacement landed. A changed
  // source hash with the SAME id was overwritten in place and must not be
  // deleted; only removed chunks/items and changed ids are superseded.
  const superseded = previousLedgerRows.flatMap((row) => {
    const currentChunks = expectedVectorIds.get(row.itemKey);
    return row.vectorId && (!currentChunks || currentChunks.get(row.chunkIndex) !== row.vectorId)
      ? [row.vectorId]
      : [];
  });
  // Deterministic ids also cover vector stores without a semantic ledger and
  // legacy orphan vectors whose ledger row was already lost to a collision.
  superseded.push(...candidates.flatMap((candidate) => candidate.supersededIds ?? []));
  const uniqueSuperseded = [...new Set(superseded)];
  if (uniqueSuperseded.length > 0) {
    if (writeTarget) await deps.vectorStore.deleteByIds(uniqueSuperseded, namespace, writeTarget);
    else await deps.vectorStore.deleteByIds(uniqueSuperseded, namespace);
    try { await deps.lshSink.afterDelete?.(project.id, uniqueSuperseded); }
    catch { /* LSH is best-effort; stale buckets only cost recall. */ }
  }
  return { tokens, lshFailed };
}
