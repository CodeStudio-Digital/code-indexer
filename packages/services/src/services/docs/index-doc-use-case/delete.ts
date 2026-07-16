import type { DocStore } from '@mcp/store/doc-store.js';
import type { VectorStore } from '@mcp/store/vectors.js';

export interface DeleteResult { vectors_deleted: number; }

type VectorRef = { vector_id: string; item_key?: string; provider: string };

/**
 * Remove deterministic documentation ids from the local semantic namespace.
 * Failures do not roll back the corpus mutation: stale local hits are already
 * rejected during rehydration because their `doc_chunks` rows no longer exist.
 */
export async function deleteLocalVectors(
  docStore: DocStore,
  vectorStore: VectorStore | null,
  refs: readonly VectorRef[],
  namespace: string | undefined,
): Promise<number> {
  const ids = [...new Set(refs.map((ref) => ref.vector_id))];
  const itemKeys = [...new Set(refs.map((ref) => ref.item_key ?? ref.vector_id))];
  if (!namespace || ids.length === 0) return 0;
  if (!vectorStore) {
    docStore.deleteSemanticItemsByItemKeys(namespace, itemKeys);
    return 0;
  }
  try {
    const removed = vectorStore.deleteByItemKeys
      ? await vectorStore.deleteByItemKeys(itemKeys, namespace)
      : await vectorStore.deleteByIds(ids, namespace);
    // The router removes active/building rows. Purge any retired-generation
    // ledger residue too so semantic_items remains an exact corpus inventory.
    docStore.deleteSemanticItemsByItemKeys(namespace, itemKeys);
    if (removed < ids.length) {
      console.warn(
        `[doc-indexer] local vector cleanup partial namespace=${namespace}: removed ${removed}/${ids.length}`,
      );
    }
    return removed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[doc-indexer] local vector cleanup skipped namespace=${namespace} ids=${ids.length}: ${message}`,
    );
    return 0;
  }
}

/**
 * Collection deletion owns the whole `docs:c<ID>` namespace. The local
 * router removes active and building generations before the corpus row is
 * allowed to cascade, so a deleted collection cannot leave an addressable
 * semantic namespace behind.
 */
export async function deleteCollectionAndCleanup(
  docStore: DocStore,
  vectorStore: VectorStore | null,
  collectionId: number,
  runSqliteDelete: () => void,
  namespace: string,
): Promise<DeleteResult> {
  const refs = docStore.listVectorIdsForCollection(collectionId);
  let removed = 0;
  if (vectorStore?.deleteNamespace) {
    // Deliberately strict: if the physical/control-plane cleanup fails, keep
    // the collection row so the operation is retryable with its ID intact.
    removed = await vectorStore.deleteNamespace(namespace);
  } else {
    removed = await deleteLocalVectors(docStore, vectorStore, refs, namespace);
  }
  runSqliteDelete();
  return { vectors_deleted: removed };
}

/**
 * Shared body of source/collection deletion. Vector ids are derived from
 * embedded chunk ids before the SQLite cascade and then removed only from the
 * collection's local `docs:c<ID>` namespace.
 */
export async function deleteAndCleanup(
  docStore: DocStore,
  vectorStore: VectorStore | null,
  collectVectorRefs: () => VectorRef[],
  runSqliteDelete: () => void,
  namespace?: string,
): Promise<DeleteResult> {
  const refs = collectVectorRefs();
  runSqliteDelete();
  const removed = await deleteLocalVectors(docStore, vectorStore, refs, namespace);
  return { vectors_deleted: removed };
}
