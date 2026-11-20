/**
 * Wave-based retryEmbeddings: file-based monotonic progress, bounded waves,
 * and partial-failure accounting (failed wave's hashes never commit).
 * Requires the Node-ABI better-sqlite3 build.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeStructuralHarness,
  smallFileFixture,
  type StructuralHarness,
} from './structural-test-harness.js';
import { retryEmbeddings } from '../indexer/embed-retry.js';
import { NullLshIndexingSink } from '../lsh-indexing-sink.js';
import { codeNamespace } from '@mcp/shared/vector-namespace.js';

const harnesses: StructuralHarness[] = [];
const make = (): StructuralHarness => {
  const h = makeStructuralHarness();
  harnesses.push(h);
  h.db.updateProject(h.projectId, { semantic_index_folders: '["."]' });
  return h;
};
afterEach(() => { for (const h of harnesses.splice(0)) h.dispose(); });

function deps(h: StructuralHarness) {
  return {
    db: h.db, embeddingService: h.embedding, vectorStore: h.vectorStore,
    costTracker: { record: () => 0 } as never, lshSink: new NullLshIndexingSink(),
  };
}

describe('retryEmbeddings in waves', () => {
  it('progress is file-based, monotonic, and ends at 100%', async () => {
    const h = make();
    for (let i = 0; i < 7; i++) h.writeFile(`f${i}.ts`, smallFileFixture(`fn${i}`));
    await h.indexStructural();
    h.vectorStore.clearItems(codeNamespace(h.projectId)); // force a full ledger reconciliation

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
    await h.indexStructural();
    h.vectorStore.clearItems(codeNamespace(h.projectId));
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

  it('reads only the project-relative paths supplied by an incremental catch-up', async () => {
    const h = make();
    for (let i = 0; i < 4; i++) h.writeFile(`f${i}.ts`, smallFileFixture(`fn${i}`));
    await h.indexStructural();
    h.vectorStore.clearItems(codeNamespace(h.projectId));
    const seen: Array<{ current: number; total: number }> = [];

    const result = await retryEmbeddings(deps(h), h.projectRoot, {
      paths: ['f2.ts', 'f2.ts'],
      onProgress: ({ current, total }) => seen.push({ current, total }),
    });

    expect(result.failedBatches).toBe(0);
    expect(result.embedded).toBeGreaterThan(0);
    expect(seen.at(-1)).toEqual({ current: 1, total: 1 });
  });

  it('throws when the vector store is unavailable', async () => {
    const h = make();
    const badDeps = { ...deps(h), vectorStore: null };
    await expect(retryEmbeddings(badDeps, h.projectRoot)).rejects.toThrow(/not available/);
  });

  it('limits both a full retry and a file delta to the selected folder and its descendants', async () => {
    const h = make();
    for (const path of ['src/nested', 'src-other']) mkdirSync(join(h.projectRoot, path), { recursive: true });
    h.writeFile('src/keep.ts', smallFileFixture('includedSource'));
    h.writeFile('src/nested/deep.ts', smallFileFixture('includedNested'));
    h.writeFile('src-other/skip.ts', smallFileFixture('outsideSource'));
    await h.indexStructural();
    h.db.updateProject(h.projectId, { semantic_index_folders: '["src"]' });
    h.vectorStore.clearItems(codeNamespace(h.projectId));

    const seen: number[] = [];
    const result = await retryEmbeddings(deps(h), h.projectRoot, {
      onProgress: (progress) => seen.push(progress.total),
    });
    expect(result.embedded).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(2);
    const before = h.embedding.calls;
    const outside = await retryEmbeddings(deps(h), h.projectRoot, { paths: ['src-other/skip.ts'] });
    expect(outside.embedded).toBe(0);
    expect(h.embedding.calls).toBe(before);
    expect(h.db.countFiles(h.projectId)).toBe(3);
    expect(h.db.getFile(h.projectId, 'src-other/skip.ts')).toBeDefined();
  });
});
