import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { DocStore } from '@mcp/store/doc-store.js';
import { createDocChunksFtsIfReady } from '@mcp/store/db/schema/fts.js';

const mocks = vi.hoisted(() => ({
  embed: vi.fn(),
  enrich: vi.fn(),
}));

vi.mock('../index-doc-use-case/embed-upsert.js', () => ({
  embedAndUpsert: mocks.embed,
}));
vi.mock('../enricher.js', () => ({
  enrichChunks: mocks.enrich,
}));

import { runIngest } from '../index-doc-use-case/run-ingest.js';

function harness(events: string[]) {
  const statuses: string[] = [];
  const docStore = {
    tryAcquireSource: vi.fn(() => true),
    updateCollectionStatus: vi.fn(),
    updateSourceStatus: vi.fn((_id: number, status: string) => statuses.push(status)),
    reconcileChunksForSource: vi.fn(() => ({ ids: [101], removedVectors: [] })),
    updateChunkEnrichment: vi.fn(),
    updateSourceStats: vi.fn(),
    refreshCollectionCounts: vi.fn(),
  };
  const deps = {
    docStore,
    embeddingService: {},
    vectorStore: {},
    pipelineProviderResolver: {},
  };
  const collection = { id: 7, name: 'Docs' };
  const source = { id: 9, type: 'url', uri: 'https://example.test', doc_type: 'guide' };
  const page = {
    candidateId: 'page:1',
    uri: 'https://example.test/start',
    title: 'Start',
    markdown: '# Start\n\n' + (
      'This guide explains installation, configuration, runtime options, validation, and troubleshooting for the package. '
    ).repeat(12),
    source: 'url',
    score: 1,
  };
  mocks.embed.mockImplementation(async () => {
    events.push('embed');
    return 12;
  });
  return { deps, collection, source, page, docStore, statuses };
}

beforeEach(() => {
  mocks.embed.mockReset();
  mocks.enrich.mockReset();
});

describe('documentation ingestion dependency order', () => {
  it('makes embeddings searchable before optional LLM enrichment', async () => {
    const events: string[] = [];
    const h = harness(events);
    mocks.enrich.mockImplementation(async () => {
      events.push('enrich');
      return [{ chunk_index: 0, summary: 'Install and configure.', concepts: ['installation'] }];
    });

    await runIngest(
      h.deps as never,
      h.collection as never,
      h.source as never,
      async () => [h.page as never],
      undefined,
      { skipGate: true },
    );

    expect(events).toEqual(['embed', 'enrich']);
    expect(h.docStore.updateChunkEnrichment)
      .toHaveBeenCalledWith(101, 'Install and configure.', ['installation'], 'llm:doc-ingest:v1');
    expect(h.statuses.at(-1)).toBe('done');
  });

  it('completes after an enrichment failure because embeddings already landed', async () => {
    const events: string[] = [];
    const h = harness(events);
    mocks.enrich.mockImplementation(async () => {
      events.push('enrich');
      throw new Error('scorer offline');
    });

    await expect(runIngest(
      h.deps as never,
      h.collection as never,
      h.source as never,
      async () => [h.page as never],
      undefined,
      { skipGate: true },
    )).resolves.toMatchObject({ source_id: 9, chunks_indexed: 1 });

    expect(events).toEqual(['embed', 'enrich']);
    expect(h.docStore.updateChunkEnrichment).not.toHaveBeenCalled();
    expect(h.statuses.at(-1)).toBe('done');
  });

  it('keeps the persisted corpus and FTS searchable when embedding fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-doc-fts-fallback-'));
    const db = new CodeIndexDB(join(dir, 'test.db'));
    try {
      createDocChunksFtsIfReady(db.raw());
      const docStore = new DocStore(db.raw());
      const collection = docStore.createCollection({ name: 'Fallback docs' });
      const source = docStore.createSource({
        collection_id: collection.id,
        type: 'url',
        uri: 'https://fallback.example',
      });
      mocks.embed.mockRejectedValueOnce(new Error('embedding provider offline'));
      mocks.enrich.mockResolvedValueOnce([]);

      await expect(runIngest(
        {
          docStore,
          embeddingService: {},
          vectorStore: {},
          pipelineProviderResolver: {},
        } as never,
        collection,
        source,
        async () => [harness([]).page as never],
        undefined,
        { skipGate: true },
      )).resolves.toMatchObject({ source_id: source.id, chunks_indexed: 1 });

      expect(docStore.getSource(source.id)?.status).toBe('done');
      expect(docStore.getCollection(collection.id)?.status).toBe('idle');
      expect(docStore.searchChunksFts('configuration', { collectionId: collection.id }))
        .toHaveLength(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
