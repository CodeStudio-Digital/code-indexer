import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpRouter } from '@mcp/shared/http/router.js';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerDeps } from '../../deps.js';
import { mountHygieneRoutes } from '../hygiene.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

afterEach(() => { vi.mocked(fs.stat).mockReset(); vi.restoreAllMocks(); });

function makeApp(rootPath = join(tmpdir(), `missing-hygiene-${randomUUID()}`)) {
  const project = {
    id: 1,
    name: 'project',
    root_path: rootPath,
    file_count: 1,
    vector_count: 1,
    orphan_semantic_items: 1,
    stale_runs: 0,
    mixed_case_languages: 0,
  };
  const deleteProject = vi.fn();
  const db = {
    getProjectsHygiene: vi.fn(() => [project]),
    getProjectTierBreakdown: () => [],
    getProject: vi.fn((id: number) => id === project.id ? project : null),
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
  const projectIndexService = { stopWatching: vi.fn(async () => {}), restartFileWatching: vi.fn() };
  const semanticStore = {
    listNamespaceGenerations: ({ namespace }: { namespace: string }) => namespace === 'code:p1' ? [{ active_generation_id: 1 }] : [],
    listItems: () => [{}],
  };
  const app = new HttpRouter();
  mountHygieneRoutes(app, { db, vectorStore, semanticCoordinator, projectIndexService, semanticStore } as unknown as ServerDeps);
  return { app, db, project, deleteProject, removeProject, projectIndexService };
}

function purge(app: HttpRouter, projectIds: unknown = [1], confirm: unknown = true) {
  return app.request('/api/hygiene/projects/purge', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectIds, confirm }),
  });
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
    const { app, deleteProject, removeProject, projectIndexService } = makeApp();
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
    expect(projectIndexService.stopWatching).toHaveBeenCalledWith(1);
  });

  it.each([[0], [1, 0], [-1], [1.5], ['1'], [null]].map(ids => ({ ids })))('rejects invalid or reserved IDs before any removal: $ids', async ({ ids }) => {
    const { app, deleteProject, removeProject } = makeApp();
    expect((await purge(app, ids)).status).toBe(400);
    expect(deleteProject).not.toHaveBeenCalled();
    expect(removeProject).not.toHaveBeenCalled();
  });

  it('requires explicit boolean confirmation and returns a complete empty result', async () => {
    const { app, removeProject } = makeApp();
    expect((await purge(app, [1], 'true')).status).toBe(400);
    expect((await purge(app, {})).status).toBe(400);
    expect((await purge(app, null)).status).toBe(400);
    expect(await (await purge(app, [])).json()).toEqual({ ok: true, purged: 0, summaries: [] });
    expect(removeProject).not.toHaveBeenCalled();
  });

  it('deduplicates the batch and reports only successful removals', async () => {
    const { app, removeProject } = makeApp();
    const result = await (await purge(app, [1, 1, 99])).json();
    expect(result).toMatchObject({ ok: false, purged: 1 });
    expect(result.summaries).toHaveLength(2);
    expect(result.summaries[0]).toMatchObject({ project_id: 1, purged: true });
    expect(result.summaries[1]).toMatchObject({ project_id: 99, purged: false, vectors_deleted: 0 });
    expect(removeProject).toHaveBeenCalledTimes(1);
  });

  it('does not report success when semantic cleanup fails', async () => {
    const { app, deleteProject, removeProject } = makeApp();
    removeProject.mockRejectedValueOnce(new Error('SYNTHETIC_VECTOR_LOCK'));
    const result = await (await purge(app)).json();
    expect(result).toMatchObject({ ok: false, purged: 0, summaries: [{ purged: false, vectors_deleted: 0 }] });
    expect(result.summaries[0].vector_error).toContain('SYNTHETIC_VECTOR_LOCK');
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it('preserves a directory restored after the panel snapshot', async () => {
    const { app, removeProject } = makeApp(process.cwd());
    const result = await (await purge(app)).json();
    expect(result).toMatchObject({ ok: false, purged: 0 });
    expect(result.summaries[0].vector_error).toContain('directory exists');
    expect(removeProject).not.toHaveBeenCalled();
  });

  it('distinguishes an inaccessible directory from a missing one', async () => {
    vi.mocked(fs.stat).mockRejectedValue(Object.assign(new Error('SYNTHETIC_ACCESS_DENIED'), { code: 'EACCES' }));
    const { app, removeProject } = makeApp();
    const status = await (await app.request('/api/hygiene/status')).json();
    expect(status.projects[0]).toMatchObject({ missing_on_disk: false, disk_error: 'SYNTHETIC_ACCESS_DENIED' });
    const result = await (await purge(app)).json();
    expect(result).toMatchObject({ ok: false, purged: 0 });
    expect(removeProject).not.toHaveBeenCalled();
  });

  it('refuses cleanup of hidden projects even when a stale caller supplies their ID', async () => {
    const { app, db, removeProject } = makeApp();
    db.getProjectsHygiene.mockReturnValue([]);
    expect((await app.request('/api/hygiene/projects/1/cleanup', { method: 'POST' })).status).toBe(404);
    expect(await (await purge(app)).json()).toMatchObject({ ok: false, purged: 0 });
    expect(removeProject).not.toHaveBeenCalled();
  });
});
