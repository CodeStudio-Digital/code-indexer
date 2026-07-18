import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { DocStore } from '@mcp/store/doc-store.js';
import { SemanticStore } from '@mcp/store/semantic-store.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { VectorMatch, VectorRecord } from '@mcp/shared/types.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import type { PipelineProviderResolver } from '../../../pipelines/index.js';
import { IndexDocumentationUseCase } from '../index-doc-use-case.js';

function unityPage(symbol: string, description: string): string {
  return `<html><head><title>${symbol}</title><link rel="canonical" href="https://docs.unity3d.com/6000.3/Documentation/ScriptReference/${symbol}.html"></head>
    <body><div id="content-wrap"><div class="content"><h1>${symbol}</h1>
    <h2>Declaration</h2><pre><code>public void ${symbol.split('.').at(-1)}(Vector3 value);</code></pre>
    <h2>Description</h2><p>${description} ${'This technical reference explains the API behavior, parameters, constraints, examples, and runtime semantics. '.repeat(7)}</p>
    <div class="suggest">Was this page helpful?</div></div></div></body></html>`;
}

function createEmbedMock() {
  return vi.fn(async (texts: string[]) => ({
    vectors: texts.map(() => [0.1, 0.2, 0.3]),
    tokens: texts.length * 10,
  }));
}

