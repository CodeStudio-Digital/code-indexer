import { describe, expect, it, vi } from 'vitest';
import { SemanticVectorWorkerClient } from '../SemanticVectorWorkerClient.js';

describe('SemanticVectorWorkerClient generation cleanup RPC', () => {
  it('does not evict a worker that still reports an active timed-out operation', async () => {
    vi.useFakeTimers();
    try {
      const client = new SemanticVectorWorkerClient('D:/data/index.db', {
        file: 'D:/fake/semantic-vector-worker.js',
        execArgv: [],
        built: true,
      });
      const idleState = vi.fn(async () => ({
        activeOperations: 1,
        active: true,
        queued: 0,
      }));
      const evict = vi.fn(async () => undefined);
      const host = {
        isRunning: () => true,
        requireBridge: () => ({ request: idleState }),
        evict,
      };
      const internals = client as unknown as {
        host: typeof host | null;
        scheduleIdleEviction(): void;
      };
      internals.host = host;
      internals.scheduleIdleEviction();

      await vi.advanceTimersByTimeAsync(5 * 60_000);

      expect(idleState).toHaveBeenCalledWith('worker.idleState', {}, { timeoutMs: 5_000 });
      expect(evict).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts a worker after five idle minutes when both sides are idle', async () => {
    vi.useFakeTimers();
    try {
      const client = new SemanticVectorWorkerClient('D:/data/index.db', {
        file: 'D:/fake/semantic-vector-worker.js',
        execArgv: [],
        built: true,
      });
      const idleState = vi.fn(async () => ({
        activeOperations: 0,
        active: false,
        queued: 0,
      }));
      const evict = vi.fn(async () => undefined);
      const host = {
        isRunning: () => true,
        requireBridge: () => ({ request: idleState }),
        evict,
      };
      const internals = client as unknown as {
        host: typeof host | null;
        scheduleIdleEviction(): void;
      };
      internals.host = host;
      internals.scheduleIdleEviction();

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await Promise.resolve();

      expect(evict).toHaveBeenCalledTimes(1);
      expect(internals.host).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes local embedding and reranking through the semantic worker', async () => {
    const client = new SemanticVectorWorkerClient('D:/data/index.db', {
      file: 'D:/fake/semantic-vector-worker.js',
      execArgv: [],
      built: true,
    });
    const embeddingTarget = {
      kind: 'onnx' as const,
      model: 'Xenova/multilingual-e5-small',
      pooling: 'mean' as const,
      normalize: true,
      queryTemplate: 'query: {text}',
      documentTemplate: 'passage: {text}',
    };
    const rerankerTarget = { kind: 'onnx' as const, model: 'auto' as const };
    const request = vi.fn(async (type: string) => {
      if (type === 'inference.embed') return { vectors: [[1, 0]], tokens: 1 };
      if (type === 'inference.embedQuery') return { vector: [1, 0], tokens: 1 };
      return {
        results: [{ id: 'a', score: 0.9, originalScore: 0.5 }],
        diagnostics: {
          policy: 'auto', requested_model: 'auto', resolved_model: 'Xenova/bge-reranker-base',
          dtype: 'q8', estimated_peak_bytes: 1, reserve_bytes: 1,
          execution_provider: 'cpu', downgrade_reason: null, last_latency_ms: 12,
          enabled: true, total_memory_bytes: 1, available_memory_bytes: 1,
          cpu_cores: 16, active: true, queued: 0,
        },
      };
    });
    Object.defineProperty(client, 'request', { value: request });

    const embedding = client.embeddingService(embeddingTarget);
    expect(embedding.fingerprint?.()).toMatch(/^local:Xenova\/multilingual-e5-small:/);
    await expect(embedding.embed(['doc'])).resolves.toEqual({ vectors: [[1, 0]], tokens: 1 });
    await expect(embedding.embedQuery('query')).resolves.toEqual({ vector: [1, 0], tokens: 1 });
    const reranker = client.rerankerService(rerankerTarget);
    expect(reranker.candidatePoolSize?.(10)).toBe(64);
    await expect(reranker.rerank('query', [
      { id: 'a', text: 'doc', originalScore: 0.5 },
    ], 1, { supersessionKey: 'search-everywhere:p91' })).resolves.toEqual([
      { id: 'a', score: 0.9, originalScore: 0.5 },
    ]);

    expect(request.mock.calls.map((call) => call[0])).toEqual([
      'inference.embed', 'inference.embedQuery', 'inference.rerank',
    ]);
    expect(request.mock.calls[2]).toEqual(['inference.rerank', {
      target: rerankerTarget,
      query: 'query',
      candidates: [{ id: 'a', text: 'doc', originalScore: 0.5 }],
      topK: 1,
      supersessionKey: 'search-everywhere:p91',
    }]);
    await expect(client.rerankerDiagnostics(rerankerTarget)).resolves.toMatchObject({
      resolved_model: 'Xenova/bge-reranker-base',
      dtype: 'q8',
      last_latency_ms: 12,
    });
  });

  it('resolves diagnostics through one coalesced metadata-only worker RPC', async () => {
    const client = new SemanticVectorWorkerClient('D:/data/index.db', {
      file: 'D:/fake/semantic-vector-worker.js',
      execArgv: [],
      built: true,
    });
    const target = { kind: 'onnx' as const, model: 'auto' as const, dtype: 'q8' as const };
    const diagnostics = {
      policy: 'auto' as const,
      requested_model: 'auto',
      resolved_model: 'Xenova/bge-reranker-base',
      dtype: 'q8',
      estimated_peak_bytes: 760 * 1024 * 1024,
      reserve_bytes: 1024 ** 3,
      execution_provider: 'cpu',
      downgrade_reason: null,
      last_latency_ms: null,
      enabled: true,
      total_memory_bytes: 64 * 1024 ** 3,
      available_memory_bytes: 40 * 1024 ** 3,
      cpu_cores: 16,
      active: false,
      queued: 0,
    };
    const request = vi.fn(async () => diagnostics);
    Object.defineProperty(client, 'request', { value: request });

    const [first, second] = await Promise.all([
      client.rerankerDiagnostics(target),
      client.rerankerDiagnostics(target),
    ]);

    expect(first).toEqual(diagnostics);
    expect(second).toEqual(diagnostics);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('inference.rerankerDiagnostics', { target });
  });

  it('routes generation-table drops through the worker bridge', async () => {
    const client = new SemanticVectorWorkerClient('D:/data/index.db', {
      file: 'D:/fake/semantic-vector-worker.js',
      execArgv: [],
      built: true,
    });
    const request = vi.fn(async () => undefined);
    Object.defineProperty(client, 'request', { value: request });

    await client.dropGeneration('memory:project:p7', 18);

    expect(request).toHaveBeenCalledWith('vectors.dropGeneration', {
      namespace: 'memory:project:p7',
      generationId: 18,
    });
  });

  it('routes physical id probes through the worker bridge', async () => {
    const client = new SemanticVectorWorkerClient('D:/data/index.db', {
      file: 'D:/fake/semantic-vector-worker.js',
      execArgv: [],
      built: true,
    });
    const request = vi.fn(async () => ['a', 'b']);
    Object.defineProperty(client, 'request', { value: request });

    await expect(client.listIds('code:p3', 9)).resolves.toEqual(['a', 'b']);
    expect(request).toHaveBeenCalledWith('vectors.listIds', {
      namespace: 'code:p3',
      generationId: 9,
    });
  });

  it('transports a pinned search generation through the worker bridge', async () => {
    const client = new SemanticVectorWorkerClient('D:/data/index.db', {
      file: 'D:/fake/semantic-vector-worker.js',
      execArgv: [],
      built: true,
    });
    const request = vi.fn(async () => []);
    Object.defineProperty(client, 'request', { value: request });

    await client.search([1, 0], { namespace: 'code:p3', generationId: 9, topK: 4 });

    expect(request).toHaveBeenCalledWith('vectors.search', {
      queryVector: [1, 0],
      options: { namespace: 'code:p3', generationId: 9, topK: 4 },
    });
  });

  it('transports the immutable batch write target through the worker bridge', async () => {
    const client = new SemanticVectorWorkerClient('D:/data/index.db', {
      file: 'D:/fake/semantic-vector-worker.js',
      execArgv: [],
      built: true,
    });
    const request = vi.fn(async () => 1);
    Object.defineProperty(client, 'request', { value: request });
    const writeTarget = {
      generationId: 9,
      generationFingerprint: 'space-a:rebuild:1784102400000:a1b2c3',
      embeddingFingerprint: 'space-a',
      embeddingTarget: {
        kind: 'onnx' as const,
        model: 'space-a',
        pooling: 'mean' as const,
        normalize: true,
        queryTemplate: 'query: {text}',
        documentTemplate: 'passage: {text}',
      },
    };

    await client.upsert([{
      id: 'a', values: [1, 0], metadata: { type: 'file' },
    }], 'code:p3', writeTarget);

    expect(request).toHaveBeenCalledWith('vectors.upsert', {
      records: [{ id: 'a', values: [1, 0], metadata: { type: 'file' } }],
      namespace: 'code:p3',
      writeTarget,
    });
  });

  it('routes reconciliation deletes to one explicit generation', async () => {
    const client = new SemanticVectorWorkerClient('D:/data/index.db', {
      file: 'D:/fake/semantic-vector-worker.js',
      execArgv: [],
      built: true,
    });
    const request = vi.fn(async () => 1);
    Object.defineProperty(client, 'request', { value: request });

    await client.deleteByItemKeysForGeneration('snapshot:p3', 12, ['snapshot:9']);
    await client.deleteByIdsForGeneration('snapshot:p3', 12, ['sn9']);

    expect(request.mock.calls).toEqual([
      ['vectors.deleteByItemKeysForGeneration', {
        namespace: 'snapshot:p3', generationId: 12, itemKeys: ['snapshot:9'],
      }],
      ['vectors.deleteByIdsForGeneration', {
        namespace: 'snapshot:p3', generationId: 12, ids: ['sn9'],
      }],
    ]);
  });
});
