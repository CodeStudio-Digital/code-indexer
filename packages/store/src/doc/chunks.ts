import type { Database as DB } from 'better-sqlite3';
import type { DocChunk, DocChunkInput } from './types.js';
import { mapChunk } from './mappers.js';

// Single source of truth for the INSERT shape so `insert` and
// `replaceForSource` can never drift (doc_type/anchor/api_* added in mig 149).
const CHUNK_COLUMNS =
  'collection_id, source_id, ord, heading_path, content, content_hash, ' +
  'summary, concepts, token_count, source_uri, doc_type, anchor, api_symbol, api_signature, ' +
  'stable_key, item_key, ingest_run_id, embedding_input_hash, embedding_fingerprint, ' +
  'enrichment_fingerprint, updated_at';
const CHUNK_PLACEHOLDERS = new Array(21).fill('?').join(', ');
const CHUNK_INSERT_SQL = `INSERT INTO doc_chunks (${CHUNK_COLUMNS}) VALUES (${CHUNK_PLACEHOLDERS})`;

function chunkValues(c: DocChunkInput): unknown[] {
  return [
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
    c.doc_type ?? null,
    c.anchor ?? null,
    c.api_symbol ?? null,
    c.api_signature ?? null,
    c.stable_key ?? null,
    c.item_key ?? null,
    c.ingest_run_id ?? null,
    c.embedding_input_hash ?? null,
    c.embedding_fingerprint ?? null,
    c.enrichment_fingerprint ?? null,
    new Date().toISOString(),
  ];
}

/**
 * Insert chunks in a single transaction. Returns inserted row ids in input
 * order. Run inside `replaceForSource` when re-indexing — FTS triggers fire
 * automatically.
 */
