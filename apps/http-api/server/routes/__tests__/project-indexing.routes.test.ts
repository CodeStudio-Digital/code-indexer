import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { mountProjectsRoutes } from '../projects.js';

function makeDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  const jobs = [
    {
      id: 41,
      generation_id: 8,
      namespace: 'code:p7',
      kind: 'backfill',
      status: 'running',
      priority: 20,
      cursor: null,
      expected_items: 100,
      processed_items: 25,
      failed_items: 0,
      error: null,
      created_at: '2026-07-15 00:00:00',
      started_at: '2026-07-15 00:00:00',
      updated_at: '2026-07-15 00:00:01',
      completed_at: null,
    },
  ] as const;
  const deps = {
    db: {
      getProject: (id: number) => id === 7
        ? { id, name: 'demo', root_path: 'D:/demo', is_synthetic: 0 }
        : null,
      listFiles: () => [{ id: 1 }],
    },
    config: { concurrency: 1, ignorePatterns: [], maxFileSize: 256 },
    docStore: { listCollectionsForProject: () => [] },
    projectIndexService: {
      ensureFresh: vi.fn(),
      ensureStructuralReady: vi.fn(async () => ({ status: 'ready', phase: 'ready' })),
      getStatus: vi.fn(() => ({ projectId: 7, phase: 'ready' })),
    },
    semanticStore: {
      listProfiles: vi.fn(() => [{
        purpose: 'code',
        embedding_target: {
          kind: 'onnx', model: 'Xenova/multilingual-e5-small', pooling: 'mean', normalize: true,
          queryTemplate: 'query: {text}', documentTemplate: 'passage: {text}',
        },
        reranker_target: { kind: 'onnx', model: 'auto' },
      }]),
      getProfile: vi.fn(() => ({
        purpose: 'code',
        embedding_target: {
          kind: 'onnx', model: 'Xenova/multilingual-e5-small', pooling: 'mean', normalize: true,
          queryTemplate: 'query: {text}', documentTemplate: 'passage: {text}',
        },
        reranker_target: { kind: 'onnx', model: 'auto' },
      })),
      listJobs: vi.fn(() => [...jobs]),
      getJob: vi.fn((id: number) => jobs.find((job) => job.id === id) ?? null),
      updateJob: vi.fn((_id: number, patch: Record<string, unknown>) => ({ ...jobs[0], ...patch })),
      getGeneration: vi.fn((id: number) => ({
        id,
        purpose: 'code',
        fingerprint: 'pinned-fingerprint',
        embedding_target: {
          kind: 'onnx', model: 'pinned-model', pooling: 'mean', normalize: true,
          queryTemplate: 'query: {text}', documentTemplate: 'passage: {text}',
        },
        dimension: 384,
      })),
    },
    localVectorRouter: {
      getNamespaceStatus: vi.fn((namespace: string) => ({
        namespace,
        purpose: namespace.startsWith('code:') ? 'code' : 'memory',
        dbPath: 'D:/demo/.mcp-indexer/vectors.db',
        size_bytes: 123,
        active: namespace === 'code:p7' ? { generationId: 8 } : null,
        building: null,
        expected_items: 100,
        indexed_items: 25,
        failed_items: 0,
        delta_items: 0,
        last_error: null,
        updated_at: '2026-07-15 00:00:01',
      })),
    },
    semanticProfileRuntime: {
      rerankerDiagnostics: () => ({ model: 'Xenova/bge-reranker-base', dtype: 'q8' }),
    },
    semanticCoordinator: {
      enqueueCodeProjectReindex: vi.fn(() => ({ id: 99, status: 'pending' })),
      resumeJob: vi.fn((id: number) => ({ id, status: 'pending' })),
      catchUpCodeProject: vi.fn(async () => undefined),
      pauseJob: vi.fn((id: number) => ({ id, status: 'paused' })),
      cleanupUnusedVectors: vi.fn(async () => ({
        tables_removed: 2,
        items_removed: 240,
        databases_compacted: 1,
        bytes_reclaimed: 12_582_912,
        skipped_referenced: 1,
        failures: [],
      })),
    },
  } as unknown as ServerDeps;
  return Object.assign(deps, overrides);
}

function appWith(deps: ServerDeps): Hono {
  const app = new Hono();
  mountProjectsRoutes(app, deps);
  return app;
}

