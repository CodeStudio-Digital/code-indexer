import { describe, expect, it } from 'vitest';
import {
  BGE_BASE_RERANKER,
  XSMALL_RERANKER,
  resolveLocalReranker,
  resolvedRerankDepth,
} from '../local-reranker-policy.js';

const GIB = 1024 ** 3;

describe('local reranker automatic policy', () => {
  it('selects xsmall q8 and depth 20 on low-memory or low-core machines', () => {
    const resolved = resolveLocalReranker({ kind: 'onnx', model: 'auto' }, {
      totalMemoryBytes: 12 * GIB,
      availableMemoryBytes: 8 * GIB,
      cpuCores: 4,
    });
    expect(resolved).toMatchObject({
      enabled: true,
      model: XSMALL_RERANKER,
      dtype: 'q8',
      fixedDepth: 20,
    });
    expect(resolvedRerankDepth(resolved, 10, 100)).toBe(20);
  });

  it('selects xsmall q8 and depth 40 on the medium tier', () => {
    const resolved = resolveLocalReranker({ kind: 'onnx', model: 'auto' }, {
      totalMemoryBytes: 24 * GIB,
      availableMemoryBytes: 12 * GIB,
      cpuCores: 8,
    });
    expect(resolved).toMatchObject({ model: XSMALL_RERANKER, fixedDepth: 40 });
  });

  it('selects BGE Base q8 and adaptive topK x2 depth on large machines', () => {
    const resolved = resolveLocalReranker({ kind: 'onnx', model: 'auto' }, {
      totalMemoryBytes: 96 * GIB,
      availableMemoryBytes: 80 * GIB,
      cpuCores: 16,
    });
    expect(resolved).toMatchObject({
      enabled: true,
      model: BGE_BASE_RERANKER,
      dtype: 'q8',
      fixedDepth: null,
    });
    expect(resolvedRerankDepth(resolved, 25, 100)).toBe(50);
    expect(resolvedRerankDepth(resolved, 40, 100)).toBe(64);
  });

  it('downgrades to xsmall under pressure and disables when the reserve cannot fit', () => {
    const downgraded = resolveLocalReranker({ kind: 'onnx', model: 'auto' }, {
      totalMemoryBytes: 64 * GIB,
      availableMemoryBytes: 1500 * 1024 ** 2,
      cpuCores: 16,
    });
    expect(downgraded.enabled).toBe(true);
    expect(downgraded.model).toBe(XSMALL_RERANKER);
    expect(downgraded.downgradeReason).toMatch(/safety envelope/);

    const disabled = resolveLocalReranker({ kind: 'onnx', model: 'auto' }, {
      totalMemoryBytes: 64 * GIB,
      availableMemoryBytes: 1100 * 1024 ** 2,
      cpuCores: 16,
    });
    expect(disabled.enabled).toBe(false);
    expect(disabled.model).toBeNull();
    expect(disabled.downgradeReason).toMatch(/1 GB reserve/);
  });
});

