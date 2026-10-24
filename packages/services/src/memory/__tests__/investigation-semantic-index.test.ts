import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { VectorStore, VectorWriteTarget } from '@mcp/store/vectors.js';
import type { VectorMatch } from '@mcp/shared/types.js';
import {
  InvestigationSemanticIndex,
  investigationEmbeddingTextHash,
  investigationVectorId,
  type InvestigationSemanticRow,
} from '../investigation-semantic-index.js';

const INVESTIGATION_ID = '018f0f5e-7b2d-7a45-8c11-0123456789ab';
const SESSION_ID = '018f0f5e-7b2d-7a45-8c11-0123456789ac';
const OTHER_INVESTIGATION_ID = '018f0f5e-7b2d-7a45-8c11-0123456789ad';

const row: InvestigationSemanticRow = {
  id: INVESTIGATION_ID,
  project_id: 7,
  session_id: SESSION_ID,
  topic: 'distributed vectors',
  summary: 'route investigation vectors with the Knowledge profile',
  body: 'long details remain relational',
  source_label: 'Explore',
  agent_type: 'explore',
  tokens: 120,
  created_at: '2026-07-15 10:00:00',
};

const target: VectorWriteTarget = {
  generationId: 12,
  generationFingerprint: 'knowledge-space',
  embeddingFingerprint: 'knowledge-space',
  embeddingTarget: {
    kind: 'onnx',
    model: 'knowledge-model',
    pooling: 'mean',
    normalize: true,
    queryTemplate: 'query: {text}',
    documentTemplate: 'passage: {text}',
  },
};

function makeVectorStore() {
  return {
    upsert: vi.fn(async () => 1),
    search: vi.fn(async (): Promise<VectorMatch[]> => []),
    deleteByIds: vi.fn(async () => 0),
    listItems: vi.fn(async () => []),
    isAvailable: vi.fn(async () => true),
  } satisfies VectorStore;
}

describe('InvestigationSemanticIndex', () => {
  it('cancels embedding reads without falling through to a vector query', async () => {
    const ctrl = new AbortController();
    const embedding = { embed: vi.fn(), embedQuery: vi.fn(),
      embedQueryForNamespace: vi.fn(async (_ns, _text, options) => {
        expect(options.signal).toBe(ctrl.signal); ctrl.abort();
        return { vector: [1], tokens: 1 };
      }) } as unknown as EmbeddingService;
    const vectors = makeVectorStore();
    const index = new InvestigationSemanticIndex({ listProject: () => [] }, null, vectors, embedding);
    await expect(index.search(7, 'auth', 8, ctrl.signal)).rejects.toThrow();
    expect(vectors.search).not.toHaveBeenCalled();
  });
  it('cancels embedding reads without falling through to a vector query', async () => {
    const ctrl = new AbortController();
    const embedding = { embed: vi.fn(), embedQuery: vi.fn(),
      embedQueryForNamespace: vi.fn(async (_ns, _text, options) => {
        expect(options.signal).toBe(ctrl.signal); ctrl.abort();
        return { vector: [1], tokens: 1 };
      }) } as unknown as EmbeddingService;
    const vectors = makeVectorStore();
    const index = new InvestigationSemanticIndex({ listProject: () => [] }, null, vectors, embedding);
    await expect(index.search(7, 'auth', 8, ctrl.signal)).rejects.toThrow();
    expect(vectors.search).not.toHaveBeenCalled();
  });
  it('writes a generation-pinned semantic item into the project Knowledge namespace', async () => {
    const embedding = {
      embed: vi.fn(),
      embedQuery: vi.fn(),
      embedDocumentsForNamespace: vi.fn(async () => ({
        vectors: [[0.6, 0.8]], tokens: 4, writeTarget: target,
      })),
      fingerprint: vi.fn(() => 'knowledge-space'),
    } satisfies EmbeddingService;
    const vectors = makeVectorStore();
    const index = new InvestigationSemanticIndex(
      { listProject: () => [row] }, embedding, vectors, embedding,
    );

    await expect(index.embedAndUpsert(row)).resolves.toEqual({ ok: true });

    expect(embedding.embedDocumentsForNamespace).toHaveBeenCalledWith(
      'memory:project:p7',
      ['distributed vectors\nroute investigation vectors with the Knowledge profile'],
    );
    expect(vectors.upsert).toHaveBeenCalledWith([
      {
        id: investigationVectorId(INVESTIGATION_ID),
        values: [0.6, 0.8],
        metadata: {
          type: 'investigation',
          ref_id: INVESTIGATION_ID,
          session_id: SESSION_ID,
          chunk_index: '0',
          embedding_hash: investigationEmbeddingTextHash(row, 'knowledge-space'),
        },
      },
    ], 'memory:project:p7', target);
  });

  it('queries only the active generation and returns deduplicated ranked ids', async () => {
    const queryEmbedding = {
      embed: vi.fn(),
      embedQuery: vi.fn(),
      embedQueryForNamespace: vi.fn(async () => ({ vector: [1, 0], tokens: 2, generationId: 33 })),
    } satisfies EmbeddingService;
    const vectors = makeVectorStore();
    vectors.search.mockResolvedValue([
      { id: 'a', score: 0.9, metadata: { type: 'investigation', ref_id: INVESTIGATION_ID } },
      { id: 'b', score: 0.8, metadata: { type: 'investigation', ref_id: INVESTIGATION_ID } },
      { id: 'c', score: 0.7, metadata: { type: 'investigation', ref_id: 'bad' } },
      { id: 'd', score: 0.6, metadata: { type: 'investigation', ref_id: OTHER_INVESTIGATION_ID } },
    ]);
    const index = new InvestigationSemanticIndex(
      { listProject: () => [] }, null, vectors, queryEmbedding,
    );

    await expect(index.search(7, 'routing', 3)).resolves.toEqual([
      INVESTIGATION_ID,
      OTHER_INVESTIGATION_ID,
    ]);
    expect(queryEmbedding.embedQueryForNamespace).toHaveBeenCalledWith(
      'memory:project:p7', 'routing',
    );
    expect(vectors.search).toHaveBeenCalledWith([1, 0], {
      namespace: 'memory:project:p7',
      generationId: 33,
      topK: 12,
      filter: { type: 'investigation' },
    });
  });

  it('fails open to lexical recall when no active generation/provider is available', async () => {
    const queryEmbedding = {
      embed: vi.fn(),
      embedQuery: vi.fn(async () => { throw new Error('no active generation'); }),
      embedQueryForNamespace: vi.fn(async () => { throw new Error('no active generation'); }),
    } satisfies EmbeddingService;
    const vectors = makeVectorStore();
    const index = new InvestigationSemanticIndex(
      { listProject: () => [] }, null, vectors, queryEmbedding,
    );

    await expect(index.search(7, 'routing', 8)).resolves.toEqual([]);
    expect(vectors.search).not.toHaveBeenCalled();
  });
});