describe('incremental folder ingestion', () => {
  let dir: string;
  let docsDir: string;
  let db: CodeIndexDB;
  let store: DocStore;
  let indexer: IndexDocumentationUseCase;
  let embed: ReturnType<typeof createEmbedMock>;
  let deleteByIds: ReturnType<typeof vi.fn<(ids: string[], namespace?: string) => Promise<number>>>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-doc-incremental-'));
    docsDir = join(dir, 'ScriptReference');
    mkdirSync(docsDir);
    db = new CodeIndexDB(join(dir, 'index.db'));
    store = new DocStore(db.raw());
    embed = createEmbedMock();
    const embeddingService: EmbeddingService = {
      embed,
      embedQuery: async () => ({ vector: [0.1, 0.2, 0.3], tokens: 1 }),
      fingerprint: () => 'fake:bge-m3:v1',
      maxConcurrency: () => 2,
    };
    const semanticStore = new SemanticStore(db.raw());
    const generation = semanticStore.createGeneration({
      purpose: 'docs',
      fingerprint: 'fake:bge-m3:v1',
      embedding_target: { kind: 'disabled' },
      dimension: 3,
    });
    deleteByIds = vi.fn<(ids: string[], namespace?: string) => Promise<number>>().mockResolvedValue(0);
    const vectorStore: VectorStore = {
      upsert: vi.fn(async (records: VectorRecord[], namespace?: string) => {
        if (!namespace) throw new Error('namespace required');
        for (const record of records) {
          semanticStore.upsertItem({
            generation_id: generation.id,
            namespace,
            item_key: record.id,
            source_hash: String(record.metadata?.embedding_hash ?? ''),
            vector_id: record.id,
            chunk_index: 0,
            status: 'indexed',
            attempts: 1,
            error: null,
          });
        }
        return records.length;
      }),
      search: vi.fn<() => Promise<VectorMatch[]>>().mockResolvedValue([]),
      deleteByIds,
      isAvailable: vi.fn(async () => true),
    };
    const resolver = { resolveOrNull: vi.fn(async () => null) } as unknown as PipelineProviderResolver;
    indexer = new IndexDocumentationUseCase({ docStore: store, embeddingService, vectorStore, pipelineProviderResolver: resolver });
  });

  afterEach(async () => {
    // Let the deliberately detached enrichment task observe an empty queue
    // before closing the database handle.
    await new Promise((resolve) => setImmediate(resolve));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('preserves ids, skips unchanged files, re-embeds changes and locally removes stale vectors', async () => {
    const a = join(docsDir, 'Rigidbody.AddForce.html');
    const b = join(docsDir, 'Transform.Translate.html');
    writeFileSync(a, unityPage('Rigidbody.AddForce', 'Adds force to a rigidbody.'));
    writeFileSync(b, unityPage('Transform.Translate', 'Moves a transform.'));
    const collection = store.createCollection({ name: 'unity-6000.3' });

    const first = await indexer.indexFolder({
      collectionId: collection.id,
      rootPath: docsDir,
      enrichmentMode: 'selective',
      folder: { bypass_relevance_gate: true, max_files: 10 },
    });
    const source = store.listSourcesByCollection(collection.id)[0]!;
    const initial = store.listChunksBySource(source.id);
    const idsByKey = new Map(initial.map((chunk) => [chunk.stable_key, chunk.id]));
    const callsAfterFirst = embed.mock.calls.length;
    expect(first.searchable).toBe(true);
    expect(initial.length).toBeGreaterThan(0);
    expect(initial.every((chunk) => chunk.enrichment_fingerprint === 'deterministic:v1')).toBe(true);

    const second = await indexer.indexFolder({ collectionId: collection.id, rootPath: docsDir });
    const afterNoop = store.listChunksBySource(source.id);
    expect(second.state).toBe('completed');
    expect(embed).toHaveBeenCalledTimes(callsAfterFirst);
    expect(afterNoop.map((chunk) => chunk.id)).toEqual(initial.map((chunk) => chunk.id));
    const noopRun = store.listIngestRuns(source.id, 1)[0]!;
    expect(noopRun.unchanged_items).toBe(2);
    expect(noopRun.changed_items).toBe(0);

    writeFileSync(a, unityPage('Rigidbody.AddForce', 'Adds a configurable force and wakes the rigidbody.'));
    await indexer.indexFolder({ collectionId: collection.id, rootPath: docsDir });
    const afterChange = store.listChunksBySource(source.id);
    for (const chunk of afterChange) {
      expect(chunk.id).toBe(idsByKey.get(chunk.stable_key));
    }
    expect(embed.mock.calls.length).toBeGreaterThan(callsAfterFirst);

    deleteByIds.mockClear();
    unlinkSync(b);
    await indexer.indexFolder({ collectionId: collection.id, rootPath: docsDir });
    expect(store.listChunksBySource(source.id).every((chunk) => !chunk.source_uri?.includes('Transform.Translate'))).toBe(true);
    expect(deleteByIds).toHaveBeenCalled();
    expect(deleteByIds.mock.calls.every((call) => call[1] === `docs:c${collection.id}`)).toBe(true);
  });

  it('publishes a searchable paused_limit run and resumes without repeating confirmed items', async () => {
    writeFileSync(join(docsDir, 'A.First.html'), unityPage('A.First', 'First API page.'));
    writeFileSync(join(docsDir, 'B.Second.html'), unityPage('B.Second', 'Second API page.'));
    const collection = store.createCollection({ name: 'unity-limited' });

    const paused = await indexer.indexFolder({
      collectionId: collection.id,
      rootPath: docsDir,
      folder: { bypass_relevance_gate: true, max_files: 1 },
    });
    const source = store.listSourcesByCollection(collection.id)[0]!;
    expect(paused.state).toBe('paused_limit');
    expect(paused.searchable).toBe(true);
    expect(store.countChunksBySource(source.id)).toBeGreaterThan(0);

    const resumed = await indexer.indexFolder({
      collectionId: collection.id,
      rootPath: docsDir,
      folder: { bypass_relevance_gate: true, max_files: 10 },
    });
    const lastRun = store.listIngestRuns(source.id, 1)[0]!;
    expect(resumed.state).toBe('completed');
    expect(lastRun.unchanged_items).toBe(1);
    expect(lastRun.changed_items).toBe(1);
  });

  it('pauses cooperatively and resumes the same run id with worker checkpoints intact', async () => {
    for (let index = 0; index < 3; index++) {
      writeFileSync(join(docsDir, `Pause.${index}.html`), unityPage(`Pause.Api${index}`, `Pause test page ${index}.`));
    }
    const collection = store.createCollection({ name: 'unity-pause' });
    let sourceId = 0;
    let pauseSent = false;
    const paused = await indexer.indexFolder({
      collectionId: collection.id,
      rootPath: docsDir,
      folder: { bypass_relevance_gate: true, performance_profile: 'economy' },
    }, {
      onStart: ({ source_id }) => { sourceId = source_id; },
      onProgress: (progress) => {
        if (!pauseSent && progress.phase === 'reading') {
          pauseSent = store.requestIngestPause(sourceId);
        }
      },
    });

    expect(pauseSent).toBe(true);
    expect(paused.state).toBe('paused');
    expect(paused.run_id).toBeTypeOf('number');
    expect(store.getIngestRun(paused.run_id!)?.state).toBe('paused');

    const resumed = await indexer.indexFolder({
      collectionId: collection.id,
      rootPath: docsDir,
      resumeRunId: paused.run_id,
    });
    expect(resumed.state).toBe('completed');
    expect(resumed.run_id).toBe(paused.run_id);
    expect(store.getIngestRun(resumed.run_id!)?.state).toBe('completed');
  });
});
