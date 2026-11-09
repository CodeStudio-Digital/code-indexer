import type { DocStore } from '@mcp/store/doc-store.js';
import { docNamespace } from '@mcp/shared/vector-namespace.js';

let corpus: DocStore | null = null;
export function setCompanyDocCorpus(store: DocStore | null): void { corpus = store; }

/** Remove addressable stale chunks synchronously. Local orphan vector payloads
 * cannot be rehydrated once their chunk rows and semantic mappings are gone. */
export function invalidateCompanyDoc(scope: string, service: string, path: string, store = corpus): 'not_indexed' | 'stale' {
  if (!store) return 'not_indexed';
  const collection = store.getCollectionByName(`company-docs:${scope}`);
  if (!collection) return 'not_indexed';
  const uri = `companydoc://${scope}/${service}/${path}`;
  const source = store.listSourcesByCollection(collection.id).find((entry) => entry.uri === uri);
  if (!source) return 'not_indexed';
  const refs = store.listVectorIdsForSource(source.id);
  store.replaceChunksForSource(source.id, []);
  store.deleteSemanticItemsByVectorIds(docNamespace(collection.id), refs.map((ref) => ref.vector_id));
  store.updateSourceStatus(source.id, 'error', 'Company document changed or was deleted; reindex required');
  store.updateSourceStats(source.id, { chunk_count: 0, content_hash: null });
  return 'stale';
}
