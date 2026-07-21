import type { Database as DB } from 'better-sqlite3';
import type { DocFtsHit } from './types.js';
import { sanitizeFtsQuery } from './mappers.js';
import { buildFtsMatch } from '../db/fts-query.js';

/**
 * Full-text search over doc_chunks. Returns chunk ids in rank order plus
 * the bm25 rank (lower is better, negate to use as ascending score).
 *
 * Scoping: `collectionIds` restricts to a subset of collections (project
 * scoping, migration 134); `collectionId` is the legacy single-collection
 * filter and is folded into the same path. Neither → global search.
 */
export function searchChunks(
  db: DB,
  query: string,
  opts: { collectionId?: number; collectionIds?: readonly number[]; limit?: number } = {},
): DocFtsHit[] {
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];
  const relaxed = buildFtsMatch(query, 'OR');
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
  const ids = opts.collectionIds ?? (opts.collectionId !== undefined ? [opts.collectionId] : undefined);
  if (ids !== undefined) {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const statement = db.prepare(
      `SELECT c.id as chunk_id, fts.rank as rank
         FROM doc_chunks_fts fts
         JOIN doc_chunks c ON c.id = fts.rowid
        WHERE fts.doc_chunks_fts MATCH ? AND c.collection_id IN (${placeholders})
        ORDER BY fts.rank
        LIMIT ?`,
    );
    const strict = statement.all(sanitized, ...ids, limit) as DocFtsHit[];
    if (strict.length > 0 || relaxed === sanitized) return strict;
    return statement.all(relaxed, ...ids, limit) as DocFtsHit[];
  }
  const statement = db.prepare(
    `SELECT rowid as chunk_id, rank
       FROM doc_chunks_fts
      WHERE doc_chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?`,
  );
  const strict = statement.all(sanitized, limit) as DocFtsHit[];
  if (strict.length > 0 || relaxed === sanitized) return strict;
  return statement.all(relaxed, limit) as DocFtsHit[];
}
