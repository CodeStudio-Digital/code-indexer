import type { DocStore } from '@mcp/store/doc-store.js';

interface ScopeRequest {
  collection?: string;
  scope?: 'all' | 'project';
  project_id?: number;
}

/** An empty catalog result is authoritative. A failed lookup cannot authorize a wider search. */
export function resolveDocSearchScope(store: Pick<DocStore, 'listCollectionsForProject'>, input: ScopeRequest) {
  if (input.collection) return { scope: 'collection' as const, collections: [] };
  if (input.scope === 'all' || input.project_id == null) return { scope: 'all' as const, collections: [] };
  try {
    const collections = store.listCollectionsForProject(input.project_id);
    return { scope: collections.length ? 'project' as const : 'all' as const, collections };
  } catch (cause) {
    throw new Error('Documentation scope unavailable: could not resolve the project collections.', { cause });
  }
}
