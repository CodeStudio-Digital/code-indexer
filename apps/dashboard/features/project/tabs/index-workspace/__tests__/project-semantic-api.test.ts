import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  codeNamespaceStatus,
  fetchProjectSemanticStatus,
  requestProjectSemanticReindex,
  semanticCoveragePercent,
  semanticWorkIsActive,
  type ProjectSemanticStatus,
} from '../project-semantic-api.js';

function status(overrides: Partial<ProjectSemanticStatus> = {}): ProjectSemanticStatus {
  return {
    project_id: 91,
    profiles: [{ purpose: 'code', embedding_target: { kind: 'onnx' } }],
    namespaces: [{
      namespace: 'code:p91',
      active: null,
      building: null,
      expected_items: 10,
      indexed_items: 4,
      failed_items: 0,
      delta_items: 0,
      last_error: null,
    }],
    reindex_job: null,
    ...overrides,
  };
}

describe('project semantic API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('opening the surface only reads status and never starts indexing', async () => {
    const payload = status();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchProjectSemanticStatus(91)).resolves.toEqual(payload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/91/semantic/status');
  });

  it('starts only the selected project after an explicit action', async () => {
    const job = {
      id: 12,
      status: 'pending' as const,
      expected_items: 10,
      processed_items: 0,
      failed_items: 0,
      error: null,
      updated_at: '2026-07-15 10:00:00',
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, job }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestProjectSemanticReindex(91, 'start')).resolves.toEqual(job);
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/91/semantic/reindex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    });
  });

  it('treats only a running job as active work', () => {
    expect(semanticWorkIsActive(status())).toBe(false);
    expect(semanticWorkIsActive(status({
      namespaces: [{
        ...status().namespaces[0],
        building: { generationId: 2 },
      }],
      reindex_job: null,
    }))).toBe(false);
    expect(semanticWorkIsActive(status({
      reindex_job: {
        id: 12,
        status: 'pending',
        expected_items: 10,
        processed_items: 0,
        failed_items: 0,
        error: null,
        updated_at: 'now',
      },
    }))).toBe(false);
    expect(semanticWorkIsActive(status({
      reindex_job: {
        id: 13,
        status: 'running',
        expected_items: 10,
        processed_items: 2,
        failed_items: 0,
        error: null,
        updated_at: 'now',
      },
    }))).toBe(true);
    expect(semanticWorkIsActive(status({
      namespaces: [{
        ...status().namespaces[0],
        building: { generationId: 2 },
      }],
      reindex_job: {
        id: 12,
        status: 'paused',
        expected_items: 10,
        processed_items: 4,
        failed_items: 1,
        error: 'interrupted by restart',
        updated_at: 'now',
      },
    }))).toBe(false);
    expect(semanticWorkIsActive(status({
      reindex_job: {
        id: 12,
        status: 'completed',
        expected_items: 10,
        processed_items: 10,
        failed_items: 0,
        error: null,
        updated_at: 'now',
      },
    }))).toBe(false);
  });

  it('derives code coverage only from the project namespace', () => {
    const current = status();
    expect(codeNamespaceStatus(current)?.namespace).toBe('code:p91');
    expect(semanticCoveragePercent(codeNamespaceStatus(current))).toBe(40);
  });
});