export function insert(db: DB, inputs: DocChunkInput[]): number[] {
  if (inputs.length === 0) return [];
  const stmt = db.prepare(CHUNK_INSERT_SQL);
  const ids: number[] = [];
  const tx = db.transaction((rows: DocChunkInput[]) => {
    for (const c of rows) {
      const r = stmt.run(...chunkValues(c));
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
    const stmt = db.prepare(CHUNK_INSERT_SQL);
    for (const c of inputs) {
      const r = stmt.run(...chunkValues(c));
      ids.push(r.lastInsertRowid as number);
    }
  });
  tx();
  return ids;
}

export interface UpsertItemChunksResult {
  ids: number[];
  changedIds: number[];
  removedVectors: Array<{ vector_id: string; provider: string }>;
}

/**
 * Incrementally replace one logical page/file while preserving chunk row ids.
 * Stable ids keep vector ids stable across re-indexes. Removed vector ids are
 * derived from embedded chunk ids before those chunks are deleted.
 */
export function upsertForItem(
  db: DB,
  sourceId: number,
  itemKey: string,
  runId: number,
  inputs: DocChunkInput[],
): UpsertItemChunksResult {
  const tx = db.transaction(() => upsertForItemInner(db, sourceId, itemKey, runId, inputs));
  return tx();
}

export function upsertForItems(
  db: DB,
  sourceId: number,
  runId: number,
  items: ReadonlyArray<{ itemKey: string; inputs: DocChunkInput[] }>,
): UpsertItemChunksResult[] {
  if (items.length === 0) return [];
  const tx = db.transaction(() => items.map((item) =>
    upsertForItemInner(db, sourceId, item.itemKey, runId, item.inputs)));
  return tx();
}

function upsertForItemInner(
  db: DB,
  sourceId: number,
  itemKey: string,
  runId: number,
  inputs: DocChunkInput[],
): UpsertItemChunksResult {
    const existing = db.prepare(
      `SELECT id,stable_key,embedding_input_hash,embedding_fingerprint
         FROM doc_chunks WHERE source_id=? AND item_key=?`,
    ).all(sourceId, itemKey) as Array<{
      id: number;
      stable_key: string | null;
      embedding_input_hash: string | null;
      embedding_fingerprint: string | null;
    }>;
    const byKey = new Map(existing.filter((r) => r.stable_key).map((r) => [r.stable_key!, r]));
    const nextKeys = new Set(inputs.map((c) => c.stable_key).filter((k): k is string => !!k));
    const removedIds = existing.filter((r) => !r.stable_key || !nextKeys.has(r.stable_key)).map((r) => r.id);
    const removedVectors = vectorRefsForChunkIds(db, removedIds);
    deleteChunkIds(db, removedIds);

    const insertStmt = db.prepare(
      `${CHUNK_INSERT_SQL}
       ON CONFLICT(source_id,stable_key) WHERE stable_key IS NOT NULL DO UPDATE SET
         collection_id=excluded.collection_id,
         ord=excluded.ord,
         heading_path=excluded.heading_path,
         content=excluded.content,
         content_hash=excluded.content_hash,
         summary=excluded.summary,
         concepts=excluded.concepts,
         token_count=excluded.token_count,
         source_uri=excluded.source_uri,
         doc_type=excluded.doc_type,
         anchor=excluded.anchor,
         api_symbol=excluded.api_symbol,
         api_signature=excluded.api_signature,
         item_key=excluded.item_key,
         ingest_run_id=excluded.ingest_run_id,
         embedding_input_hash=excluded.embedding_input_hash,
         enrichment_fingerprint=excluded.enrichment_fingerprint,
         updated_at=excluded.updated_at`,
    );
    const ids: number[] = [];
    const changedIds: number[] = [];
    for (const input of inputs) {
      const prior = input.stable_key ? byKey.get(input.stable_key) : undefined;
      insertStmt.run(...chunkValues({ ...input, source_id: sourceId, item_key: itemKey, ingest_run_id: runId }));
      const row = db.prepare(
        `SELECT id FROM doc_chunks WHERE source_id=? AND stable_key=?`,
      ).get(sourceId, input.stable_key) as { id: number } | undefined;
      if (!row) continue;
      ids.push(row.id);
      const changed = !prior
        || prior.embedding_input_hash !== (input.embedding_input_hash ?? null)
        || prior.embedding_fingerprint !== (input.embedding_fingerprint ?? null);
      if (changed) {
        changedIds.push(row.id);
        db.prepare(
          `UPDATE doc_chunks SET embedding_hash=NULL, embedding_provider_id=NULL,
             embedding_fingerprint=NULL WHERE id=?`,
        ).run(row.id);
      }
    }
    return { ids, changedIds, removedVectors };
}

export function removeForItems(
  db: DB,
  sourceId: number,
  itemKeys: readonly string[],
): Array<{ vector_id: string; provider: string }> {
  if (itemKeys.length === 0) return [];
  const placeholders = itemKeys.map(() => '?').join(',');
  const ids = (db.prepare(
    `SELECT id FROM doc_chunks WHERE source_id=? AND item_key IN (${placeholders})`,
  ).all(sourceId, ...itemKeys) as Array<{ id: number }>).map((r) => r.id);
  return removeChunkIds(db, ids);
}

export function removeLegacy(db: DB, sourceId: number): Array<{ vector_id: string; provider: string }> {
  const ids = (db.prepare(
    `SELECT id FROM doc_chunks WHERE source_id=? AND stable_key IS NULL`,
  ).all(sourceId) as Array<{ id: number }>).map((r) => r.id);
  return removeChunkIds(db, ids);
}

function removeChunkIds(
  db: DB,
  ids: readonly number[],
): Array<{ vector_id: string; provider: string }> {
  if (ids.length === 0) return [];
  const tx = db.transaction(() => {
    const refs = vectorRefsForChunkIds(db, ids);
    deleteChunkIds(db, ids);
    return refs;
  });
  return tx();
}

function vectorRefsForChunkIds(
  db: DB,
  ids: readonly number[],
): Array<{ vector_id: string; provider: string }> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(
    `SELECT DISTINCT COALESCE(si.vector_id, si.item_key) AS vector_id,
            'semantic:g' || si.generation_id AS provider
       FROM semantic_items si
      WHERE si.item_key IN (
        SELECT 'doc_chunk:' || id FROM doc_chunks WHERE id IN (${placeholders})
      )`,
  ).all(...ids) as Array<{ vector_id: string; provider: string }>;
}

