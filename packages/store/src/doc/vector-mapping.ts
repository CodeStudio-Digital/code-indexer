import type { Database as DB } from 'better-sqlite3';
import type { DocChunk, DocVectorRef, DocVectorTombstoneRow } from './types.js';
import { mapChunk } from './mappers.js';

// ─── Vector mapping ──────────────────────────────────────────────

/**
 * Collect every (vector_id, provider) pair currently mapped to chunks
 * belonging to `sourceId`. MUST be called BEFORE the `DELETE FROM doc_sources`
 * because the FK cascade wipes `doc_chunk_vectors` rows along with the chunks.
 */
export function listForSource(db: DB, sourceId: number): DocVectorRef[] {
  return db
    .prepare(
      `SELECT v.vector_id AS vector_id, v.provider AS provider
         FROM doc_chunk_vectors v
         JOIN doc_chunks c ON c.id = v.chunk_id
        WHERE c.source_id = ?`,
    )
    .all(sourceId) as DocVectorRef[];
}

/** Same as `listForSource` but across all sources of a collection. */
export function listForCollection(db: DB, collectionId: number): DocVectorRef[] {
  return db
    .prepare(
      `SELECT v.vector_id AS vector_id, v.provider AS provider
         FROM doc_chunk_vectors v
         JOIN doc_chunks c ON c.id = v.chunk_id
        WHERE c.collection_id = ?`,
    )
    .all(collectionId) as DocVectorRef[];
}

export function record(db: DB, chunkId: number, vectorId: string, provider: string): void {
  db
    .prepare(
      `INSERT OR REPLACE INTO doc_chunk_vectors (chunk_id, vector_id, provider)
       VALUES (?, ?, ?)`,
    )
    .run(chunkId, vectorId, provider);
}

export function getChunkIdForVector(db: DB, vectorId: string, provider: string): number | null {
  const row = db
    .prepare(
      `SELECT chunk_id FROM doc_chunk_vectors WHERE vector_id = ? AND provider = ?`,
    )
    .get(vectorId, provider) as { chunk_id: number } | undefined;
  return row?.chunk_id ?? null;
}

/**
 * Rehydrate chunks from a list of (vector_id, provider) pairs. Preserves
 * input order; missing entries are silently dropped.
 */
export function getChunksByVectorIds(
  db: DB,
  vectorIds: readonly string[],
  provider: string,
): DocChunk[] {
  if (vectorIds.length === 0) return [];
  const placeholders = vectorIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT c.* FROM doc_chunks c
         JOIN doc_chunk_vectors v ON v.chunk_id = c.id
        WHERE v.vector_id IN (${placeholders}) AND v.provider = ?`,
    )
    .all(...vectorIds, provider) as Array<Record<string, unknown>>;
  const byId = new Map<string, DocChunk>();
  for (const r of rows) byId.set(String(r.id), mapChunk(r));
  // Preserve input order. (Vector_id → chunk_id lookup.)
  const ordered: DocChunk[] = [];
  for (const vid of vectorIds) {
    const chunkId = getChunkIdForVector(db, vid, provider);
    if (chunkId != null) {
      const ch = byId.get(String(chunkId));
      if (ch) ordered.push(ch);
    }
  }
  return ordered;
}

export function countMappings(db: DB): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM doc_chunk_vectors').get() as { c: number };
  return row.c;
}

// ─── Vector tombstones (orphan cleanup retry queue) ─────────────

/**
 * Enqueue (vector_id, provider) pairs that we failed to delete from the
 * remote vector store. `INSERT OR IGNORE` dedupes repeated failures for
 * the same vector — the sweep just retries the existing row instead of
 * growing the queue. Returns the count of newly inserted rows.
 */
export function recordTombstones(
  db: DB,
  items: ReadonlyArray<DocVectorRef & { error?: string | null }>,
): number {
  if (items.length === 0) return 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO doc_vector_tombstones (vector_id, provider, last_error)
     VALUES (@vector_id, @provider, @last_error)`,
  );
  let inserted = 0;
  const tx = db.transaction((rows: ReadonlyArray<DocVectorRef & { error?: string | null }>) => {
    for (const r of rows) {
      const result = insert.run({
        vector_id: r.vector_id,
        provider: r.provider,
        last_error: r.error ?? null,
      });
      if (result.changes > 0) inserted++;
    }
  });
  tx(items);
  return inserted;
}

/** Oldest-first batch of pending tombstones, capped at `limit` (default 500). */
export function listPendingTombstones(db: DB, limit: number = 500): DocVectorTombstoneRow[] {
  return db
    .prepare(
      `SELECT id, vector_id, provider, deleted_at, last_retry_at, retry_count, last_error
         FROM doc_vector_tombstones
        ORDER BY deleted_at ASC
        LIMIT @limit`,
    )
    .all({ limit: Math.max(1, limit) }) as DocVectorTombstoneRow[];
}

/** Bump retry counter + record latest error on a failed sweep attempt. */
export function markTombstoneRetried(db: DB, id: number, error?: string | null): void {
  db
    .prepare(
      `UPDATE doc_vector_tombstones
          SET retry_count   = retry_count + 1,
              last_retry_at = datetime('now'),
              last_error    = @last_error
        WHERE id = @id`,
    )
    .run({ id, last_error: error ?? null });
}

/** Drop a tombstone after the remote delete confirmed success. */
export function deleteTombstone(db: DB, id: number): void {
  db.prepare(`DELETE FROM doc_vector_tombstones WHERE id = ?`).run(id);
}

/**
 * Permanently remove tombstones that have been retried `maxRetries` times
 * without succeeding. Stops the queue from growing forever on IDs the
 * remote will never accept (legacy provider, already-gone vectors, schema
 * drift). After this drop, the dropped IDs remain orphans in the remote
 * store; if that matters, run a manual purge by metadata.
 */
export function dropExhaustedTombstones(db: DB, maxRetries: number): { dropped: number } {
  const result = db
    .prepare(`DELETE FROM doc_vector_tombstones WHERE retry_count >= ?`)
    .run(maxRetries);
  return { dropped: result.changes };
}

export function countPendingTombstones(db: DB): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM doc_vector_tombstones`)
    .get() as { c: number };
  return row.c;
}
