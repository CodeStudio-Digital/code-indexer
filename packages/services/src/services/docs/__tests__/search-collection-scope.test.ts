/**
 * Coverage for collection scoping in DocHybridSearch (migration 134):
 *   - `collection_ids` flows into the FTS query (project-linked subset);
 *   - an explicit `collection` NAME wins over `collection_ids`;
 *   - empty `collection_ids` means "no filter" (global), matching the
 *     backend contract where "project has no links" omits the field.
 *
 * FTS-only path (embeddingService=vectorStore=null) keeps the fakes small.
 */
import { describe, it, expect } from 'vitest';
import { DocHybridSearch } from '../search.js';
import type { DocStore } from '@mcp/store/doc-store.js';

interface CapturedFtsCall {
  query: string;
  opts: { collectionIds?: readonly number[]; limit?: number };
}

function fakeDocStore(captured: CapturedFtsCall[]): DocStore {
  return {
    getCollectionByName: (name: string) => (name === 'react-docs' ? { id: 7, name } : null),
    searchChunksFts: (query: string, opts: CapturedFtsCall['opts']) => {
      captured.push({ query, opts });
      return [{ chunk_id: 1, rank: -1 }];
    },
    getChunksByIds: (ids: number[]) =>
      ids.map((id) => ({
        id,
        collection_id: 7,
        source_id: 1,
        source_uri: null,
        heading_path: 'A',
        content: 'alpha',
        summary: null,
        concepts: [],
      })),
    getCollection: () => ({ name: 'react-docs' }),
  } as unknown as DocStore;
}

describe('DocHybridSearch collection scoping', () => {
  it('passes collection_ids through to the FTS layer', async () => {
    const captured: CapturedFtsCall[] = [];
    const search = new DocHybridSearch(fakeDocStore(captured), null, null);
    const { results } = await search.search({ query: 'q', collection_ids: [7, 9] });
    expect(results).toHaveLength(1);
    expect(captured[0]!.opts.collectionIds).toEqual([7, 9]);
  });

  it('explicit collection name wins over collection_ids', async () => {
    const captured: CapturedFtsCall[] = [];
    const search = new DocHybridSearch(fakeDocStore(captured), null, null);
    await search.search({ query: 'q', collection: 'react-docs', collection_ids: [99] });
    expect(captured[0]!.opts.collectionIds).toEqual([7]);
  });

  it('treats an empty collection_ids array as global (no filter)', async () => {
    const captured: CapturedFtsCall[] = [];
    const search = new DocHybridSearch(fakeDocStore(captured), null, null);
    await search.search({ query: 'q', collection_ids: [] });
    expect(captured[0]!.opts.collectionIds).toBeUndefined();
  });

  it('unknown collection name returns empty without hitting FTS', async () => {
    const captured: CapturedFtsCall[] = [];
    const search = new DocHybridSearch(fakeDocStore(captured), null, null);
    const { results } = await search.search({ query: 'q', collection: 'nope', collection_ids: [7] });
    expect(results).toHaveLength(0);
    expect(captured).toHaveLength(0);
  });
});
