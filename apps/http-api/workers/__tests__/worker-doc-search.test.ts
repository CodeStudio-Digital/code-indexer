import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DocStore } from '../../../../packages/store/src/doc-store.js';
import { buildWorkerDocSearch } from '../worker-doc-search.js';

interface CapturedCall {
  query: string;
  collectionIds?: readonly number[];
  limit?: number;
}

function fakeStore(calls: CapturedCall[], telemetry: Array<Record<string, unknown>>): DocStore {
  return {
    listCollectionsForProject: () => [
      { id: 7, name: 'unity 6000.3' },
      { id: 9, name: 'local project docs' },
    ],
    getCollectionByName: (name: string) => name === 'unity 6000.3'
      ? { id: 7, name }
      : null,
    searchChunksFts: (query: string, opts: { collectionIds?: readonly number[]; limit?: number }) => {
      calls.push({ query, ...opts });
      return [{ chunk_id: 42, rank: -1 }];
    },
    getChunksByIds: () => [{
      id: 42,
      collection_id: 7,
      source_id: 3,
      ord: 0,
      heading_path: 'GlobalObjectId',
      content: 'Use GlobalObjectId.GetGlobalObjectIdSlow for a loaded object.',
      content_hash: 'hash',
      summary: null,
      concepts: [],
      token_count: 12,
      embedding_hash: null,
      embedding_provider_id: null,
      source_uri: 'https://docs.unity3d.com/ScriptReference/GlobalObjectId.html',
      doc_type: 'api_reference',
      anchor: null,
      api_symbol: 'GlobalObjectId.GetGlobalObjectIdSlow',
      api_signature: null,
      created_at: '2026-07-19 00:00:00',
    }],
    getCollection: () => ({ id: 7, name: 'unity 6000.3' }),
    recordDocSearchEvent: (event: Record<string, unknown>) => telemetry.push(event),
  } as unknown as DocStore;
}

describe('worker-local documentation search', () => {
  it('keeps project-scoped agent search on the local FTS path', async () => {
    const calls: CapturedCall[] = [];
    const telemetry: Array<Record<string, unknown>> = [];
    const backend = buildWorkerDocSearch(fakeStore(calls, telemetry));

    const result = await backend.search({
      query: 'GlobalObjectId GetGlobalObjectIdSlow',
      project_id: 11,
      limit: 8,
    });

    expect(calls).toEqual([{
      query: 'GlobalObjectId GetGlobalObjectIdSlow',
      collectionIds: [7, 9],
      limit: 36,
    }]);
    expect(result.results).toHaveLength(1);
    expect(result.diag).toMatchObject({
      mode: 'fts',
      scope: 'project',
      scoped_collections: ['unity 6000.3', 'local project docs'],
      embedding_available: false,
      vector_available: false,
    });
    expect(telemetry[0]).toMatchObject({
      project_id: 11,
      scope: 'project',
      collection_ids: [7, 9],
      mode: 'fts',
      vector_hits: 0,
      result_count: 1,
    });
  });

  it('does not route rag_search_docs back through the Electron host bridge', () => {
    const coder = readFileSync(
      fileURLToPath(new URL('../coder-worker.ts', import.meta.url)),
      'utf8',
    );
    const company = readFileSync(
      fileURLToPath(new URL('../company-worker.ts', import.meta.url)),
      'utf8',
    );

    expect(coder).not.toContain("'docSearch',");
    expect(company).not.toContain("'docSearch',");
  });
});
