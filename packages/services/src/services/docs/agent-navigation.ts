import type { DocStore } from '@mcp/store/doc-store.js';
import type { DocAgentChunk } from '@mcp/store/doc/agent-reads.js';
export interface DocOutlineHeading { chunk_id: number; ord: number; heading_path: string | null; source_uri: string | null; sections: number; tokens: number }
export interface ReadChunk { chunk_id: number; window?: number; char_offset?: number; max_chars?: number }
export interface ReadSection { chunk_id: number; offset?: number; limit?: number }
export interface Outline { source_id?: number; collection?: string; offset?: number; limit?: number }

/** Navigation stays on the caller's connection. Agent workers use their own
 * WAL reader, so the Electron main process never assembles agent documents. */
export function buildDocNavigation(store: DocStore) {
  const run = async <T>(signal: AbortSignal | undefined, read: () => T): Promise<T> => {
    signal?.throwIfAborted();
    const value = store.withBusyTimeout(50, read);
    signal?.throwIfAborted(); return value;
  };
  const neighbor = (c: DocAgentChunk) => ({ chunk_id: c.id, ord: c.ord, heading_path: c.heading_path,
    content: c.content, content_length: c.content_length, token_count: c.token_count, source_uri: c.source_uri });
  return {
    readChunk: (input: ReadChunk, signal?: AbortSignal) => run(signal, () => {
      const reads = store.agentReads(), seed = reads.chunk(input.chunk_id, input.char_offset, input.max_chars);
      if (!seed) return null;
      const neighbors = reads.neighbors(seed, input.window ?? 1);
      return { chunk: { chunk_id: seed.id, collection: store.getCollection(seed.collection_id)?.name ?? '(unknown)',
        source_id: seed.source_id, source_uri: seed.source_uri, heading_path: seed.heading_path, anchor: seed.anchor,
        api_symbol: seed.api_symbol, api_signature: seed.api_signature, content: seed.content, content_length: seed.content_length,
        char_offset: seed.char_offset, next_char_offset: seed.next_char_offset, token_count: seed.token_count,
        summary: seed.summary, concepts: seed.concepts },
      prev: neighbors.filter(c => c.ord < seed.ord).map(neighbor), next: neighbors.filter(c => c.ord > seed.ord).map(neighbor) };
    }),
    readSection: (input: ReadSection, signal?: AbortSignal) => run(signal, () => {
      const reads = store.agentReads(), seed = reads.chunk(input.chunk_id, 0, 1);
      if (!seed) return null;
      const page = reads.section(seed, input.offset, input.limit);
      return { source_id: seed.source_id, collection: store.getCollection(seed.collection_id)?.name ?? '(unknown)',
        source_uri: seed.source_uri, heading_path: seed.heading_path, anchor: seed.anchor, api_symbol: seed.api_symbol,
        api_signature: seed.api_signature, doc_type: seed.doc_type, offset: page.offset, next_offset: page.next_offset,
        chunks: page.items.map(c => ({ chunk_id: c.id, ord: c.ord, content: c.content, token_count: c.token_count,
          content_length: c.content_length, next_char_offset: c.next_char_offset })),
        total_tokens: page.items.reduce((sum, c) => sum + c.token_count, 0) };
    }),
    outline: (input: Outline, signal?: AbortSignal) => run(signal, () => {
      const reads = store.agentReads();
      if (input.source_id != null) {
        const source = store.getSource(input.source_id); if (!source) return null;
        const page = reads.outline(source.id, input.offset, input.limit);
        const headings: DocOutlineHeading[] = []; let key: string | undefined, current: DocOutlineHeading | undefined;
        for (const c of page.items) {
          const next = JSON.stringify([c.source_uri, c.heading_path]);
          if (!current || next !== key) {
            current = { chunk_id: c.id, ord: c.ord, heading_path: c.heading_path, source_uri: c.source_uri, sections: 0, tokens: 0 };
            headings.push(current); key = next;
          }
          current.sections++; current.tokens += c.token_count;
        }
        return { kind: 'headings' as const, collection: store.getCollection(source.collection_id)?.name ?? '(unknown)',
          source_id: source.id, title: source.title, source_uri: source.uri, doc_type: source.doc_type,
          headings, offset: page.offset, next_offset: page.next_offset };
      }
      if (!input.collection) return null;
      const collection = store.getCollectionByName(input.collection); if (!collection) return null;
      const page = reads.sources(collection.id, input.offset, input.limit);
      return { kind: 'sources' as const, collection: collection.name, sources: page.items, offset: page.offset, next_offset: page.next_offset };
    }),
  };
}
