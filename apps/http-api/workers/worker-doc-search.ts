/**
 * Worker-local documentation search used by agent sessions.
 *
 * The full semantic backend owns provider-backed embedding/reranking services
 * in the Electron host. A slow provider call there blocks the host's event
 * loop for the entire RPC and makes the UI unresponsive even though the agent
 * worker is healthy. Agent searches therefore use the corpus' local FTS index
 * in their existing worker DB connection. Structural reads remain host RPCs;
 * they are short SQLite lookups and do not cross the slow semantic boundary.
 */
import { createHash } from 'node:crypto';
import type { DocSearchBackend } from '../../../packages/code-agent/src/tools/doc-search-types.js';
import { DocHybridSearch } from '../../../packages/services/src/services/docs/search.js';
import type { DocSearchInput } from '../../../packages/services/src/services/docs/search.js';
import type { DocStore } from '../../../packages/store/src/doc-store.js';

type WorkerDocSearchBackend = Pick<DocSearchBackend, 'search'>;

export function buildWorkerDocSearch(docStore: DocStore): WorkerDocSearchBackend {
  // Expose only the reads the FTS path needs. Passing the full DocStore would
  // make DocHybridSearch calculate vector coverage after every lexical query;
  // that active-generation COUNT is irrelevant here and expensive on a large
  // corpus. The original store remains available below for scope + telemetry.
  const lexicalStore = {
    getCollectionByName: docStore.getCollectionByName.bind(docStore),
    searchChunksFts: docStore.searchChunksFts.bind(docStore),
    getChunksByIds: docStore.getChunksByIds.bind(docStore),
    getCollection: docStore.getCollection.bind(docStore),
  } as unknown as DocStore;
  const lexicalSearch = new DocHybridSearch(lexicalStore, null, null);

  return {
    search: async (input) => {
      const { scope, project_id, ...rest } = input;
      let scoped: Array<{ id: number; name: string }> = [];

      if (!input.collection && scope !== 'all' && project_id != null) {
        try {
          scoped = docStore.listCollectionsForProject(project_id);
        } catch {
          // Pre-migration databases retain the existing global-search fallback.
          scoped = [];
        }
      }

      const forward: DocSearchInput = {
        ...rest,
        mode: 'fts',
        enhancements: { rewrite: false, rerank: false },
      };
      if (scoped.length > 0) forward.collection_ids = scoped.map((collection) => collection.id);

      const started = Date.now();
      const out = await lexicalSearch.search(forward);
      out.diag.scope = scoped.length > 0 ? 'project' : 'all';
      if (scoped.length > 0) out.diag.scoped_collections = scoped.map((collection) => collection.name);

      const explicitCollectionId = input.collection
        ? docStore.getCollectionByName(input.collection)?.id
        : undefined;
      try {
        docStore.recordDocSearchEvent({
          project_id,
          query_hash: createHash('sha256').update(input.query).digest('hex'),
          scope: out.diag.scope,
          collection_ids: explicitCollectionId != null
            ? [explicitCollectionId]
            : scoped.map((collection) => collection.id),
          mode: out.diag.mode,
          duration_ms: Date.now() - started,
          fts_hits: out.diag.fts_hits,
          vector_hits: out.diag.vector_hits,
          stale_vector_hits: out.diag.stale_vector_hits,
          vector_coverage: out.diag.vector_coverage,
          top_relevance: out.diag.top_relevance,
          no_good_match: out.diag.no_good_match,
          result_count: out.results.length,
        });
      } catch {
        // Retrieval must not fail when telemetry tables are unavailable.
      }

      return out;
    },
  };
}
