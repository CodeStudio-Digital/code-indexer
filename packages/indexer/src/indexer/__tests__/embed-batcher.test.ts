/**
 * Streaming embed batcher: waves at the flush threshold, output parity with
 * the one-big-batch flow, and the aggressive-profile on_demand gate.
 * Requires the Node-ABI better-sqlite3 build.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { makeHarness, smallFileFixture, bigFunctionFixture, type Harness } from './index-agent-harness.js';
import { createEmbedBatcher } from '../indexer/embed-batcher.js';
import { NullLshIndexingSink } from '../lsh-indexing-sink.js';

const harnesses: Harness[] = [];
const make = (): Harness => { const h = makeHarness(); harnesses.push(h); return h; };
afterEach(() => { for (const h of harnesses.splice(0)) h.dispose(); delete process.env.MCP_EMBED_FLUSH_THRESHOLD; });

function seedFiles(h: Harness, count: number): void {
  for (let i = 0; i < count; i++) {
    h.writeFile(`f${i}.ts`, i % 3 === 0 ? bigFunctionFixture(`big${i}`) : smallFileFixture(`fn${i}`));
  }
}

describe('embed batcher', () => {
  it('a small flush threshold produces multiple embedding waves', async () => {
    process.env.MCP_EMBED_FLUSH_THRESHOLD = '4';
    const h = make();
    seedFiles(h, 6);
    const result = await h.agent.indexProject(h.projectRoot);
    expect(result.errorCount).toBe(0);
    expect(result.indexedFiles).toBe(6);
    // 6 files → ≥12 candidates → with waves of ~4 the embedder is hit
    // several times instead of once.
    expect(h.embedding.calls).toBeGreaterThan(2);
  });

  it('streamed waves produce the same vector ids as one big batch', async () => {
    process.env.MCP_EMBED_FLUSH_THRESHOLD = '3';
    const waved = make();
    seedFiles(waved, 5);
    await waved.agent.indexProject(waved.projectRoot);
    const wavedIds = (await waved.vectorStore.listIds()).sort();

    delete process.env.MCP_EMBED_FLUSH_THRESHOLD; // default = effectively one wave here
    const batch = make();
    seedFiles(batch, 5);
    await batch.agent.indexProject(batch.projectRoot);
    const batchIds = (await batch.vectorStore.listIds()).sort();

    expect(wavedIds).toEqual(batchIds);
    expect(wavedIds.length).toBeGreaterThan(0);
  });

  it('aggressive profile skips on_demand files without touching the embedder', async () => {
    const h = make();
    h.writeFile('a.ts', smallFileFixture('alpha'));
    await h.agent.indexProject(h.projectRoot); // create file rows
    const fileRow = h.db.getFile(h.projectId, 'a.ts');
    expect(fileRow).toBeDefined();

    h.embedding.calls = 0;
    const batcher = createEmbedBatcher(
      {
        db: h.db, embeddingService: h.embedding, vectorStore: h.vectorStore,
        costTracker: { record: () => 0 } as never, lshSink: new NullLshIndexingSink(),
        indexProfile: 'aggressive',
      },
      { id: h.projectId, name: 'harness' },
      1,
    );
    await batcher.addFile({
      path: 'a.ts', fileId: fileRow!.id,
      analysis: { language: 'typescript', summary: 's', concepts: [], symbols: [] } as never,
      content: 'x', tier: 'on_demand',
    });
    const summary = await batcher.finish();
    expect(summary.skippedOnDemand).toBe(1);
    expect(summary.embedded).toBe(0);
    expect(h.embedding.calls).toBe(0);
  });
});
