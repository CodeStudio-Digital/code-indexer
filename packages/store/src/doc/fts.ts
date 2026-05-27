import type { Database as DB } from 'better-sqlite3';
import type { DocFtsHit } from './types.js';
import { sanitizeFtsQuery } from './mappers.js';

/**
 * Full-text search over doc_chunks. Returns chunk ids in rank order plus
 * the bm25 rank (lower is better, negate to use as ascending score).
 *
 * `collectionId` scopes results to a single collection when supplied —
 * otherwise searches across all collections.
 */
export function searchChunks(
  db: DB,
  query: string,
  opts: { collectionId?: number; limit?: number } = {},
): DocFtsHit[] {
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
  if (opts.collectionId !== undefined) {
    const rows = db
      .prepare(
        `SELECT c.id as chunk_id, fts.rank as rank
           FROM doc_chunks_fts fts
           JOIN doc_chunks c ON c.id = fts.rowid
          WHERE fts.doc_chunks_fts MATCH ? AND c.collection_id = ?
          ORDER BY fts.rank
          LIMIT ?`,
      )
      .all(sanitized, opts.collectionId, limit) as Array<{ chunk_id: number; rank: number }>;
    return rows;
  }
  const rows = db
    .prepare(
      `SELECT rowid as chunk_id, rank
         FROM doc_chunks_fts
        WHERE doc_chunks_fts MATCH ?
        ORDER BY rank
        LIMIT ?`,
    )
    .all(sanitized, limit) as Array<{ chunk_id: number; rank: number }>;
  return rows;
}
