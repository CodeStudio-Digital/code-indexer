import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  scaffold: vi.fn(),
  createProject: vi.fn(),
  createTeam: vi.fn(),
}));

vi.mock('@mcp/services/host-scaffold/index.js', () => ({
  scaffoldAppStudioWorkspace: mocks.scaffold,
  slugify: (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'),
}));

vi.mock('@mcp/services/services/projects/index.js', () => ({
  CreateProjectService: class {
    execute(input: unknown) {
      return mocks.createProject(input);
    }
  },
  ProjectError: class ProjectError extends Error {},
}));

vi.mock('@mcp/app-studio/plan/types.js', () => ({
  emptyAppPlan: () => ({ version: 1 }),
}));

vi.mock('@mcp/app-studio/plan/fitness.js', () => ({
  auditAppPlan: () => ({ status: 'pass' }),
}));

vi.mock('../app-team-session.js', () => ({
  createAppTeamSession: mocks.createTeam,
}));

import {
  runAppStudioScaffoldStream,
  type AppStudioCreateInput,
  type AppStudioStreamEvent,
} from '../studio-scaffold.js';

const project = {
  id: 17,
  name: 'Ultra App',
  root_path: 'D:/apps/ultra-app',
};

const appSession = {
  id: 23,
  project_id: project.id,
  company_session_id: null,
  name: project.name,
  app_slug: 'ultra-app',
  stack_profile_id: 'cf-fullstack-v1' as const,
  created_at: '2026-07-18T00:00:00.000Z',
  updated_at: '2026-07-18T00:00:00.000Z',
};

function setup() {
  const setSessionExecutionMode = vi.fn();
  const setSessionReasoningEffort = vi.fn();
  const deps = {
    db: {
      getProjectByName: vi.fn(() => null),
      updateProject: vi.fn(),
      getProject: vi.fn(() => project),
    },
    appStudioStore: {
      createSession: vi.fn(() => appSession),
      savePlanRevision: vi.fn(),
    },
    sessionStore: {
      createSession: vi.fn(() => ({ id: 31 })),
      setSessionExecutionMode,
      setSessionReasoningEffort,
    },
  };
  const events: AppStudioStreamEvent[] = [];
  return {
    deps: deps as unknown as Parameters<typeof runAppStudioScaffoldStream>[0],
    events,
    emit: (event: AppStudioStreamEvent) => events.push(event),
    setSessionExecutionMode,
    setSessionReasoningEffort,
  };
}

function input(patch: Partial<AppStudioCreateInput> = {}): AppStudioCreateInput {
  return {
    name: 'Ultra App',
    provider: 'openai',
    model: 'gpt-5',
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scaffold.mockResolvedValue({
    ok: true,
    targetPath: project.root_path,
    slug: 'ultra-app',
    name: project.name,
    port: 5173,
  });
  mocks.createProject.mockReturnValue(project);
  mocks.createTeam.mockReturnValue({
    app_session: { ...appSession, company_session_id: 41 },
    team: {
      runtime_kind: 'app_studio',
      state: 'ready',
      company_session_id: 41,
      company_status: 'idle',
      master_session_id: 31,
      master_agent_run_id: 43,
    },
  });
});

describe('App Studio creation execution settings', () => {
  it('persists Ultra independently from a provider-native effort', async () => {
    const ctx = setup();

    await runAppStudioScaffoldStream(
      ctx.deps,
      input({ execution_mode: 'ultra', reasoning_effort: ' high ' }),
      ctx.emit,
    );

    expect(ctx.setSessionExecutionMode).toHaveBeenCalledWith(31, 'ultra');
    expect(ctx.setSessionReasoningEffort).toHaveBeenCalledWith(31, 'high');
    expect(ctx.events.at(-1)?.event).toBe('done');
  });

  it('lets an explicit App Studio mode win while stripping the legacy sentinel', async () => {
    const ctx = setup();

    await runAppStudioScaffoldStream(
      ctx.deps,
      input({ execution_mode: 'standard', reasoning_effort: ' UlTrA ' }),
      ctx.emit,
    );

    expect(ctx.setSessionExecutionMode).toHaveBeenCalledWith(31, 'standard');
    expect(ctx.setSessionReasoningEffort).toHaveBeenCalledWith(31, null);
    expect(ctx.setSessionReasoningEffort).not.toHaveBeenCalledWith(31, expect.stringMatching(/ultra/i));
  });

  it('normalizes a legacy Ultra pseudo-effort when execution_mode is absent', async () => {
    const ctx = setup();

    await runAppStudioScaffoldStream(
      ctx.deps,
      input({ reasoning_effort: ' UlTrA ' }),
      ctx.emit,
    );

    expect(ctx.setSessionExecutionMode).toHaveBeenCalledWith(31, 'ultra');
    expect(ctx.setSessionReasoningEffort).toHaveBeenCalledWith(31, null);
  });

  it('persists explicit Standard and the model-default effort for new clients', async () => {
    const ctx = setup();

    await runAppStudioScaffoldStream(ctx.deps, input(), ctx.emit);

    expect(ctx.setSessionExecutionMode).toHaveBeenCalledWith(31, 'standard');
    expect(ctx.setSessionReasoningEffort).toHaveBeenCalledWith(31, null);
  });

  it('rejects an invalid execution mode before scaffolding the workspace', async () => {
    const ctx = setup();

    await runAppStudioScaffoldStream(
      ctx.deps,
      input({ execution_mode: 'turbo' as AppStudioCreateInput['execution_mode'] }),
      ctx.emit,
    );

    expect(mocks.scaffold).not.toHaveBeenCalled();
    expect(ctx.events).toEqual([{
      event: 'error',
      data: { message: 'execution_mode: one of standard|ultra required.' },
    }]);
  });
});
