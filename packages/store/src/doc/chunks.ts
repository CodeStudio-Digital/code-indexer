import type { Database as DB } from 'better-sqlite3';
import type { DocChunk, DocChunkInput } from './types.js';
import { mapChunk } from './mappers.js';

/**
 * Insert chunks in a single transaction. Returns inserted row ids in input
 * order. Run inside `replaceForSource` when re-indexing — FTS triggers fire
 * automatically.
 */
export function insert(db: DB, inputs: DocChunkInput[]): number[] {
  if (inputs.length === 0) return [];
  const stmt = db.prepare(`
    INSERT INTO doc_chunks (
      collection_id, source_id, ord, heading_path,
      content, content_hash, summary, concepts,
      token_count, source_uri
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const ids: number[] = [];
  const tx = db.transaction((rows: DocChunkInput[]) => {
    for (const c of rows) {
      const r = stmt.run(
        c.collection_id,
        c.source_id,
        c.ord,
        c.heading_path ?? null,
        c.content,
        c.content_hash,
        c.summary ?? null,
        c.concepts && c.concepts.length > 0 ? JSON.stringify(c.concepts) : null,
        c.token_count ?? 0,
        c.source_uri ?? null,
      );
      ids.push(r.lastInsertRowid as number);
    }
  });
  tx(inputs);
  return ids;
}

/**
 * Idempotent re-index: drop existing chunks for the source and insert the
 * new set in a single transaction. FTS triggers keep the index in sync.
 */
export function replaceForSource(db: DB, sourceId: number, inputs: DocChunkInput[]): number[] {
  const ids: number[] = [];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM doc_chunks WHERE source_id = ?').run(sourceId);
    if (inputs.length === 0) return;
    const stmt = db.prepare(`
      INSERT INTO doc_chunks (
        collection_id, source_id, ord, heading_path,
        content, content_hash, summary, concepts,
        token_count, source_uri
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of inputs) {
      const r = stmt.run(
        c.collection_id,
        c.source_id,
        c.ord,
        c.heading_path ?? null,
        c.content,
        c.content_hash,
        c.summary ?? null,
        c.concepts && c.concepts.length > 0 ? JSON.stringify(c.concepts) : null,
        c.token_count ?? 0,
        c.source_uri ?? null,
      );
      ids.push(r.lastInsertRowid as number);
    }
  });
  tx();
  return ids;
}

export function get(db: DB, id: number): DocChunk | null {
  const row = db.prepare('SELECT * FROM doc_chunks WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapChunk(row) : null;
}

export function getByIds(db: DB, ids: readonly number[]): DocChunk[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM doc_chunks WHERE id IN (${placeholders})`)
    .all(...ids) as Array<Record<string, unknown>>;
  return rows.map(mapChunk);
}

/** Returns surrounding chunks (ord ± window) for the same source. */
export function getNeighbors(db: DB, chunkId: number, window: number = 1): DocChunk[] {
  const seed = get(db, chunkId);
  if (!seed) return [];
  const rows = db
    .prepare(
      `SELECT * FROM doc_chunks
        WHERE source_id = ? AND ord BETWEEN ? AND ?
        ORDER BY ord ASC`,
    )
    .all(seed.source_id, seed.ord - window, seed.ord + window) as Array<Record<string, unknown>>;
  return rows.map(mapChunk);
}

export function listBySource(db: DB, sourceId: number): DocChunk[] {
  const rows = db
    .prepare('SELECT * FROM doc_chunks WHERE source_id = ? ORDER BY ord ASC')
    .all(sourceId) as Array<Record<string, unknown>>;
  return rows.map(mapChunk);
}

/**
 * Wipe embedding state for a source: drops `doc_chunk_vectors` rows AND
 * nulls `embedding_hash` on every chunk so `retryEmbeddings` picks them up
 * as pending. Use when you suspect the remote vector store rejected
 * silently. Local-only operation; remote orphans stay until manual cleanup.
 */
export function clearEmbeddingsForSource(db: DB, sourceId: number): { cleared: number } {
  const tx = db.transaction(() => {
    db
      .prepare(
        `DELETE FROM doc_chunk_vectors WHERE chunk_id IN (
           SELECT id FROM doc_chunks WHERE source_id = ?
         )`,
      )
      .run(sourceId);
    const result = db
      .prepare(
        `UPDATE doc_chunks SET embedding_hash = NULL, embedding_provider_id = NULL
          WHERE source_id = ?`,
      )
      .run(sourceId);
    return { cleared: result.changes };
  });
  return tx();
}

/**
 * Chunks that still need an embedding. Scoped by `sourceId` (preferred —
 * bounded set) OR `collectionId` (broader) OR neither (all corpus).
 * `sourceId` wins when both are passed. Object-style options so callers
 * don't accidentally pass a sourceId where a collectionId is expected.
 */
export function listMissingEmbedding(
  db: DB,
  opts: { sourceId?: number; collectionId?: number; limit?: number } = {},
): DocChunk[] {
  const where: string[] = ['embedding_hash IS NULL'];
  const params: Record<string, unknown> = { limit: opts.limit ?? 500 };
  if (opts.sourceId != null) {
    where.push('source_id = @sourceId');
    params.sourceId = opts.sourceId;
  } else if (opts.collectionId != null) {
    where.push('collection_id = @collectionId');
    params.collectionId = opts.collectionId;
  }
  const rows = db
    .prepare(
      `SELECT * FROM doc_chunks WHERE ${where.join(' AND ')} ORDER BY id LIMIT @limit`,
    )
    .all(params) as Array<Record<string, unknown>>;
  return rows.map(mapChunk);
}

export function updateEmbedding(db: DB, chunkId: number, embeddingHash: string, providerId: string): void {
  db
    .prepare(
      `UPDATE doc_chunks
          SET embedding_hash = ?, embedding_provider_id = ?
        WHERE id = ?`,
    )
    .run(embeddingHash, providerId, chunkId);
}

export function countByCollection(db: DB, collectionId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) as c FROM doc_chunks WHERE collection_id = ?')
    .get(collectionId) as { c: number };
  return row.c;
}
