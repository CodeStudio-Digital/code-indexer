import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import {
  SessionLocator,
  asCompanySessionId,
  type JsonValue,
} from '@mcp/session-storage';
import { createBus } from '@apps/http-api/coder-bus.js';
import { ConcurrencyPolicy } from '@mcp/company/ConcurrencyPolicy.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import { SessionContext } from '@mcp/company/services/SessionContext.js';
import {
  spawnSubordinate,
  type SpawnSubordinateDeps,
} from '@mcp/company/services/subordinate/spawn.js';
import {
  resumeSubordinate,
  type ResumeSubordinateDeps,
} from '@mcp/company/services/subordinate/resume.js';

const mocks = vi.hoisted(() => ({
  installDocsDeepResearch: vi.fn(),
  wireSupervisorToRunner: vi.fn(() => () => undefined),
  runCoder: vi.fn(async (options: {
    session: { id: string };
    profile?: string;
    onRunnerReady?: (runner: unknown) => void;
  }) => {
    const runner = {};
    options.onRunnerReady?.(runner);
    return {
      session: { id: options.session.id },
      runner,
      done: Promise.resolve({ reason: 'completed', usage: {} }),
      indexStatus: { isIndexed: true, mcpAvailable: true },
    };
  }),
}));

vi.mock('@mcp/code-agent/index.js', () => ({ runCoder: mocks.runCoder }));
vi.mock('@mcp/docs-agent/bridges/docs-bridge.js', () => ({
  getReadyDocsResearchTools: vi.fn(() => []),
  installDocsDeepResearch: mocks.installDocsDeepResearch,
}));
vi.mock('@mcp/company/services/subordinate/completion-handler.js', () => ({
  attachSubordinateCompletionHandler: vi.fn(),
}));
vi.mock('@mcp/company/services/subordinate/runner-wiring.js', () => ({
  wireSubordinateInterceptionsForRunner: vi.fn(),
}));
vi.mock('@mcp/company/services/supervisor/wire-runner-events.js', () => ({
  wireSupervisorToRunner: mocks.wireSupervisorToRunner,
}));
vi.mock('@mcp/company/services/supervisor/global.js', () => ({
  getGlobalAgentSupervisor: vi.fn(() => null),
}));
vi.mock('@mcp/company/services/memory/ports.js', () => ({
  getCompanyMemoryPorts: vi.fn(() => null),
}));
vi.mock('@mcp/company/services/memory/spawn-injection.js', () => ({
  fetchProjectMemoryBlock: vi.fn(async () => ''),
  fetchUserMemoryBlock: vi.fn(async () => ''),
}));

