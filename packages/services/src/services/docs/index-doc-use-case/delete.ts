import type { DocStore } from '@mcp/store/doc-store.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import { MAX_TOMBSTONE_RETRIES } from './types.js';

export interface DeleteResult { remote_deleted: number; queued_for_retry: number; }
export interface SweepResult { drained: number; still_pending: number; dropped_exhausted: number; }

/**
 * Shared body of `deleteSource` / `deleteCollection`. Collects the
 * (vector_id, provider) refs BEFORE the SQLite delete (cascade wipes the
 * mapping table), then runs the delete, then issues the remote delete call
 * OUTSIDE any transaction (network I/O must never block the writer thread).
 *
 * Single-process server + `tryAcquireSource` ingestion gate means there's no
 * concurrent inserter racing between the two SQL ops — sequential is safe.
 */
export async function deleteAndCleanup(
  docStore: DocStore,
  vectorStore: VectorStore | null,
  collectVectorRefs: () => Array<{ vector_id: string; provider: string }>,
  runSqliteDelete: () => void,
  /** Doc collection namespace — required for backends with namespace-scoped
   *  ids (Pinecone); ignored by id-keyed backends. */
  namespace?: string,
): Promise<DeleteResult> {
  const refs = collectVectorRefs();
  runSqliteDelete();

  if (refs.length === 0 || !vectorStore) {
    return { remote_deleted: 0, queued_for_retry: 0 };
  }

  const ids = refs.map((r) => r.vector_id);
  try {
    const removed = await vectorStore.deleteByIds(ids, namespace);
    if (removed >= ids.length) {
      console.log(`[doc-indexer] vector cleanup: removed ${removed}/${ids.length} vector(s) remotely`);
      return { remote_deleted: removed, queued_for_retry: 0 };
    }
    // Partial — either some IDs were already gone OR the store silently
    // rejected some. We can't distinguish from the API surface, so queue the
    // full set for retry. The UNIQUE constraint dedupes; MAX_TOMBSTONE_RETRIES
    // bounds the loop.
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
 * Drain pending tombstones — try `vectorStore.deleteByIds` for the batch,
 * remove succeeding rows, bump retry_count on the rest. Called at boot
 * (best-effort) and via `POST /api/docs/vectors/sweep` for manual drains.
 *
 * Groups by provider so heterogeneous deployments (legacy rows for a
 * provider no longer active) don't poison the whole batch.
 */
export async function sweepTombstones(
  docStore: DocStore,
  vectorStore: VectorStore | null,
  limit: number = 500,
): Promise<SweepResult> {
  // First, drop tombstones at the retry ceiling. Almost always IDs the remote
  // already deleted (or never had) — we can't tell from the API, so we give
  // up after MAX_TOMBSTONE_RETRIES attempts.
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

  // Group by provider so each batch hits the right backend.
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
        for (const row of batch) {
          docStore.deleteTombstone(row.id);
          drained++;
        }
      } else {
        // Partial — we can't tell WHICH ids were removed. Bump retry counter
        // on the whole batch; next sweep tries the rest. The exhausted-drop
        // above eventually clears IDs that never come back.
        const note = `partial_delete:${removed}/${ids.length}`;
        for (const row of batch) docStore.markTombstoneRetried(row.id, note);
        console.warn(
          `[doc-indexer] sweep partial: removed ${removed}/${ids.length}, retrying remainder next sweep`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      for (const row of batch) docStore.markTombstoneRetried(row.id, msg.slice(0, 500));
    }
  }
  return { drained, still_pending: docStore.countPendingTombstones(), dropped_exhausted };
}
