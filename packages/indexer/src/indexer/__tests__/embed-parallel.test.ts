/**
 * F10 — bounded-concurrency embed runner: in-flight cap respected, a failed
 * chunk never aborts siblings nor commits, groups are never split across
 * chunks (the cross-batch hash-commit guarantee under parallelism).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveEmbedConcurrency,
  runEmbedChunks,
  sliceCandidateChunks,
} from '../indexer/embed-parallel.js';
import type { EmbeddingCandidate } from '../indexer/embedding-candidates.js';

function candidate(id: string, groupKey?: string): EmbeddingCandidate {
  return { id, text: id, filePath: 'f.ts', metadata: {}, hash: 'h', onCommit: () => {}, groupKey };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('sliceCandidateChunks', () => {
  it('slices plain candidates at chunkSize', () => {
    const chunks = sliceCandidateChunks([1, 2, 3, 4, 5].map((i) => candidate(`c${i}`)), 2);
    expect(chunks.map((c) => c.length)).toEqual([2, 2, 1]);
  });

  it('never splits a group across chunks', () => {
    const cands = [
      candidate('a'),
      candidate('b'),
      candidate('g1', 'body:1'),
      candidate('g2', 'body:1'),
      candidate('g3', 'body:1'),
      candidate('z'),
    ];
    const chunks = sliceCandidateChunks(cands, 3);
    // Chunk 1 would close at [a, b, g1] but g2 continues the group → extends.
    expect(chunks[0].map((c) => c.id)).toEqual(['a', 'b', 'g1', 'g2', 'g3']);
    expect(chunks[1].map((c) => c.id)).toEqual(['z']);
  });
});

describe('runEmbedChunks', () => {
  it('respects the concurrency bound', async () => {
    const cands = Array.from({ length: 12 }, (_, i) => candidate(`c${i}`));
    let inFlight = 0;
    let maxInFlight = 0;
    const res = await runEmbedChunks(cands, {
      chunkSize: 2,
      concurrency: 3,
      execute: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(10);
        inFlight--;
        return { tokens: 1, lshFailed: 0 };
      },
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(res.embedded).toBe(12);
    expect(res.failures).toHaveLength(0);
  });

  it('a failing chunk does not abort siblings and is reported', async () => {
    const cands = Array.from({ length: 9 }, (_, i) => candidate(`c${i}`));
    let calls = 0;
    const res = await runEmbedChunks(cands, {
      chunkSize: 3,
      concurrency: 2,
      execute: async (chunk) => {
        calls++;
        if (chunk[0].id === 'c3') throw new Error('boom');
        return { tokens: chunk.length, lshFailed: 0 };
      },
    });
    expect(calls).toBe(3);                 // all chunks attempted
    expect(res.embedded).toBe(6);          // 2 of 3 chunks succeeded
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0].error).toContain('boom');
    expect(res.tokens).toBe(6);
  });

  it('reports monotonic progress by completion', async () => {
    const cands = Array.from({ length: 6 }, (_, i) => candidate(`c${i}`));
    const seen: number[] = [];
    await runEmbedChunks(cands, {
      chunkSize: 2,
      concurrency: 2,
      execute: async () => { await delay(5); return { tokens: 0, lshFailed: 0 }; },
      onChunkDone: ({ embedded }) => seen.push(embedded),
    });
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen.at(-1)).toBe(6);
  });
});

describe('resolveEmbedConcurrency', () => {
  const origEnv = process.env.MCP_EMBED_CONCURRENCY;
  afterEach(() => {
    if (origEnv === undefined) delete process.env.MCP_EMBED_CONCURRENCY;
    else process.env.MCP_EMBED_CONCURRENCY = origEnv;
  });

  it('env wins over the service hint; absent both → 1', () => {
    const svc = {
      embed: async () => ({ vectors: [], tokens: 0 }),
      embedQuery: async () => ({ vector: [], tokens: 0 }),
      maxConcurrency: () => 4,
    };
    process.env.MCP_EMBED_CONCURRENCY = '2';
    expect(resolveEmbedConcurrency(svc)).toBe(2);
    delete process.env.MCP_EMBED_CONCURRENCY;
    expect(resolveEmbedConcurrency(svc)).toBe(4);
    expect(resolveEmbedConcurrency({ embed: svc.embed, embedQuery: svc.embedQuery })).toBe(1);
  });
});
