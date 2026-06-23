/**
 * Structural-navigation verbs for the doc-search backend — `readSection`
 * (whole-section reassembly behind `rag_read_doc({mode:'section'})`) and
 * `outline` (heading tree / source list behind `rag_doc_outline`). Split out
 * of search-backend.ts to keep that file under the LOC ceiling; spread into
 * the backend object by `buildDocSearchBackend`.
 */
import type { DocStore } from '@mcp/store/doc-store.js';
import type {
  DocOutline,
  DocOutlineHeading,
  DocSectionRead,
} from '@mcp/code-agent/tools/rag-search-docs.js';

/** Cap on a whole-section read so a pathological section can't blow the context. */
const SECTION_MAX_CHUNKS = 12;
/** Cap on headings returned by an outline (multi-page crawls can be huge). */
const OUTLINE_MAX_HEADINGS = 300;

export function buildDocNavVerbs(docStore: DocStore) {
  return {
    /**
     * Reassemble the WHOLE section the seed chunk belongs to — every chunk the
     * size-splitter produced for the same heading on the same page, in `ord`
     * order. Capped at SECTION_MAX_CHUNKS so a runaway section can't flood the
     * agent's context (the tool reports the cap + the remaining chunk_ids).
     */
    readSection: async (input: { chunk_id: number }): Promise<DocSectionRead | null> => {
      const seed = docStore.getChunk(input.chunk_id);
      if (!seed) return null;
      const collection = docStore.getCollection(seed.collection_id);
      const all = docStore.listChunksBySourceHeading(
        seed.source_id,
        seed.heading_path,
        seed.source_uri,
      );
      // Defensive: a chunk should always match itself; fall back to the seed.
      const list = (all.length > 0 ? all : [seed]).slice(0, SECTION_MAX_CHUNKS);
      return {
        source_id: seed.source_id,
        collection: collection?.name ?? '(unknown)',
        source_uri: seed.source_uri,
        heading_path: seed.heading_path,
        anchor: seed.anchor,
        api_symbol: seed.api_symbol,
        api_signature: seed.api_signature,
        doc_type: seed.doc_type,
        chunks: list.map((c) => ({
          chunk_id: c.id,
          ord: c.ord,
          content: c.content,
          token_count: c.token_count,
        })),
        total_tokens: list.reduce((acc, c) => acc + c.token_count, 0),
      };
    },

    /**
     * Navigation. With `source_id`: the source's heading TREE (consecutive
     * same-heading runs collapsed; each entry carries the first chunk_id so
     * the agent can rag_read_doc it). With `collection`: the collection's
     * SOURCE list (so the agent drills collection → source → headings).
     */
    outline: async (input: { source_id?: number; collection?: string }): Promise<DocOutline | null> => {
      if (input.source_id != null) {
        const source = docStore.getSource(input.source_id);
        if (!source) return null;
        const collection = docStore.getCollection(source.collection_id);
        const chunks = docStore.listChunksBySource(input.source_id); // ord ASC
        const headings: DocOutlineHeading[] = [];
        let cur: DocOutlineHeading | null = null;
        let curKey: string | null = null;
        for (const c of chunks) {
          const key = `${c.source_uri ?? ''} ${c.heading_path ?? ''}`;
          if (!cur || key !== curKey) {
            if (headings.length >= OUTLINE_MAX_HEADINGS) break;
            cur = {
              heading_path: c.heading_path,
              chunk_id: c.id,
              ord: c.ord,
              sections: 0,
              tokens: 0,
              source_uri: c.source_uri,
            };
            headings.push(cur);
            curKey = key;
          }
          cur.sections += 1;
          cur.tokens += c.token_count;
        }
        return {
          kind: 'headings',
          collection: collection?.name ?? '(unknown)',
          source_id: source.id,
          title: source.title,
          source_uri: source.uri,
          doc_type: source.doc_type,
          headings,
        };
      }
      if (input.collection) {
        const col = docStore.getCollectionByName(input.collection);
        if (!col) return null;
        const sources = docStore.listSourcesByCollection(col.id);
        return {
          kind: 'sources',
          collection: col.name,
          sources: sources.map((s) => ({
            source_id: s.id,
            type: s.type,
            doc_type: s.doc_type,
            title: s.title,
            uri: s.uri,
            chunk_count: s.chunk_count,
          })),
        };
      }
      return null;
    },
  };
}
