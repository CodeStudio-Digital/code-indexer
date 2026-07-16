import { describe, expect, it } from 'vitest';
import * as vectorExports from '../vectors.js';
import * as splitExports from '../db-split/index.js';
import {
  NullVectorStore,
  embeddingFingerprintForGeneration,
  generationMatchesEmbeddingFingerprint,
} from '../vectors.js';
import { projectDbFlags } from '@mcp/shared/utils/config.js';

describe('local-only vector storage contract', () => {
  it('does not export remote adapters or the legacy config factory', () => {
    expect(vectorExports).not.toHaveProperty('CloudflareVectorStore');
    expect(vectorExports).not.toHaveProperty('QdrantVectorStore');
    expect(vectorExports).not.toHaveProperty('PineconeVectorStore');
    expect(vectorExports).not.toHaveProperty('OpenSearchVectorStore');
    expect(vectorExports).not.toHaveProperty('createVectorStore');
  });

  it('does not expose the legacy vector-copy migration or its feature flag', () => {
    expect(splitExports).not.toHaveProperty('splitProjectVectors');
    expect(projectDbFlags({ MCP_PROJECT_DB: '1', MCP_PROJECT_DB_VECTORS: '1' }))
      .not.toHaveProperty('vectors');
  });

  it('keeps an inert namespace-aware fallback', async () => {
    const store = new NullVectorStore();
    await expect(store.upsert([], 'code:p1')).resolves.toBe(0);
    await expect(store.search([1, 0], { namespace: 'code:p1', topK: 5 })).resolves.toEqual([]);
    await expect(store.deleteByIds(['v1'], 'code:p1')).resolves.toBe(0);
    await expect(store.deleteNamespace('code:p1')).resolves.toBe(0);
    await expect(store.isAvailable()).resolves.toBe(false);
  });

  it('pins dimension in generation identity without changing item hash space', () => {
    const generation = 'semantic:space:space-dimension:384:rebuild:1784102400000:a1b2c3';
    expect(embeddingFingerprintForGeneration(generation)).toBe('semantic:space');
    expect(generationMatchesEmbeddingFingerprint(generation, 'semantic:space')).toBe(true);
  });
});
