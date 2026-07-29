import { describe, expect, it, vi } from 'vitest';
import { asSessionId } from '@mcp/agent-runtime-contracts';
import type { ServerDeps } from '../../../deps.js';
import {
  attachProjectToGlobalSession,
  createGlobalWorkspaceSession,
  detachProjectFromGlobalSession,
  reuseGlobalWorkspaceSession,
} from '../global-workspace.js';

const SOURCE_ID = asSessionId('11111111-1111-4111-8111-111111111111');
const CREATED_ID = asSessionId('22222222-2222-4222-8222-222222222222');

function globalSession(id = SOURCE_ID) {
  return {
    id,
    is_global: true,
    project_id: 7,
    title: 'Global',
  };
}

describe('global filesystem session lifecycle', () => {
  it('creates a global bundle over real roots without a synthetic project', async () => {
    const createGlobalSession = vi.fn(async () => globalSession(CREATED_ID));
    const ensureFresh = vi.fn();
    const createProject = vi.fn();
    const deps = {
      db: { createProject },
      sessionStore: { createGlobalSession },
      projectIndexService: { ensureFresh },
    } as unknown as ServerDeps;

    const created = await createGlobalWorkspaceSession(deps, {
      title: 'Cross repo',
      provider: 'openai',
      model: 'gpt-test',
      projects: [
        { id: 8, name: 'Beta', root_path: 'D:\\beta', isPrimary: false },
        { id: 7, name: 'Alpha', root_path: 'D:\\alpha', isPrimary: true },
      ],
    });

    expect(created.id).toBe(CREATED_ID);
    expect(createGlobalSession).toHaveBeenCalledWith(expect.objectContaining({
      owner_project_id: 7,
      realProjects: [
        expect.objectContaining({ projectId: 7, isPrimary: true }),
        expect.objectContaining({ projectId: 8, isPrimary: false }),
      ],
    }));
    expect(createProject).not.toHaveBeenCalled();
    expect(ensureFresh).toHaveBeenCalledWith(7, 'session');
    expect(ensureFresh).toHaveBeenCalledWith(8, 'session');
  });

  it('reuses linked roots from a source session UUID', async () => {
    const createGlobalSession = vi.fn(async () => globalSession(CREATED_ID));
    const deps = {
      db: {
        getProject: (id: number) => ({
          id,
          name: id === 7 ? 'Alpha' : 'Beta',
          root_path: id === 7 ? 'D:\\alpha' : 'D:\\beta',
          is_synthetic: false,
        }),
      },
      sessionStore: {
        getSession: vi.fn(async () => globalSession()),
        getSessionProjects: vi.fn(async () => [
          {
            project_id: 7,
            name: 'Alpha',
            root_path: 'D:\\stale-alpha',
            is_primary: true,
            label: null,
          },
          {
            project_id: 8,
            name: 'Beta',
            root_path: 'D:\\stale-beta',
            is_primary: false,
            label: null,
          },
        ]),
        createGlobalSession,
      },
      projectIndexService: { ensureFresh: vi.fn() },
    } as unknown as ServerDeps;

    await reuseGlobalWorkspaceSession(deps, {
      reuseSessionId: SOURCE_ID,
      title: 'Fresh conversation',
      provider: 'openai',
      model: 'gpt-test',
    });

    expect(deps.sessionStore.getSession).toHaveBeenCalledWith(SOURCE_ID);
    expect(createGlobalSession).toHaveBeenCalledWith(expect.objectContaining({
      owner_project_id: 7,
      realProjects: [
        expect.objectContaining({
          projectId: 7,
          rootPath: 'D:\\alpha',
          isPrimary: true,
        }),
        expect.objectContaining({
          projectId: 8,
          rootPath: 'D:\\beta',
          isPrimary: false,
        }),
      ],
    }));
  });

  it('mutates only the bundle link set and protects the primary project', async () => {
    const linkSessionProject = vi.fn(async () => [
      { project_id: 7, is_primary: true },
      { project_id: 8, is_primary: false },
    ]);
    const deps = {
      db: {
        getProject: () => ({
          id: 8,
          name: 'Beta',
          root_path: 'D:\\beta',
          is_synthetic: false,
        }),
      },
      sessionStore: {
        getSession: vi.fn(async () => globalSession()),
        getSessionProjects: vi.fn(async () => [
          {
            project_id: 7,
            name: 'Alpha',
            root_path: 'D:\\alpha',
            is_primary: true,
            label: null,
          },
        ]),
        linkSessionProject,
      },
      projectIndexService: { ensureFresh: vi.fn() },
    } as unknown as ServerDeps;

    await attachProjectToGlobalSession(deps, SOURCE_ID, 8);
    expect(linkSessionProject).toHaveBeenCalledWith(SOURCE_ID, {
      project_id: 8,
      name: 'Beta',
      root_path: 'D:\\beta',
    });
    await expect(
      detachProjectFromGlobalSession(deps, SOURCE_ID, 7),
    ).rejects.toThrow('primary project');
  });
});
