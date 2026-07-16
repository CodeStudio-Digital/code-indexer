import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupUnusedSemanticVectors,
  fetchSemanticGenerations,
  probeSemanticTarget,
  reindexProjectSemanticCode,
  saveSemanticProfile,
  semanticJobIsExecuting,
  type SemanticTarget,
} from '../semantic-api.js';

describe('semantic admin API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requests only the selected project namespace', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({
        ok: true,
        job: { id: 4, namespace: 'semantic:reindex:code:p91', status: 'pending' },
      }),
      { status: 202, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await reindexProjectSemanticCode(91);

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/91/semantic/reindex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'rebuild' }),
    });
  });

  it('requests explicit cleanup of unused vector generations', async () => {
    const result = {
      tables_removed: 1,
      items_removed: 40,
      databases_compacted: 1,
      bytes_reclaimed: 8192,
      skipped_referenced: 2,
      failures: [],
    };
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, result }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(cleanupUnusedSemanticVectors()).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/semantic/vectors/cleanup-unused', {
      method: 'POST',
    });
  });

  it('does not classify durable queued work as an executing worker', () => {
    const job = {
      id: 1,
      generation_id: null,
      namespace: 'semantic:reindex:code',
      kind: 'build',
      status: 'pending' as const,
      expected_items: 0,
      processed_items: 0,
      failed_items: 0,
      error: null,
      updated_at: 'now',
    };

    expect(semanticJobIsExecuting(job)).toBe(false);
    expect(semanticJobIsExecuting({ ...job, status: 'running' })).toBe(true);
  });

  it('surfaces a rejected project request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'project not found' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(reindexProjectSemanticCode(404)).rejects.toThrow('project not found');
  });

  it('forwards explicit FP32 confirmation to probe and profile save', async () => {
    const target: SemanticTarget = {
      kind: 'onnx',
      model: 'vendor/heavy-model',
      dtype: 'fp32',
    };
    const profile = {
      purpose: 'code' as const,
      embedding_target: target,
      reranker_target: { kind: 'disabled' as const },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ ok: true, dimensions: 768, latency_ms: 12 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ profile }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
    vi.stubGlobal('fetch', fetchMock);

    await probeSemanticTarget('embedding', target, true);
    await saveSemanticProfile('code', {
      embedding_target: target,
      reranker_target: { kind: 'disabled' },
    }, true);

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/admin/semantic/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability: 'embedding', target, confirm_fp32: true }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/admin/semantic/profiles/code', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embedding_target: target,
        reranker_target: { kind: 'disabled' },
        confirm_fp32: true,
      }),
    });
  });

  it('keeps worker reranker diagnostics in the semantic status response', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      generations: [],
      jobs: [],
      storage: [],
      rerankers: {
        code: {
          target_kind: 'onnx',
          diagnostics: {
            policy: 'auto',
            requested_model: 'auto',
            resolved_model: 'Xenova/bge-reranker-base',
            dtype: 'q8',
            estimated_peak_bytes: 796_917_760,
            reserve_bytes: 1_073_741_824,
            execution_provider: 'cpu',
            downgrade_reason: null,
            last_latency_ms: 23,
            enabled: true,
            total_memory_bytes: 68_719_476_736,
            available_memory_bytes: 42_949_672_960,
            cpu_cores: 16,
            active: false,
            queued: 0,
          },
          error: null,
        },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const status = await fetchSemanticGenerations();

    expect(status.rerankers.code.diagnostics).toMatchObject({
      resolved_model: 'Xenova/bge-reranker-base',
      dtype: 'q8',
      execution_provider: 'cpu',
      last_latency_ms: 23,
    });
    expect(status.rerankers.knowledge).toEqual({
      target_kind: 'missing',
      diagnostics: null,
      error: null,
    });
  });
});
