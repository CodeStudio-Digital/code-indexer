import type { Database as DB } from 'better-sqlite3';
import type { DocVectorRef } from './types.js';

// ─── Vector mapping ──────────────────────────────────────────────

/**
 * Collect vectors recorded by the semantic control-plane ledger. Chunk-level
 * embedding columns are a compatibility mirror only; they never decide which
 * local vectors exist or need cleanup.
 */
export function listForSource(db: DB, sourceId: number): DocVectorRef[] {
  return db
    .prepare(
      `SELECT DISTINCT COALESCE(si.vector_id, si.item_key) AS vector_id,
              si.item_key,
              'semantic:g' || si.generation_id AS provider
         FROM semantic_items si
         JOIN doc_chunks c ON si.item_key = 'doc_chunk:' || c.id
        WHERE c.source_id = ?
          AND si.namespace = 'docs:c' || c.collection_id`,
    )
    .all(sourceId) as DocVectorRef[];
}

/** Same as `listForSource` but across all sources of a collection. */
export function listForCollection(db: DB, collectionId: number): DocVectorRef[] {
  return db
    .prepare(
      `SELECT DISTINCT COALESCE(si.vector_id, si.item_key) AS vector_id,
              si.item_key,
              'semantic:g' || si.generation_id AS provider
         FROM semantic_items si
         JOIN doc_chunks c ON si.item_key = 'doc_chunk:' || c.id
        WHERE c.collection_id = ?
          AND si.namespace = 'docs:c' || c.collection_id`,
    )
    .all(collectionId) as DocVectorRef[];
}

export function countMappings(db: DB): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS c
       FROM semantic_items
      WHERE namespace LIKE 'docs:c%' AND status = 'indexed' AND vector_id IS NOT NULL`,
  ).get() as { c: number };
  return row.c;
}

/** Active-generation coverage for search diagnostics. */
export function countIndexedForCollection(db: DB, collectionId: number): number {
  const row = db.prepare(
    `SELECT COUNT(DISTINCT c.id) AS c
       FROM doc_chunks c
       JOIN semantic_namespace_generations ng
         ON ng.namespace = 'docs:c' || c.collection_id
       JOIN semantic_items si
         ON si.namespace = ng.namespace
        AND si.generation_id = ng.active_generation_id
        AND si.item_key = 'doc_chunk:' || c.id
        AND si.status = 'indexed'
        AND si.vector_id IS NOT NULL
      WHERE c.collection_id = ?`,
  ).get(collectionId) as { c: number };
  return row.c;
}

/** Remove documentation items from every generation of one namespace. */
export function deleteSemanticItemsByVectorIds(
  db: DB,
  namespace: string,
  vectorIds: readonly string[],
): number {
  if (vectorIds.length === 0) return 0;
  const stmt = db.prepare(
    `DELETE FROM semantic_items WHERE namespace = ? AND vector_id = ?`,
  );
  let deleted = 0;
  db.transaction((ids: readonly string[]) => {
    for (const id of ids) deleted += stmt.run(namespace, id).changes;
  })(vectorIds);
  return deleted;
}

export function deleteSemanticItemsByItemKeys(
  db: DB,
  namespace: string,
  itemKeys: readonly string[],
): number {
  if (itemKeys.length === 0) return 0;
  const stmt = db.prepare(
    `DELETE FROM semantic_items WHERE namespace = ? AND item_key = ?`,
  );
  let deleted = 0;
  db.transaction((keys: readonly string[]) => {
    for (const key of new Set(keys)) deleted += stmt.run(namespace, key).changes;
  })(itemKeys);
  return deleted;
}