describe('App Studio authoritative role runtime acceptance', () => {
  let dir: string;
  let project: { id: number; name: string; root_path: string };
  let companyFiles: CompanySessionFiles;

  beforeEach(async () => {
    mocks.runCoder.mockClear();
    mocks.installDocsDeepResearch.mockClear();
    mocks.wireSupervisorToRunner.mockClear();
    dir = mkdtempSync(join(tmpdir(), 'mcp-app-role-runtime-'));
    const dataDir = join(dir, 'data');
    const projectRoot = join(dir, 'app');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    project = { id: 7, name: 'app', root_path: projectRoot };
    const locator = new SessionLocator({
      dataDir,
      projectRootResolver: {
        resolveProjectRoot: (projectId) =>
          projectId === project.id ? project.root_path : null,
        listProjectRoots: () => [{
          project_id: project.id,
          root_path: project.root_path,
        }],
      },
    });
    const sessionStore = new FsSessionStore({ locator });
    const company = await sessionStore.repository.createSession({
      kind: 'app_studio',
      scope: { kind: 'global' },
      owner_project_id: project.id,
      linked_projects: [{
        project_id: project.id,
        root_path: project.root_path,
      }],
      title: 'App team',
      status: 'idle',
      metadata: {
        company: {
          name: 'App team',
          template_id: null,
          runtime_kind: 'app_studio',
          config_json: JSON.stringify({
            runtime_kind: 'app_studio',
            master_provider: 'openai-chatgpt',
            master_model: 'gpt-5.6-terra',
            role_assignments: [
              {
                role: 'backend',
                enabled: true,
                provider: 'openai-chatgpt',
                model: 'gpt-5.6-sol',
                readOnly: true,
                tier: 'full',
                projectIds: [project.id],
              },
              {
                role: 'frontend',
                enabled: true,
                provider: 'openai-chatgpt',
                model: 'gpt-5.6-luna',
                tier: 'full',
                projectIds: [project.id],
              },
            ],
            allowed_models: [
              { provider: 'openai-chatgpt', model: 'gpt-5.6-terra' },
              { provider: 'openai-chatgpt', model: 'gpt-5.6-sol' },
              { provider: 'openai-chatgpt', model: 'gpt-5.6-luna' },
              {
                provider: 'openai-chatgpt',
                model: 'gpt-5.4-mini',
                is_default: true,
              },
            ],
          }),
          master_session_id: null,
          project_labels: { [project.id]: 'app' },
          recovered_at: null,
          recovered_reason: null,
        },
      } as unknown as Record<string, JsonValue>,
    });
    await sessionStore.refresh();
    companyFiles = new CompanySessionFiles({
      companySessionId: asCompanySessionId(company.session.id),
      sessionStore,
    });

    const masterCoder = await sessionStore.createSession({
      project_id: project.id,
      title: 'App Master',
      provider: 'openai-chatgpt',
      model: 'gpt-5.6-terra',
      agent: 'app_orchestrator',
      metadata: {
        company_session_id: company.session.id,
        companySessionId: company.session.id,
      },
    });
    await companyFiles.setMasterSessionId(masterCoder.id);
    await companyFiles.createAgentRun({
      role: 'master',
      coder_session_id: masterCoder.id,
      project_ids: [project.id],
      provider: 'openai-chatgpt',
      model: 'gpt-5.6-terra',
      configured_provider: 'openai-chatgpt',
      configured_model: 'gpt-5.6-terra',
      dispatch_source: 'app_studio',
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists backend and frontend configured models even when the caller requests the global mini override', async () => {
    const ctx = new SessionContext({
      companySessionId: companyFiles.companySessionId,
      companyFiles,
      companyStore: {} as never,
      db: {
        getProject: (projectId: number) =>
          projectId === project.id ? project : null,
      } as never,
      metaBus: createBus(new AbortController()),
      runtimeKind: 'app_studio',
      appStudioSessionId: '00000000-0000-4000-8000-000000000077',
    });
    const runningIds = new Set<string>();
    const subordinates = new Map();
    const deps = {
      ctx,
      board: { post: vi.fn() },
      status: { publishStatus: vi.fn() },
      kanban: {},
      master: { handle: null },
      humanInLoop: { clearForAgent: vi.fn() },
      wirer: { wire: vi.fn() },
      attention: {},
      orchestratorRef: {},
      concurrencyPolicy: new ConcurrencyPolicy({ maxConcurrent: 4 }),
      subordinates,
      runningIds,
      pendingSpawns: { count: 0 },
      notifyIdleChanged: vi.fn(),
      wireDeps: { humanInLoop: {}, wirer: { wire: vi.fn() } },
      completionDeps: {},
      listRunning: () => [],
      autonomy: { get: () => ({ maxSubordinates: 8 }) },
    } as unknown as SpawnSubordinateDeps;

    for (const role of ['backend', 'frontend']) {
      await spawnSubordinate({
        role,
        task: `Implement ${role}`,
        projectId: project.id,
        // This is the old/global subagent target trying to force the mini.
        // The persisted App role assignment must remain authoritative.
        provider: 'openai-chatgpt',
        model: 'gpt-5.4-mini',
        tier: 'bootstrap',
        dispatchSource: 'app_studio',
      }, deps);
    }

    const runs = await companyFiles.listAgentRuns();
    const master = runs.find((run) => run.role === 'master');
    const specialists = runs.filter((run) => run.role !== 'master');

    expect(master).toMatchObject({
      model: 'gpt-5.6-terra',
      configured_model: 'gpt-5.6-terra',
      dispatch_source: 'app_studio',
      fallback_reason: null,
    });
    expect(specialists.map((run) => ({
      role: run.role,
      configured: `${run.configured_provider}/${run.configured_model}`,
      effective: `${run.provider}/${run.model}`,
      source: run.dispatch_source,
      fallback: run.fallback_reason,
    }))).toEqual([
      {
        role: 'backend',
        configured: 'openai-chatgpt/gpt-5.6-sol',
        effective: 'openai-chatgpt/gpt-5.6-sol',
        source: 'app_studio',
        fallback: null,
      },
      {
        role: 'frontend',
        configured: 'openai-chatgpt/gpt-5.6-luna',
        effective: 'openai-chatgpt/gpt-5.6-luna',
        source: 'app_studio',
        fallback: null,
      },
    ]);
    expect(specialists.some((run) => run.model === 'gpt-5.4-mini')).toBe(false);
    expect(mocks.runCoder.mock.calls[0][0]).toMatchObject({agent:'explore'});
    expect(mocks.runCoder.mock.calls.map(([options]) => options.profile)).toEqual(['full', 'full']);
  });

  it('reinstalls supervisor and docs observers when resuming the same subordinate', async () => {
    const coder = await companyFiles.sessionStore.createSession({
      project_id: project.id,
      title: 'Admin specialist',
      provider: 'openai-chatgpt',
      model: 'gpt-5.6-sol',
      agent: 'build',
      metadata: {
        company_session_id: companyFiles.companySessionId,
        companySessionId: companyFiles.companySessionId,
      },
    });
    const run = await companyFiles.createAgentRun({
      role: 'backend',
      coder_session_id: coder.id,
      project_ids: [project.id],
      provider: 'openai-chatgpt',
      model: 'gpt-5.6-sol',
      configured_provider: 'openai-chatgpt',
      configured_model: 'gpt-5.6-sol',
      dispatch_source: 'app_studio',
    });
    await companyFiles.updateAgentRunStatus(run.id, 'waiting');
    const ctx = new SessionContext({
      companySessionId: companyFiles.companySessionId,
      companyFiles,
      companyStore: {} as never,
      db: {
        getProject: (projectId: number) =>
          projectId === project.id ? project : null,
      } as never,
      metaBus: createBus(new AbortController()),
      runtimeKind: 'app_studio',
      appStudioSessionId: '00000000-0000-4000-8000-000000000077',
    });
    const deps = {
      ctx,
      board: { post: vi.fn() },
      status: { setStatus: vi.fn(), publishStatus: vi.fn() },
      master: { notify: vi.fn() },
      humanInLoop: { clearForAgent: vi.fn() },
      wirer: { wire: vi.fn() },
      orchestratorRef: {},
      subordinates: new Map(),
      runningIds: new Set(),
      notifyIdleChanged: vi.fn(),
      wireDeps: { humanInLoop: {}, wirer: { wire: vi.fn() } },
      completionDeps: {},
    } as unknown as ResumeSubordinateDeps;

    await resumeSubordinate(
      run.id,
      'Continue the admin task',
      undefined,
      undefined,
      undefined,
      deps,
    );

    expect(mocks.installDocsDeepResearch).toHaveBeenCalledOnce();
    expect(mocks.wireSupervisorToRunner).toHaveBeenCalledWith(
      expect.anything(),
      run.id,
    );
  });
});
