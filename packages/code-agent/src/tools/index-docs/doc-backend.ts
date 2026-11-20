import { DocStore } from '@mcp/store/doc-store.js';
import type { DocToolContext } from './doc-tool.js';
import { buildDocNavigation } from '@mcp/services/services/docs/agent-navigation.js';
import { DocHybridSearch } from '@mcp/services/services/docs/search.js';
import { resolveDocSearchScope } from '@mcp/services/services/docs/search-scope.js';
import { getGlobalDocSearch, type DocSearchBackend } from '@mcp/code-agent/tools/rag-search-docs.js';

const backends = new WeakMap<object, DocSearchBackend>();

/** Stdio owns a WAL reader of the same corpus. No provider, embedding model or
 * telemetry writer is needed to navigate/search it. HTTP retains its backend. */
export function documentationBackend(ctx: DocToolContext): DocSearchBackend {
  const global = getGlobalDocSearch();
  if (global) return global;
  const connection = ctx.db.raw();
  const cached = backends.get(connection); if (cached) return cached;
  const store = new DocStore(connection);
  const backend: DocSearchBackend = {
    ...buildDocNavigation(store),
    search: async (input, signal) => {
      signal?.throwIfAborted();
      const { scope, collections: scoped } = resolveDocSearchScope(store, input);
      // Keep body hydration bounded, including a corpus containing huge chunks.
      // The map belongs to this request so concurrent reads cannot cross results.
      const lengths = new Map<number, { source: number; retained: number }>();
      const lexical = new DocHybridSearch({
        getCollectionByName: store.getCollectionByName.bind(store),
        getCollection: store.getCollection.bind(store),
        searchChunksFts: (query: string, options: Parameters<DocStore['searchChunksFts']>[1]) => store.withBusyTimeout(50, () => store.searchChunksFts(query, options)),
        getChunksByIds: (ids: readonly number[]) => store.withBusyTimeout(50, () => ids.flatMap(id => {
          signal?.throwIfAborted();
          const chunk = store.agentReads().chunk(id, 0, 480); if (!chunk) return [];
          // buildSnippet uses UTF-16's 480-unit preview; report code points to
          // match SQLite's source length and navigation char_offset precisely.
          let end = Math.min(480, chunk.content.length);
          const last = chunk.content.charCodeAt(end - 1), next = chunk.content.charCodeAt(end);
          if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
          lengths.set(id, { source: chunk.content_length, retained: Array.from(chunk.content.slice(0, end)).length });
          return [chunk];
        })),
      } as unknown as DocStore, null, null);
      const result = await lexical.search({ query: input.query, collection: input.collection, limit: input.limit,
        ...(scoped.length ? { collection_ids: scoped.map(c => c.id) } : {}), mode: 'fts', signal });
      signal?.throwIfAborted();
      for (const item of result.results) {
        const length = lengths.get(item.chunk_id)!;
        item.snippet_source_chars = length.source; item.snippet_retained_chars = length.retained;
        const truncated = length.retained < length.source;
        if (truncated && !item.snippet_truncated) item.snippet += '…';
        item.snippet_truncated = truncated;
      }
      result.diag.scope = scope;
      if (scoped.length) result.diag.scoped_collections = scoped.map(c => c.name);
      return result;
    },
  };
  backends.set(connection, backend); return backend;
}
