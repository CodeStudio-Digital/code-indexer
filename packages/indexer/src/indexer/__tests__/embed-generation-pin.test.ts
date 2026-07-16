import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { VectorRecord } from '@mcp/shared/types.js';
import type { VectorStore, VectorWriteTarget } from '@mcp/store/vectors.js';
import { executeEmbedding } from '../indexer/embed-executor.js';

describe('executeEmbedding generation pin', () => {
  it('re-hashes code items with the fingerprint that actually produced the batch', async () => {
    const target = {
      kind: 'onnx' as const,
      model: 'space-a',
      pooling: 'mean' as const,
      normalize: true,
      queryTemplate: 'query: {text}',
      documentTemplate: 'passage: {text}',
    };
    const writeTarget: VectorWriteTarget = {
      generationId: 7,
      generationFingerprint: 'space-a',
      embeddingFingerprint: 'space-a',
      embeddingTarget: target,
    };
    const upsert = vi.fn(async (_records: VectorRecord[]) => 1);
    const vectorStore: VectorStore = {
      upsert,
      search: async () => [],
      deleteByIds: async () => 0,
      listItems: async () => [],
      isAvailable: async () => true,
    };
    const text = 'File: src/a.ts\nSummary: A';
    const hash = (fingerprint: string) => createHash('md5')
      .update(`${fingerprint}\n${text}`)
      .digest('hex');

    await executeEmbedding({
      db: {} as never,
      embeddingService: {
        embed: async () => ({ vectors: [[0, 1]], tokens: 1 }),
        embedQuery: async () => ({ vector: [0, 1], tokens: 1 }),
        embedDocumentsForNamespace: async () => ({
          vectors: [[1, 0]],
          tokens: 1,
          writeTarget,
        }),
        // Candidate selection happened after the desired profile had already
        // moved to B, while the namespace still accepted writes in A.
        fingerprint: () => 'space-b',
      },
      vectorStore,
      costTracker: { record: vi.fn() } as never,
      lshSink: { afterUpsert: async () => undefined },
    }, { id: 3, name: 'demo' }, null, [{
      text,
      id: 'f_a',
      filePath: 'src/a.ts',
      metadata: { type: 'file', ref_id: '1' },
      hash: hash('space-b'),
      embeddingFingerprint: 'space-b',
      hashForFingerprint: hash,
      onCommit: () => undefined,
    }]);

    expect(upsert).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'f_a',
        values: [1, 0],
        metadata: expect.objectContaining({ embedding_hash: hash('space-a') }),
      }),
    ], 'code:p3', writeTarget);
  });

  it('deletes an explicitly superseded identity after the replacement ledger row is committed', async () => {
    const deleteByIds = vi.fn(async () => 1);
    const vectorStore: VectorStore = {
      upsert: async () => 1,
      search: async () => [],
      deleteByIds,
      listItems: async () => [{
        itemKey: 'symbol:10549',
        sourceHash: 'old-hash',
        vectorId: 's_legacy_collision',
        chunkIndex: 0,
        status: 'indexed',
        attempts: 1,
        error: null,
      }],
      isAvailable: async () => true,
    };

    await executeEmbedding({
      db: {} as never,
      embeddingService: {
        embed: async () => ({ vectors: [[1, 0]], tokens: 1 }),
        embedQuery: async () => ({ vector: [1, 0], tokens: 1 }),
        fingerprint: () => 'local:test',
      },
      vectorStore,
      costTracker: { record: vi.fn() } as never,
      lshSink: { afterUpsert: async () => undefined },
    }, { id: 7, name: 'demo' }, null, [{
      text: 'function duplicate_name()',
      id: 's_disambiguated',
      filePath: 'duplicates.php',
      metadata: { type: 'symbol', ref_id: '10549' },
      hash: 'current-hash',
      supersededIds: ['s_legacy_collision'],
      onCommit: () => undefined,
    }]);

    expect(deleteByIds).toHaveBeenCalledWith(['s_legacy_collision'], 'code:p7');
  });
});
