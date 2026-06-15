/**
 * Wave-based retryEmbeddings: file-based monotonic progress, bounded waves,
 * and partial-failure accounting (failed wave's hashes never commit).
 * Requires the Node-ABI better-sqlite3 build.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { makeHarness, smallFileFixture, type Harness } from './index-agent-harness.js';
import { retryEmbeddings } from '../indexer/embed-retry.js';
import { NullLshIndexingSink } from '../lsh-indexing-sink.js';

const harnesses: Harness[] = [];
const make = (): Harness => { const h = makeHarness(); harnesses.push(h); return h; };
afterEach(() => { for (const h of harnesses.splice(0)) h.dispose(); });

function deps(h: Harness) {
  return {
    db: h.db, embeddingService: h.embedding, vectorStore: h.vectorStore,
    costTracker: { record: () => 0 } as never, lshSink: new NullLshIndexingSink(),
  };
}

describe('retryEmbeddings in waves', () => {
  it('progress is file-based, monotonic, and ends at 100%', async () => {
    const h = make();
    for (let i = 0; i < 7; i++) h.writeFile(`f${i}.ts`, smallFileFixture(`fn${i}`));
    await h.agent.indexProject(h.projectRoot);
    h.db.clearEmbeddingHashes(h.projectId); // force a full re-embed

    const seen: Array<{ current: number; total: number; percent: number }> = [];
    const res = await retryEmbeddings(deps(h), h.projectRoot, {
      waveFiles: 3,
      onProgress: (p) => seen.push({ ...p }),
    });

    expect(res.embedded).toBeGreaterThan(0);
    expect(res.failedBatches).toBe(0);
    expect(seen.length).toBeGreaterThanOrEqual(3); // ceil(7/3) waves + final
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].current).toBeGreaterThanOrEqual(seen[i - 1].current);
    }
    const last = seen[seen.length - 1];
    expect(last.current).toBe(7);
    expect(last.total).toBe(7);
    expect(last.percent).toBe(100);
  });

  it('a failing wave is counted and the rest still embeds', async () => {
    const h = make();
    for (let i = 0; i < 6; i++) h.writeFile(`f${i}.ts`, smallFileFixture(`fn${i}`));
    await h.agent.indexProject(h.projectRoot);
    h.db.clearEmbeddingHashes(h.projectId);
    h.embedding.calls = 0;
    h.embedding.failOn = (idx) => idx === 0; // first embed() call (wave 1) dies

    const res = await retryEmbeddings(deps(h), h.projectRoot, { waveFiles: 2 });
    expect(res.failedBatches).toBeGreaterThanOrEqual(1);
    expect(res.embedded).toBeGreaterThan(0); // later waves unaffected

    // Failed wave's hashes never committed → a clean retry picks them up.
    h.embedding.failOn = null;
    const second = await retryEmbeddings(deps(h), h.projectRoot, { waveFiles: 2 });
    expect(second.failedBatches).toBe(0);
    expect(second.embedded).toBeGreaterThan(0);
  });

  it('throws when the vector store is unavailable', async () => {
    const h = make();
    const badDeps = { ...deps(h), vectorStore: null };
    await expect(retryEmbeddings(badDeps, h.projectRoot)).rejects.toThrow(/not available/);
  });
});