function deleteChunkIds(db: DB, ids: readonly number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM doc_chunks WHERE id IN (${placeholders})`).run(...ids);
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
        WHERE source_id = ? AND source_uri IS ? AND ord BETWEEN ? AND ?
        ORDER BY ord ASC`,
    )
    .all(seed.source_id, seed.source_uri, seed.ord - window, seed.ord + window) as Array<Record<string, unknown>>;
  return rows.map(mapChunk);
}

export function listBySource(db: DB, sourceId: number): DocChunk[] {
  const rows = db
    .prepare('SELECT * FROM doc_chunks WHERE source_id = ? ORDER BY ord ASC')
    .all(sourceId) as Array<Record<string, unknown>>;
  return rows.map(mapChunk);
}

/** The five columns an outline needs — everything except the chunk bodies. */
export interface DocChunkOutlineRow {
  id: number;
  ord: number;
  heading_path: string | null;
  source_uri: string | null;
  token_count: number;
}

/**
 * Outline projection of `listBySource`.
 *
 * `SELECT *` pulls every chunk's full `content`, so building an outline for a
 * large source moved megabytes of text through a synchronous query — and this
 * runs on the Electron main thread via the coder bridge, during agent turns.
 * The outline reads none of it.
 */
export function listOutlineBySource(db: DB, sourceId: number): DocChunkOutlineRow[] {
  return db
    .prepare(
      `SELECT id, ord, heading_path, source_uri, token_count
         FROM doc_chunks
        WHERE source_id = ?
        ORDER BY ord ASC`,
    )
    .all(sourceId) as DocChunkOutlineRow[];
}

export function listByCollection(db: DB, collectionId: number): DocChunk[] {
  const rows = db
    .prepare('SELECT * FROM doc_chunks WHERE collection_id = ? ORDER BY source_id, ord ASC')
    .all(collectionId) as Array<Record<string, unknown>>;
  return rows.map(mapChunk);
}

/**
 * All chunks of ONE section — same source, same `heading_path` AND same
 * `source_uri` (so a same-named heading on another crawled page isn't merged
 * in), in `ord` order. Backs `rag_read_doc({mode:'section'})`: a section the
 * chunker split by size is reassembled into one contiguous read. `IS ?` binds
 * NULL correctly for the (legitimately nullable) heading_path / source_uri.
 */
export function listBySourceHeading(
  db: DB,
  sourceId: number,
  headingPath: string | null,
  sourceUri: string | null,
): DocChunk[] {
  const rows = db
    .prepare(
      `SELECT * FROM doc_chunks
        WHERE source_id = ? AND heading_path IS ? AND source_uri IS ?
        ORDER BY ord ASC`,
    )
    .all(sourceId, headingPath, sourceUri) as Array<Record<string, unknown>>;
  return rows.map(mapChunk);
}

/**
 * Wipe accepted embedding state so `retryEmbeddings` picks every chunk up as
 * pending. Re-upsert uses the same deterministic ids and replaces local rows.
 */
export function clearEmbeddingsForSource(db: DB, sourceId: number): { cleared: number } {
  const result = db
    .prepare(
      `UPDATE doc_chunks
          SET embedding_hash = NULL, embedding_provider_id = NULL, embedding_fingerprint = NULL
        WHERE source_id = ?`,
    )
    .run(sourceId);
  return { cleared: result.changes };
}

export function clearEmbeddingsForCollection(db: DB, collectionId: number): { cleared: number } {
  const result = db.prepare(
    `UPDATE doc_chunks
        SET embedding_hash = NULL, embedding_provider_id = NULL, embedding_fingerprint = NULL
     WHERE collection_id = ?`,
  ).run(collectionId);
  return { cleared: result.changes };
}

export function clearAllEmbeddings(db: DB): { cleared: number } {
  const result = db.prepare(
    `UPDATE doc_chunks
        SET embedding_hash = NULL, embedding_provider_id = NULL, embedding_fingerprint = NULL`,
  ).run();
  return { cleared: result.changes };
}

