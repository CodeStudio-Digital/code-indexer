/**
 * Tests for the LSH primitives.
 *
 * Invariants verified:
 *   - Identical embeddings produce identical signatures
 *   - Cosine-similar embeddings produce similar signatures (low Hamming distance)
 *   - Orthogonal embeddings have ~16 differing bits (50% — expected for random hyperplanes)
 *   - Bucketize is deterministic and within [1, numBuckets - 1]
 *   - Recall in a synthetic benchmark stays > 90%
 */
import { describe, expect, it } from 'vitest';
import {
  bucketize,
  computeLshEntry,
  estimateCosineFromHamming,
  generateHyperplanes,
  generateMultiHashParams,
  hammingDistance,
  l2Normalize,
  simHashSignature,
} from '../index.js';

function randomUnitVector(dim: number, rng: () => number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    const u1 = Math.max(1e-9, rng());
    const u2 = rng();
    v[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  return l2Normalize(v);
}

describe('SimHash signatures', () => {
  it('produces identical signatures for identical embeddings', () => {
    const planes = generateHyperplanes(64, 32);
    const v = new Float32Array(64);
    for (let i = 0; i < 64; i++) v[i] = (i % 7) / 10;
    expect(simHashSignature(v, planes)).toBe(simHashSignature(v, planes));
  });

  it('similar embeddings have low Hamming distance', () => {
    const planes = generateHyperplanes(128, 32);
    // Make v2 a small perturbation of v1.
    const v1 = new Float32Array(128).map(() => Math.random());
    const v2 = new Float32Array(v1).map((x) => x + (Math.random() - 0.5) * 0.01);
    const s1 = simHashSignature(v1, planes);
    const s2 = simHashSignature(v2, planes);
    expect(hammingDistance(s1, s2)).toBeLessThan(8); // < 25%
  });

  it('orthogonal vectors have ~16-bit Hamming distance', () => {
    const planes = generateHyperplanes(128, 32);
    const a = new Float32Array(128);
    const b = new Float32Array(128);
    a[0] = 1;
    b[1] = 1;
    const d = hammingDistance(simHashSignature(a, planes), simHashSignature(b, planes));
    // 32 hyperplanes, random direction — expected 16 ± noise.
    expect(d).toBeGreaterThan(10);
    expect(d).toBeLessThan(22);
  });
});

describe('estimateCosineFromHamming', () => {
  it('returns 1.0 for distance 0', () => {
    expect(estimateCosineFromHamming(0, 32)).toBeCloseTo(1, 5);
  });
  it('returns 0 for half-matching bits (orthogonal)', () => {
    expect(estimateCosineFromHamming(16, 32)).toBeCloseTo(0, 5);
  });
  it('returns -1 for all-mismatched bits (opposite)', () => {
    expect(estimateCosineFromHamming(32, 32)).toBeCloseTo(-1, 5);
  });
});

describe('bucketize', () => {
  it('is deterministic', () => {
    const params = generateMultiHashParams(2, 4096);
    expect(bucketize(12345, params)).toEqual(bucketize(12345, params));
  });
  it('returns values in [1, numBuckets - 1]', () => {
    const numBuckets = 256;
    const params = generateMultiHashParams(3, numBuckets);
    for (let sig = 0; sig < 1000; sig++) {
      const buckets = bucketize(sig, params);
      for (const b of buckets) {
        expect(b).toBeGreaterThanOrEqual(1);
        expect(b).toBeLessThan(numBuckets);
      }
    }
  });
});

describe('computeLshEntry', () => {
  it('round-trips through signature + bucket pipeline', () => {
    const planes = generateHyperplanes(64, 32);
    const params = generateMultiHashParams(2, 4096);
    const v = randomUnitVector(64, Math.random);
    const entry = computeLshEntry('e1', v, planes, params);
    expect(entry.candidateId).toBe('e1');
    expect(entry.buckets).toHaveLength(2);
    // Re-computing should give identical entry.
    const again = computeLshEntry('e1', v, planes, params);
    expect(again.signature).toBe(entry.signature);
    expect(again.buckets).toEqual(entry.buckets);
  });
});

describe('LSH recall benchmark', () => {
  it('finds the true near-neighbor in > 90% of trials', () => {
    // Use 4 hashes (OR-amplification) with 8-bit bands. 32 hyperplanes /
    // 4 bands = 8 bits per band → 256 buckets per band. A match in ANY
    // band counts as a hit, which is the textbook LSH setup for high
    // recall near-neighbor lookup.
    const dim = 128;
    const numHyperplanes = 32;
    const planes = generateHyperplanes(dim, numHyperplanes, 0xdeadbeef);
    const params = generateMultiHashParams(4, 256, 0xcafef00d);
    // Build a corpus of 200 random unit vectors.
    let seed = 1;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const corpus = Array.from({ length: 200 }, () => randomUnitVector(dim, rng));
    const corpusEntries = corpus.map((v, i) => computeLshEntry(String(i), v, planes, params));

    // For 30 random queries, pick a known nearest neighbor (small perturbation
    // of one corpus vector) and verify it appears in the bucket-intersection.
    let hits = 0;
    const trials = 30;
    for (let t = 0; t < trials; t++) {
      const baseIdx = Math.floor(rng() * corpus.length);
      const base = corpus[baseIdx];
      const query = new Float32Array(base).map((x) => x + (rng() - 0.5) * 0.05);
      // l2 normalize:
      let norm = 0;
      for (let i = 0; i < dim; i++) norm += query[i] * query[i];
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < dim; i++) query[i] /= norm;

      const querySig = simHashSignature(query, planes);
      const queryBuckets = bucketize(querySig, params);
      // A candidate is "found" if any of its buckets matches any of the query's.
      const candidates = corpusEntries.filter((e) =>
        e.buckets.some((b, i) => b === queryBuckets[i]),
      );
      if (candidates.some((c) => c.candidateId === String(baseIdx))) hits++;
    }
    const recall = hits / trials;
    expect(recall).toBeGreaterThan(0.9);
  });
});