describe('project indexing routes', () => {
  it('reports configured, pinned and physical semantic state separately', async () => {
    const response = await appWith(makeDeps()).request('/api/projects/7/semantic/status');
    const body = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      project_id: 7,
      automatic_backfill: { enabled: true, target_kind: 'onnx', reason: 'local_profile' },
      reranker: { model: 'Xenova/bge-reranker-base', dtype: 'q8' },
      generations: [{ id: 8, fingerprint: 'pinned-fingerprint' }],
      jobs: [{ id: 41, namespace: 'code:p7', status: 'running' }],
      reindex_job: { id: 41, namespace: 'code:p7', status: 'running' },
    });
  });

  it('does not expose a paused job from a superseded generation as current project work', async () => {
    const deps = makeDeps();
    vi.mocked(deps.semanticStore.listJobs).mockReturnValue([{
      id: 59,
      generation_id: 7,
      namespace: 'code:p7',
      kind: 'backfill',
      status: 'paused',
      priority: 10,
      cursor: null,
      expected_items: 100,
      processed_items: 100,
      failed_items: 0,
      error: 'interrupted by application restart; waiting for an explicit resume',
      created_at: '2026-07-15 00:00:00',
      started_at: '2026-07-15 00:00:00',
      updated_at: '2026-07-15 00:00:01',
      completed_at: null,
    }]);

    const response = await appWith(deps).request('/api/projects/7/semantic/status');
    const body = await response.json() as { reindex_job: unknown };

    expect(response.status).toBe(200);
    expect(body.reindex_job).toBeNull();
  });

  it('runs the explicit structural reconciliation without a provider', async () => {
    const deps = makeDeps();
    const response = await appWith(deps).request('/api/projects/7/index/structural/reconcile', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    expect(deps.projectIndexService.ensureFresh).toHaveBeenCalledWith(7, 'manual');
    expect(deps.projectIndexService.ensureStructuralReady).toHaveBeenCalledWith(
      7, 180_000, expect.any(AbortSignal),
    );
  });

  it('maps start/resume to catch-up generation and rebuild to replacement generation', async () => {
    const deps = makeDeps();
    const app = appWith(deps);
    for (const [action, force] of [['start', false], ['resume', false], ['rebuild', true]] as const) {
      const response = await app.request('/api/projects/7/semantic/reindex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      expect(response.status).toBe(202);
      expect(deps.semanticCoordinator.enqueueCodeProjectReindex).toHaveBeenLastCalledWith(7, force);
    }
  });

  it('does not resume a paused job owned by an older generation', async () => {
    const deps = makeDeps();
    vi.mocked(deps.semanticStore.listJobs).mockReturnValue([{
      id: 59,
      generation_id: 7,
      namespace: 'code:p7',
      kind: 'backfill',
      status: 'paused',
    } as never]);

    const response = await appWith(deps).request('/api/projects/7/semantic/reindex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'resume' }),
    });

    expect(response.status).toBe(202);
    expect(deps.semanticCoordinator.resumeJob).not.toHaveBeenCalled();
    expect(deps.semanticCoordinator.enqueueCodeProjectReindex).toHaveBeenCalledWith(7, false);
  });

  it('resumes a paused job owned by the active generation', async () => {
    const deps = makeDeps();
    vi.mocked(deps.semanticStore.listJobs).mockReturnValue([{
      id: 60,
      generation_id: 8,
      namespace: 'code:p7',
      kind: 'backfill',
      status: 'paused',
    } as never]);

    const response = await appWith(deps).request('/api/projects/7/semantic/reindex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'resume' }),
    });

    expect(response.status).toBe(202);
    expect(deps.semanticCoordinator.resumeJob).toHaveBeenCalledWith(60);
    expect(deps.semanticCoordinator.enqueueCodeProjectReindex).not.toHaveBeenCalled();
  });

  it('cleans only unused vector generations from the selected project', async () => {
    const deps = makeDeps();
    const response = await appWith(deps).request(
      '/api/projects/7/semantic/vectors/cleanup-unused',
      { method: 'POST' },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: {
        tables_removed: 2,
        databases_compacted: 1,
        skipped_referenced: 1,
      },
    });
    expect(deps.semanticCoordinator.cleanupUnusedVectors).toHaveBeenCalledWith(7);
  });

  it('removes the paid legacy HTTP index routes', async () => {
    const app = appWith(makeDeps());
    expect((await app.request('/api/projects/7/index', { method: 'POST' })).status).toBe(404);
    expect((await app.request('/api/projects/7/index/stream', { method: 'POST' })).status).toBe(404);
    expect((await app.request('/api/projects/7/embeddings/retry/stream', { method: 'POST' })).status).toBe(404);
  });
});