/**
 * Chunks that still need an embedding. Scoped by `sourceId` (preferred —
 * bounded set) OR `collectionId` (broader) OR neither (all corpus).
 * `sourceId` wins when both are passed. Object-style options so callers
 * don't accidentally pass a sourceId where a collectionId is expected.
 */
export function listMissingEmbedding(
  db: DB,
  opts: { sourceId?: number; collectionId?: number; limit?: number; fingerprint?: string } = {},
): DocChunk[] {
  const where: string[] = [
    opts.fingerprint
      ? '(embedding_hash IS NULL OR embedding_fingerprint IS NULL OR embedding_fingerprint<>@fingerprint)'
      : 'embedding_hash IS NULL',
  ];
  const params: Record<string, unknown> = { limit: opts.limit ?? 500 };
  if (opts.fingerprint) params.fingerprint = opts.fingerprint;
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
          SET embedding_hash = ?, embedding_input_hash = ?, embedding_provider_id = ?,
              embedding_fingerprint = ?, updated_at = datetime('now')
        WHERE id = ?`,
    )
    .run(embeddingHash, embeddingHash, providerId, providerId, chunkId);
}

export function updateEmbeddingState(
  db: DB,
  chunkId: number,
  embeddingHash: string,
  fingerprint: string,
): void {
  db.prepare(
    `UPDATE doc_chunks SET embedding_hash=?, embedding_input_hash=?,
       embedding_provider_id=?, embedding_fingerprint=?, updated_at=datetime('now') WHERE id=?`,
  ).run(embeddingHash, embeddingHash, fingerprint, fingerprint, chunkId);
}

export function listPendingEnrichment(db: DB, sourceId: number, limit = 256): DocChunk[] {
  const rows = db.prepare(
    `SELECT * FROM doc_chunks WHERE source_id=? AND enrichment_fingerprint='pending:llm'
      ORDER BY id LIMIT ?`,
  ).all(sourceId, Math.max(1, limit)) as Array<Record<string, unknown>>;
  return rows.map(mapChunk);
}

export function updateEnrichment(
  db: DB,
  chunkId: number,
  summary: string | null,
  concepts: readonly string[],
  fingerprint: string,
): void {
  db.prepare(
    `UPDATE doc_chunks SET summary=?, concepts=?, enrichment_fingerprint=?,
       updated_at=datetime('now') WHERE id=?`,
  ).run(summary, concepts.length ? JSON.stringify(concepts) : null, fingerprint, chunkId);
}

export function countByCollection(db: DB, collectionId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) as c FROM doc_chunks WHERE collection_id = ?')
    .get(collectionId) as { c: number };
  return row.c;
}

export function countBySource(db: DB, sourceId: number): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM doc_chunks WHERE source_id=?`).get(sourceId) as { c: number };
  return row.c;
}

export function countMissingEmbeddingBySource(db: DB, sourceId: number): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM doc_chunks WHERE source_id=? AND embedding_hash IS NULL`,
  ).get(sourceId) as { c: number };
  return row.c;
}

export function countMissingEmbedding(
  db: DB,
  opts: { sourceId?: number; collectionId?: number; fingerprint?: string } = {},
): number {
  const where = [
    opts.fingerprint
      ? '(embedding_hash IS NULL OR embedding_fingerprint IS NULL OR embedding_fingerprint<>@fingerprint)'
      : 'embedding_hash IS NULL',
  ];
  const params: Record<string, unknown> = {};
  if (opts.fingerprint) params.fingerprint = opts.fingerprint;
  if (opts.sourceId != null) {
    where.push('source_id=@sourceId');
    params.sourceId = opts.sourceId;
  } else if (opts.collectionId != null) {
    where.push('collection_id=@collectionId');
    params.collectionId = opts.collectionId;
  }
  const row = db.prepare(`SELECT COUNT(*) AS c FROM doc_chunks WHERE ${where.join(' AND ')}`).get(params) as { c: number };
  return row.c;
}
