/**
 * B7 — handler-level tests for the qa_start_run gates (plan gate,
 * config contract, browser preflight) using fakes: sandbox manager,
 * workspace restore and preflight are mocked so no container/DB/network
 * is touched. The plan-gate DECISION core has its own pure suite in
 * `qa-plan-gate.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  readWorkspaceFile: vi.fn(async (): Promise<string | null> => null),
  preflightBrowser: vi.fn(async () => ({
    ok: true as boolean,
    source: 'chrome_service' as const,
    attempts: 1,
    breakerOpen: false,
    message: 'Chrome Service healthy.',
    wsEndpoint: 'ws://host.docker.internal:9223/',
  })),
  restoreQaWorkspace: vi.fn(async () => ({
    runConfigWritten: true,
    reporterRestored: true,
    globalSetupRestored: true,
    configMissing: [],
    configRecommendations: [],
    configRecommendedWritten: false,
    prunedRunDirs: [],
    wipedSandboxDirs: [],
    warnings: [],
  })),
}));

vi.mock('@mcp/services/sandbox/index.js', () => ({
  getSandboxManager: () => ({ readWorkspaceFile: mocks.readWorkspaceFile }),
  getResolvedRuntime: () => 'docker',
}));

vi.mock('@mcp/services/qa/workspace-restore.js', () => ({
  restoreQaWorkspace: mocks.restoreQaWorkspace,
  renderRunConfigFile: (runId: string | number, endpoint: string) =>
    JSON.stringify({ runId: String(runId), endpoint }),
}));

vi.mock('../qa-preflight.js', () => ({
  preflightBrowser: mocks.preflightBrowser,
}));

import { qaStartRun, setQaTestRunStore } from '../qa-start-run.js';
import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

/** qa_start_run ignores the ToolContext — a minimal stub satisfies the signature. */
const CTX = { cwd: 'D:/tmp', projectName: 'test' } as ToolContext;

const QA_CONFIG = JSON.stringify({
  role_assignments: [{ role: 'qa', skills: ['qa-playwright'] }],
});

function makeOrchestrator(approval: { approved: boolean; auto: boolean } | null) {
  return {
    companySessionId: 11,
    getSessionConfigJson: () => QA_CONFIG,
    hasApprovedPlan: vi.fn(() => approval),
  } as unknown as CompanyOrchestrator;
}

function makeStore() {
  const startRun = vi.fn((input: Record<string, unknown>) => ({
    id: 99,
    suite: input.suite,
    service_id: input.service_id ?? 'main',
    plan_gate: input.plan_gate ?? null,
  }));
  return { store: { startRun } as never, startRun };
}

const savedEnv = process.env.MCP_QA_REQUIRE_PLAN;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.MCP_QA_REQUIRE_PLAN;
  mocks.readWorkspaceFile.mockResolvedValue(null);
});

afterEach(() => {
  setQaTestRunStore(null);
  if (savedEnv === undefined) delete process.env.MCP_QA_REQUIRE_PLAN;
  else process.env.MCP_QA_REQUIRE_PLAN = savedEnv;
});

describe('qa_start_run — plan gate', () => {
  it('refuses a QA subordinate without an approved plan (no row created)', async () => {
    const { store, startRun } = makeStore();
    setQaTestRunStore(store);
    const tool = qaStartRun(makeOrchestrator(null), 'qa', 42);
    const result = await tool.handler({ suite: 'login' }, CTX);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('submit_plan_to_master');
    expect(startRun).not.toHaveBeenCalled();
    expect(mocks.preflightBrowser).not.toHaveBeenCalled(); // gate runs FIRST
  });

  it('persists plan_gate=auto for a fast-path approval', async () => {
    const { store, startRun } = makeStore();
    setQaTestRunStore(store);
    const tool = qaStartRun(makeOrchestrator({ approved: true, auto: true }), 'qa', 42);
    const result = await tool.handler({ suite: 'login' }, CTX);
    expect(result.isError).toBeUndefined();
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ plan_gate: 'auto' }));
  });

  it('persists plan_gate=approved for a manual approval', async () => {
    const { store, startRun } = makeStore();
    setQaTestRunStore(store);
    const tool = qaStartRun(makeOrchestrator({ approved: true, auto: false }), 'qa', 42);
    await tool.handler({ suite: 'login' }, CTX);
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ plan_gate: 'approved' }));
  });

  it("MCP_QA_REQUIRE_PLAN=0 disables the gate → plan_gate='skipped'", async () => {
    process.env.MCP_QA_REQUIRE_PLAN = '0';
    const { store, startRun } = makeStore();
    setQaTestRunStore(store);
    const tool = qaStartRun(makeOrchestrator(null), 'qa', 42);
    const result = await tool.handler({ suite: 'login' }, CTX);
    expect(result.isError).toBeUndefined();
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ plan_gate: 'skipped' }));
  });

  it('master caller (agentRunId=null) is not gated → plan_gate=null', async () => {
    const { store, startRun } = makeStore();
    setQaTestRunStore(store);
    const tool = qaStartRun(makeOrchestrator(null), 'master', null);
    const result = await tool.handler({ suite: 'smoke' }, CTX);
    expect(result.isError).toBeUndefined();
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ plan_gate: null }));
  });
});

describe('qa_start_run — config + preflight gates (no orphan rows)', () => {
  it('refuses when playwright.config.ts breaks the contract', async () => {
    mocks.readWorkspaceFile.mockResolvedValue('export default {}');
    const { store, startRun } = makeStore();
    setQaTestRunStore(store);
    const tool = qaStartRun(makeOrchestrator({ approved: true, auto: true }), 'qa', 42);
    const result = await tool.handler({ suite: 'login' }, CTX);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('config_invalid');
    expect(startRun).not.toHaveBeenCalled();
  });

  it('refuses typed when the browser preflight fails', async () => {
    mocks.preflightBrowser.mockResolvedValueOnce({
      ok: false,
      source: 'chrome_service',
      attempts: 4,
      breakerOpen: false,
      message: 'Chrome Service did not answer. Ask the operator…',
    } as never);
    const { store, startRun } = makeStore();
    setQaTestRunStore(store);
    const tool = qaStartRun(makeOrchestrator({ approved: true, auto: true }), 'qa', 42);
    const result = await tool.handler({ suite: 'login' }, CTX);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('sidecar_down');
    expect(startRun).not.toHaveBeenCalled();
  });
});
