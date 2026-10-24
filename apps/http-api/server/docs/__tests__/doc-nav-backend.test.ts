import { describe, expect, it } from 'vitest';
import type { DocChunk, DocStore } from '@mcp/store/doc-store.js';
import { buildDocNavVerbs } from '../doc-nav-backend.js';

function makeChunk(args: {
  id: number;
  sourceId: number;
  ord: number;
  headingPath: string;
  tokenCount?: number;
}): DocChunk {
  return {
    id: args.id,
    collection_id: 7,
    source_id: args.sourceId,
    ord: args.ord,
    heading_path: args.headingPath,
    content: `content-${args.id}`,
    content_hash: `hash-${args.id}`,
    summary: null,
    concepts: [],
    token_count: args.tokenCount ?? 1,
    embedding_hash: null,
    embedding_provider_id: null,
    source_uri: `https://docs.example/source-${args.sourceId}`,
    doc_type: null,
    anchor: null,
    api_symbol: null,
    api_signature: null,
    created_at: '2026-07-16T00:00:00.000Z',
  };
}

describe('buildDocNavVerbs materialized result preservation', () => {
  it('preserves sections beyond 12 chunks and outlines beyond 300 headings', async () => {
    const sectionChunks = Array.from({ length: 13 }, (_, index) => makeChunk({
      id: index + 1,
      sourceId: 11,
      ord: index,
      headingPath: 'Guide > Large section',
      tokenCount: index + 1,
    }));
    const outlineChunks = Array.from({ length: 301 }, (_, index) => makeChunk({
      id: 1_000 + index,
      sourceId: 22,
      ord: index,
      headingPath: `Heading ${index + 1}`,
    }));
    const docStore = {
      withBusyTimeout: (_ms: number, fn: () => unknown) => fn(),
      agentReads: () => ({
        chunk: (id: number) => id === sectionChunks[0].id ? sectionChunks[0] : null,
        section: () => ({ items: sectionChunks, offset: 0 }),
        outline: () => ({ items: outlineChunks.map(c => ({ id: c.id, ord: c.ord, heading_path: c.heading_path, source_uri: c.source_uri, token_count: c.token_count })), offset: 0 }),
      }),
      getChunk: (id: number) => (id === sectionChunks[0].id ? sectionChunks[0] : null),
      getCollection: () => ({ name: 'Regression docs' }),
      listChunksBySourceHeading: () => sectionChunks,
      getSource: (id: number) => (id === 22
        ? {
            id,
            collection_id: 7,
            title: 'Large outline',
            uri: 'https://docs.example/source-22',
            doc_type: 'mixed',
          }
        : null),
      // The outline reads five columns, never the chunk bodies — full rows here
      // would hide an accidental regression back to the `SELECT *` variant.
      listChunkOutlineBySource: (sourceId: number) => (sourceId === 22
        ? outlineChunks.map((c) => ({
            id: c.id,
            ord: c.ord,
            heading_path: c.heading_path,
            source_uri: c.source_uri,
            token_count: c.token_count,
          }))
        : []),
      getCollectionByName: () => null,
      listSourcesByCollection: () => [],
    } as unknown as DocStore;
    const verbs = buildDocNavVerbs(docStore);

    const section = await verbs.readSection({ chunk_id: sectionChunks[0].id });
    expect(section?.chunks.map((chunk) => chunk.chunk_id)).toEqual(
      sectionChunks.map((chunk) => chunk.id),
    );
    expect(section?.total_tokens).toBe(91);

    const outline = await verbs.outline({ source_id: 22 });
    expect(outline?.headings?.map((heading) => heading.heading_path)).toEqual(
      outlineChunks.map((chunk) => chunk.heading_path),
    );
  });
});
