/**
 * Deferred structure-signature embeddings.
 *
 * `analyzeWithTreeSitter` needs an inline `embedQuery` ONLY when it has an
 * old structure embedding to compare against (the similarity gate that
 * decides reuse / cheap-summary / full LLM). When there is nothing to
 * compare (first index of a file, or the inline path errored), the new
 * embedding is storage-only — it exists for FUTURE comparisons. The old
 * code embedded it inline anyway: one HTTP round-trip per file, which on a
 * first index meant N requests for zero decisions (and untracked cost).
 *
 * This queue batches those storage-only signatures after the analyze loop:
 * chunks of EMBED_CHUNK_SIZE → one `embed()` per chunk (the services
 * re-batch by token budget internally) → one transaction per chunk → cost
 * recorded against the run. Failures are non-fatal: a missing structure
 * embedding just re-queues on the next run (the file falls into the
 * "nothing to compare" path again), costing one skipped LLM-skip
 * optimization, never correctness.
 *
 * Signatures are embedded UNTRUNCATED — the inline gate embeds the full
 * string, and cosine comparability requires both sides to see the same text.
 */
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { CostTracker } from '@mcp/services/services/costs.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import { withConcurrency } from './enrich-references.js';
import { embeddingCostIdentity } from './embed-executor.js';
import { EMBED_CHUNK_SIZE, resolveEmbedConcurrency } from './embed-parallel.js';

export interface StructEmbedItem {
  fileId: number;
  structSig: string;
}

export interface StructEmbedResult {
  embedded: number;
  tokens: number;
  failed: number;
}

export async function flushStructEmbeddings(
  deps: { db: CodeIndexDB; embeddingService: EmbeddingService; costTracker: CostTracker },
  project: { id: number },
  runId: number,
  items: StructEmbedItem[],
): Promise<StructEmbedResult> {
  if (items.length === 0) return { embedded: 0, tokens: 0, failed: 0 };

  const chunks: StructEmbedItem[][] = [];
  for (let i = 0; i < items.length; i += EMBED_CHUNK_SIZE) {
    chunks.push(items.slice(i, i + EMBED_CHUNK_SIZE));
  }

  const result: StructEmbedResult = { embedded: 0, tokens: 0, failed: 0 };
  const identity = embeddingCostIdentity(deps.embeddingService);

  await withConcurrency(chunks, async (chunk) => {
    try {
      const { vectors, tokens } = await deps.embeddingService.embed(chunk.map((c) => c.structSig));
      deps.db.transaction(() => {
        chunk.forEach((item, i) => {
          const vec = vectors[i];
          if (vec && vec.length > 0) {
            deps.db.setFileStructureEmbedding(item.fileId, new Float32Array(vec));
            result.embedded++;
          } else {
            result.failed++;
          }
        });
      });
      result.tokens += tokens;
      deps.costTracker.record({
        projectId: project.id,
        runId,
        provider: identity.provider,
        model: identity.model,
        operation: 'embedding',
        inputTokens: tokens,
        outputTokens: 0,
      });
    } catch (err) {
      result.failed += chunk.length;
      console.warn(`[indexer] structure-embedding chunk failed (${chunk.length} sig(s)) — re-queued next run: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, resolveEmbedConcurrency(deps.embeddingService));

  return result;
}
