import { describe, expect, it, vi } from 'vitest';
import type { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/fs-session-store.js';
import type { SessionContext } from '../SessionContext.js';
import { createCompanyCoderSession } from '../company-coder-sessions.js';

const COMPANY_ID = '10000000-0000-4000-8000-000000000001';

function context(): SessionContext {
  return {
    companySessionId: COMPANY_ID,
    runtimeKind: 'company',
    projects: [
      { project_id: 184, label: 'backend' },
      { project_id: 185, label: 'frontend' },
      { project_id: 186, label: 'admin' },
    ],
  } as unknown as SessionContext;
}

describe('createCompanyCoderSession', () => {
  it('links the complete role scope and keeps the requested project primary', async () => {
    const created = { id: 'coder-session' };
    const createGlobalSession = vi.fn().mockResolvedValue(created);
    const sessionStore = {
      createGlobalSession,
    } as unknown as FsSessionStore;

    const result = await createCompanyCoderSession({
      ctx: context(),
      sessionStore,
      title: 'multi-project architect',
      provider: 'zai',
      model: 'glm-5.1',
      role: 'architect',
      projectId: 186,
      projectIds: [184, 185, 186],
    });

    expect(result).toBe(created);
    expect(createGlobalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        owner_project_id: 186,
        realProjects: [
          { projectId: 186, isPrimary: true, label: 'admin' },
          { projectId: 184, isPrimary: false, label: 'backend' },
          { projectId: 185, isPrimary: false, label: 'frontend' },
        ],
      }),
    );
  });

  it('rejects project ids outside the Company session', async () => {
    const sessionStore = {
      createGlobalSession: vi.fn(),
    } as unknown as FsSessionStore;

    await expect(
      createCompanyCoderSession({
        ctx: context(),
        sessionStore,
        title: 'invalid scope',
        provider: 'zai',
        model: 'glm-5.2',
        role: 'qa',
        projectIds: [184, 999],
      }),
    ).rejects.toThrow(/not linked.*999/i);
  });
});
