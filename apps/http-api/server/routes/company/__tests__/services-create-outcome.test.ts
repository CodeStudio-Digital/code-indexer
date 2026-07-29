import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerDeps } from '../../../deps.js';

const H = vi.hoisted(() => ({
  getActive: vi.fn(),
  evict: vi.fn(async (): Promise<void> => undefined),
  getSession: vi.fn(),
  addLinkedProject: vi.fn(async (_input: unknown): Promise<void> => undefined),
  removeLinkedProject: vi.fn(async (_projectId: number): Promise<void> => undefined),
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
vi.mock('@mcp/company/services/CompanySessionFiles.js', () => ({
  CompanySessionFiles: class {
    getSession() { return H.getSession(); }
    addLinkedProject(input: unknown) { return H.addLinkedProject(input); }
    removeLinkedProject(projectId: number) {
      return H.removeLinkedProject(projectId);
    }
  },
}));

const { mountCompanyServicesCreateRoutes } = await import('../services-create.js');

const COMPANY_SESSION_ID = '00000000-0000-4000-8000-000000000007';

describe('company service creation worker outcome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.evict.mockResolvedValue(undefined);
    H.getSession.mockReturnValue({
      id: COMPANY_SESSION_ID,
      config_json: '{}',
      parent_session_id: null,
    });
  });

  it('preserves the project/workdir when provisioning times out after a possible effect', async () => {
    const addSandboxService = vi.fn(async () => {
      throw { code: 'request_timeout', message: 'provision acknowledgement timed out' };
    });
    H.getActive.mockReturnValue({ addSandboxService });

    const companyStore = {
      getCompanySession: vi.fn(() => ({
        id: COMPANY_SESSION_ID,
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
      sessionStore: { ensureCatalog: vi.fn(async () => {}) },
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

    const response = await app.request(
      `/api/company/sessions/${COMPANY_SESSION_ID}/services`,
      {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        service_id: 'web',
        stack: 'react-ts',
        name: 'Web',
      }),
      },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      service_id: 'web',
      project_id: 41,
    });
    expect(addSandboxService).toHaveBeenCalledOnce();
    expect(H.evict).toHaveBeenCalledWith(COMPANY_SESSION_ID);
    expect(H.addLinkedProject).toHaveBeenCalledWith({
      projectId: 41,
      rootPath: expect.any(String),
      label: 'web',
    });
    expect(H.removeLinkedProject).not.toHaveBeenCalled();
    expect(db.deleteProject).not.toHaveBeenCalled();
    expect(H.rm).not.toHaveBeenCalled();
  });
});
