/**
 * LSHIndex integration test — uses a real in-memory SQLite with migration 082.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import { embeddingLsh082 } from '@mcp/store/migrations/082_embedding_lsh.js';
import { LshIndexStore } from '@mcp/store/lsh-index-store.js';
import { LSHIndex } from '@mcp/indexer/search/lsh-index.js';
import { l2Normalize } from '@mcp/candidate-pipeline';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3') as typeof DatabaseConstructor;

function randomUnitVector(dim: number, rng: () => number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    const u1 = Math.max(1e-9, rng());
    const u2 = rng();
    v[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  return l2Normalize(v);
}

describe('LSHIndex', () => {
  let db: InstanceType<typeof Database>;
  let store: LshIndexStore;
  let index: LSHIndex;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    embeddingLsh082.up(db);
    store = new LshIndexStore(db);
    index = new LSHIndex({ dim: 64, store, seed: 42 });
  });

  afterEach(() => db.close());

  it('persists and retrieves signatures + buckets for one entity', () => {
    const v = new Float32Array(64);
    v[0] = 1;
    index.index({ projectId: 1, entityType: 'file', entityId: 100, embedding: v });
    const sig = store.getSignature({ project_id: 1, entity_type: 'file', entity_id: 100 });
    expect(sig).not.toBeNull();
    expect(sig?.dim).toBe(64);
  });

  it('bulk index is faster (smoke test, not perf)', () => {
    const inputs = Array.from({ length: 50 }, (_, i) => {
      const v = new Float32Array(64);
      v[i % 64] = 1;
      return { projectId: 1, entityType: 'file' as const, entityId: i + 1, embedding: v };
    });
    index.indexMany(inputs);
    const sigs = store.getSignaturesBulk(1, 'file', inputs.map((_, i) => i + 1));
    expect(sigs).toHaveLength(50);
  });

  it('candidatesFor returns the indexed near-neighbor', () => {
    let seed = 1;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    // Index 50 unit vectors.
    const vectors: Float32Array[] = [];
    for (let i = 0; i < 50; i++) {
      const v = randomUnitVector(64, rng);
      vectors.push(v);
      index.index({ projectId: 1, entityType: 'file', entityId: i + 1, embedding: v });
    }
    // Query with a perturbation of vector 7.
    const target = vectors[7];
    const query = new Float32Array(target).map((x) => x + (rng() - 0.5) * 0.02);
    const norm = Math.sqrt(query.reduce((s, x) => s + x * x, 0));
    for (let i = 0; i < 64; i++) query[i] /= norm;
    const candidates = index.candidatesFor(query, { projectId: 1, entityType: 'file', limit: 10 });
    // Entity 8 (entityId = 7 + 1) should be in the top candidates.
    expect(candidates.some((c) => c.entityId === 8)).toBe(true);
  });

  it('produces a stable params_hash across instances with the same config', () => {
    const a = new LSHIndex({ dim: 64, store, seed: 42 });
    const b = new LSHIndex({ dim: 64, store, seed: 42 });
    expect(a.getParamsHash()).toBe(b.getParamsHash());
  });

  it('different seeds give different params_hash', () => {
    const a = new LSHIndex({ dim: 64, store, seed: 1 });
    const b = new LSHIndex({ dim: 64, store, seed: 2 });
    expect(a.getParamsHash()).not.toBe(b.getParamsHash());
  });

  it('remove() drops both signature and buckets', () => {
    const v = new Float32Array(64);
    v[0] = 1;
    index.index({ projectId: 1, entityType: 'file', entityId: 100, embedding: v });
    index.remove({ projectId: 1, entityType: 'file', entityId: 100 });
    expect(store.getSignature({ project_id: 1, entity_type: 'file', entity_id: 100 })).toBeNull();
  });
});
