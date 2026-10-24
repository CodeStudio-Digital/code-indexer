/**
 * End-to-end Frente 2 smoke: real LocalEmbeddingService (Xenova e5-small)
 * composed with the real SqliteVecVectorStore (vec0). Proves the offline RAG
 * path works as a whole — embed documents → store in sqlite-vec → embed a
 * query → KNN search → the semantically relevant doc ranks first.
 *
 * Gated behind RUN_LOCAL_RAG_SMOKE=1 because it downloads the e5-small model
 * (~100-470MB) on first run — CI shouldn't pay that. Run locally with:
 *   RUN_LOCAL_RAG_SMOKE=1 npx vitest run .../local-rag-smoke.test.ts
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { LocalEmbeddingService } from '../local-embeddings.js';
import { SqliteVecVectorStore } from '@mcp/store/sqlite-vec-store.js';

const RUN = process.env.RUN_LOCAL_RAG_SMOKE === '1';

describe.skipIf(!RUN)('local RAG smoke (real e5-small + sqlite-vec)', () => {
  it('ranks the semantically relevant document first', async () => {
    if (!process.env.MCP_MODEL_CACHE_DIR) {
      process.env.MCP_MODEL_CACHE_DIR = path.join(os.tmpdir(), 'mcp-e5-probe');
    }
    const embed = new LocalEmbeddingService();
    const store = new SqliteVecVectorStore({ path: ':memory:' });
    const { env } = await import('@huggingface/transformers');
    const previousRemote = env.allowRemoteModels;
    if (process.env.MCP_RAG_SMOKE_OFFLINE === '1') env.allowRemoteModels = false;

    try {

    const docs = [
      { id: 'd1', text: 'The cache layer uses Redis for fast key/value lookups.' },
      { id: 'd2', text: 'User authentication is handled with signed JWT tokens.' },
      { id: 'd3', text: 'The build pipeline compiles TypeScript and bundles assets.' },
    ];
    const { vectors } = await embed.embed(docs.map((d) => d.text));
    await store.upsert(
      docs.map((d, i) => ({
        id: d.id,
        values: vectors[i],
        metadata: { project_name: 'p', type: 'symbol_body', ref_id: String(i) },
      })),
    );

    const { vector } = await embed.embedQuery('how is caching implemented?');
    const res = await store.search(vector, { topK: 3, filter: { project_name: 'p' } });

    expect(res).toHaveLength(3);
    expect(res[0].id).toBe('d1'); // caching query → the Redis cache doc wins
    } finally {
      await embed.dispose();
      store.close();
      env.allowRemoteModels = previousRemote;
    }
  }, 180_000);
});
