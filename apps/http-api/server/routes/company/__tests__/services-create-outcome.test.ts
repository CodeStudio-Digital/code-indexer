import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerDeps } from '../../../deps.js';

const H = vi.hoisted(() => ({
  getActive: vi.fn(),
  evict: vi.fn(async (): Promise<void> => undefined),
  mkdirSync: vi.fn(),
  rm: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock('../../../../sse/companyOrchestrator.js', () => ({
  getCompanyOrchestrator: H.getActive,
  evictCompanyOrchestrator: H.evict,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, mkdirSync: H.mkdirSync };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: H.rm };
});

const { mountCompanyServicesCreateRoutes } = await import('../services-create.js');

describe('company service creation worker outcome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.evict.mockResolvedValue(undefined);
  });

  it('preserves the project/workdir when provisioning times out after a possible effect', async () => {
    const addSandboxService = vi.fn(async () => {
      throw { code: 'request_timeout', message: 'provision acknowledgement timed out' };
    });
    H.getActive.mockReturnValue({ addSandboxService });

    const companyStore = {
      getCompanySession: vi.fn(() => ({
        id: 7,
        config_json: '{}',
        parent_session_id: null,
      })),
      addProjectToCompanySession: vi.fn(),
      removeProjectFromCompanySession: vi.fn(),
    };
    const db = {
      createProject: vi.fn(() => ({
        id: 41,
        name: '_builder_test',
        root_path: 'D:\\virtual\\test',
      })),
      getProject: vi.fn(),
      deleteProject: vi.fn(),
    };
    const deps = {
      companyStore,
      db,
      projectIndexService: {
        stopWatching: vi.fn(async () => undefined),
      },
      semanticCoordinator: {
        removeProject: vi.fn(async () => undefined),
      },
    } as unknown as ServerDeps;
    const app = new Hono();
    mountCompanyServicesCreateRoutes(app, deps);

    const response = await app.request('/api/company/sessions/7/services', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        service_id: 'web',
        stack: 'react-ts',
        name: 'Web',
      }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      service_id: 'web',
      project_id: 41,
    });
    expect(addSandboxService).toHaveBeenCalledOnce();
    expect(H.evict).toHaveBeenCalledWith(7);
    expect(companyStore.addProjectToCompanySession).toHaveBeenCalledWith(7, 41, 'web');
    expect(companyStore.removeProjectFromCompanySession).not.toHaveBeenCalled();
    expect(db.deleteProject).not.toHaveBeenCalled();
    expect(H.rm).not.toHaveBeenCalled();
  });
});
