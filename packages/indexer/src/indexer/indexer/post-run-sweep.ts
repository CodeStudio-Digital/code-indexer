import type { CodeIndexDB } from '@mcp/store/db.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import { codeNamespace } from '@mcp/shared/vector-namespace.js';
import type { LshIndexingSink } from '@mcp/indexer/indexer/lsh-indexing-sink.js';

export interface SweepResult {
  orphans: number;
  remoteDeleted: number;
  tombstoned: number;
}

/**
 * Post-run orphan sweep: vector_ids rows whose file no longer exists are
 * deleted locally and from the vector store (failure → tombstoned into
 * `pending_vector_deletes`, drained by the HygienePanel button / CLI
 * `hygiene vectorize-retry`). Mirrors the manual cleanup in
 * apps/http-api/server/routes/hygiene.ts, but runs automatically at the end
 * of every `indexProject()` so drift stops accumulating between the (rare)
 * manual cleanups.
 */
export async function sweepOrphanVectors(
  db: CodeIndexDB,
  vectorStore: VectorStore | null,
  lshSink: LshIndexingSink,
  project: { id: number; name: string },
): Promise<SweepResult> {
  const orphans = db.getOrphanVectorIds(project.id);
  if (orphans.length === 0) return { orphans: 0, remoteDeleted: 0, tombstoned: 0 };

  const ids = orphans.map((o) => o.vector_id);
  let remoteDeleted = 0;
  let tombstoned = 0;
  if (vectorStore) {
    try {
      remoteDeleted = await vectorStore.deleteByIds(ids, codeNamespace(project.name));
    } catch (err) {
      tombstoned = db.enqueuePendingVectorDeletes(ids.map((vector_id) => ({
        vector_id,
        project_name: project.name,
        error: err instanceof Error ? err.message : String(err),
      })));
    }
  }
  // Local rows go regardless — they describe vectors the index no longer
  // owns; the tombstone queue carries the remote retry when needed.
  db.deleteVectorIdRows(project.id, ids);
  try { await lshSink.afterDelete?.(project.id, ids); }
  catch { /* LSH is best-effort; stale buckets only cost recall */ }

  return { orphans: orphans.length, remoteDeleted, tombstoned };
}
