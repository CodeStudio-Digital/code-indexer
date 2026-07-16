import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { mountHygieneRoutes } from '../hygiene.js';

function makeApp() {
  const project = {
    id: 1,
    name: 'project',
    root_path: process.cwd(),
    file_count: 1,
    vector_count: 1,
    orphan_semantic_items: 1,
    stale_runs: 0,
    mixed_case_languages: 0,
  };
  const deleteProject = vi.fn();
  const db = {
    getProjectsHygiene: () => [project],
    getProjectTierBreakdown: () => [],
    getProject: (id: number) => id === project.id ? project : null,
    getOrphanSemanticItems: () => [{ namespace: 'code:p1', item_key: 'file:1' }],
    normalizeFileLanguages: () => 0,
    markStaleRuns: () => 0,
    deleteProject,
  };
  const vectorStore = {
    isAvailable: async () => true,
    deleteByItemKeys: async () => 1,
  };
  const removeProject = vi.fn(async (
    _projectId: number,
    options?: { finalize?: () => void | Promise<void> },
  ) => {
    await options?.finalize?.();
  });
  const semanticCoordinator = { removeProject };
  const app = new Hono();
  mountHygieneRoutes(app, { db, vectorStore, semanticCoordinator } as unknown as ServerDeps);
  return { app, deleteProject, removeProject };
}

describe('local semantic hygiene routes', () => {
  it('returns local-only cleanup fields and no remote retry endpoint', async () => {
    const { app } = makeApp();

    const status = await (await app.request('/api/hygiene/status')).json() as Record<string, unknown>;
    expect(status).toMatchObject({ vector_store_available: true });
    expect(status).not.toHaveProperty('pending_vector_deletes');

    const cleanupResponse = await app.request('/api/hygiene/projects/1/cleanup', { method: 'POST' });
    const cleanup = await cleanupResponse.json() as Record<string, unknown>;
    expect(cleanup).toMatchObject({
      vectors_deleted_local: 1,
      local_deleted: 1,
      vector_error: null,
    });
    expect(Object.keys(cleanup).some((key) => key.includes('remote'))).toBe(false);

    expect((await app.request('/api/hygiene/vectorize/retry', { method: 'POST' })).status).toBe(404);
  });

  it('uses the local project-vector contract when purging missing projects', async () => {
    const { app, deleteProject, removeProject } = makeApp();
    const response = await app.request('/api/hygiene/projects/purge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectIds: [1], confirm: true }),
    });
    const payload = await response.json() as {
      summaries: Array<Record<string, unknown>>;
    };
    expect(payload.summaries[0]).toMatchObject({
      vectors_known: 1,
      vectors_deleted: 1,
      vector_error: null,
    });
    expect(Object.keys(payload.summaries[0]).some((key) => key.includes('remote'))).toBe(false);
    expect(removeProject).toHaveBeenCalledWith(1, { finalize: expect.any(Function) });
    expect(deleteProject).toHaveBeenCalledWith(1);
    expect(deleteProject).toHaveBeenCalledTimes(1);
  });
});
