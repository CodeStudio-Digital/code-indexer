import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { CompanyStore } from '@mcp/store/company-store.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';
import { ConcurrencyPolicy } from '@mcp/company/ConcurrencyPolicy.js';
import { SessionContext } from '@mcp/company/services/SessionContext.js';
import {
  spawnSubordinate,
  type SpawnSubordinateDeps,
} from '@mcp/company/services/subordinate/spawn.js';

const mocks = vi.hoisted(() => ({
  runCoder: vi.fn(async (options: {
    session: { id: number };
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
  installDocsDeepResearch: vi.fn(),
}));
vi.mock('@mcp/company/services/subordinate/completion-handler.js', () => ({
  attachSubordinateCompletionHandler: vi.fn(),
}));
vi.mock('@mcp/company/services/subordinate/runner-wiring.js', () => ({
  wireSubordinateInterceptionsForRunner: vi.fn(),
}));
vi.mock('@mcp/company/services/supervisor/wire-runner-events.js', () => ({
  wireSupervisorToRunner: vi.fn(() => () => undefined),
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
  let dbPath: string;
  let db: CodeIndexDB;
  let companyStore: CompanyStore;
  let sessionStore: SessionStore;
  let previousDbPath: string | undefined;

  beforeEach(() => {
    mocks.runCoder.mockClear();
    dir = mkdtempSync(join(tmpdir(), 'mcp-app-role-runtime-'));
    dbPath = join(dir, 'test.db');
    previousDbPath = process.env.MCP_INDEX_DB;
    process.env.MCP_INDEX_DB = dbPath;
    db = new CodeIndexDB(dbPath);
    companyStore = new CompanyStore(dbPath);
    sessionStore = new SessionStore(dbPath);
  });

  afterEach(() => {
    companyStore.close();
    sessionStore.close();
    db.close();
    if (previousDbPath === undefined) delete process.env.MCP_INDEX_DB;
    else process.env.MCP_INDEX_DB = previousDbPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists backend and frontend configured models even when the caller requests the global mini override', async () => {
    const project = db.createProject('app', join(dir, 'app'));
    const team = companyStore.createCompanySession({
      name: 'App team',
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
          { provider: 'openai-chatgpt', model: 'gpt-5.4-mini', is_default: true },
        ],
      }),
    });
    companyStore.addProjectToCompanySession(team.id, project.id);

    const masterCoder = sessionStore.createSession({
      project_id: project.id,
      title: 'App Master',
      provider: 'openai-chatgpt',
      model: 'gpt-5.6-terra',
      agent: 'app_orchestrator',
    });
    companyStore.setMasterSessionId(team.id, masterCoder.id);
    companyStore.createAgentRun({
      company_session_id: team.id,
      role: 'master',
      coder_session_id: masterCoder.id,
      project_ids: [project.id],
      provider: 'openai-chatgpt',
      model: 'gpt-5.6-terra',
      configured_provider: 'openai-chatgpt',
      configured_model: 'gpt-5.6-terra',
      dispatch_source: 'app_studio',
    });

    const ctx = new SessionContext({
      companySessionId: team.id,
      companyStore,
      db,
      metaBus: { ended: false } as never,
      runtimeKind: 'app_studio',
      appStudioSessionId: 77,
    });
    const runningIds = new Set<number>();
    const subordinates = new Map();
    const deps = {
      ctx,
      board: { post: vi.fn() },
      status: { publishStatus: vi.fn() },
      kanban: {},
      master: { handle: null },
      humanInLoop: {},
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

    const runs = companyStore.listAgentRuns(team.id);
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
    expect(mocks.runCoder.mock.calls.map(([options]) => options.profile)).toEqual(['full', 'full']);
  });
});
