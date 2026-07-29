/**
 * service_* tool tests (company B5) — pure fakes for the sandbox manager
 * (via `setSandboxManagerForTests`) and the supervisor store bindings
 * (via `setServiceSupervisorStores`). Covers the authorization matrix
 * (master / own-service / devops skill), the transition audit trail, and
 * the typed manager-error mapping.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { setSandboxManagerForTests } from '@mcp/services/sandbox/sandbox-manager.js';
import type { SandboxManager } from '@mcp/services/sandbox/sandbox-manager.js';
import { setServiceSupervisorStores } from '../../services/service-supervisor/stores.js';
import { serviceTools } from '../service-tools.js';
import { decideServiceControl } from '../service-tools-core.js';

const COMPANY_SESSION_ID = '00000000-0000-4000-8000-000000000007';
const AGENT_RUN_ID = '00000000-0000-4000-8000-000000000001';
const TRANSITION_ID = '00000000-0000-4000-8000-000000000101';
const NEWER_LOG_ID = '00000000-0000-4000-8000-000000000112';
const OLDER_LOG_ID = '00000000-0000-4000-8000-000000000111';

const tool = (name: string) => {
  const t = serviceTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
};

function makeManager(overrides: Record<string, unknown> = {}) {
  return {
    get: vi.fn(() => ({ status: 'ready' })),
    getService: vi.fn(() => ({ status: 'ready' })),
    restartDevServer: vi.fn(async () => undefined),
    restartService: vi.fn(async () => undefined),
    resumeSandbox: vi.fn(async () => undefined),
    startServiceContainer: vi.fn(async () => undefined),
    pauseRuntimeContainer: vi.fn(async () => undefined),
    unpauseRuntimeContainer: vi.fn(async () => undefined),
    ...overrides,
  };
}

function installManager(m: ReturnType<typeof makeManager>): void {
  setSandboxManagerForTests(m as unknown as SandboxManager);
}

function makeStores() {
  const record = vi.fn(() => TRANSITION_ID);
  const listPage = vi.fn(() => [] as Array<{
    id: string;
    seq: number;
    serviceId: string;
    stream: 'devserver' | 'container' | 'scaffold';
    line: string;
    atMs: number;
  }>);
  setServiceSupervisorStores({
    health: { updateHealth: () => true, bumpRestartCount: () => 1 },
    transitions: { record },
    logs: { appendAndTrim: () => undefined, listPage },
  });
  return { record, listPage };
}

function makeCtx(opts: {
  isMaster?: boolean;
  role?: string;
  bound?: string | null;
  skills?: string[];
}): ToolContext {
  return {
    cwd: '/tmp',
    projectName: 'p',
    companyContext: {
      orchestrator: { getRoleDefaults: () => ({ skills: opts.skills ?? [] }) },
      companySessionId: COMPANY_SESSION_ID,
      agentRole: opts.role ?? 'dev',
      agentRunId: AGENT_RUN_ID,
      allowedProjectIds: [],
      isMaster: opts.isMaster ?? false,
      sandbox: opts.bound
        ? { serviceId: opts.bound, containerId: 'c1', workdir: '/app', previewUrl: '', driver: {} }
        : undefined,
    },
  } as unknown as ToolContext;
}

afterEach(() => {
  setSandboxManagerForTests(null);
  setServiceSupervisorStores(null);
});

describe('decideServiceControl (pure gate)', () => {
  const base = { isMaster: false, agentRole: 'dev', boundServiceId: null, roleSkills: [] as string[] };
  it('master always may', () => {
    expect(decideServiceControl({ ...base, isMaster: true, agentRole: 'master' }, 'api')).toMatchObject({ allowed: true, actor: 'master' });
  });
  it('subordinate may control its own service only', () => {
    expect(decideServiceControl({ ...base, boundServiceId: 'api' }, 'api').allowed).toBe(true);
    const denied = decideServiceControl({ ...base, boundServiceId: 'api' }, 'db');
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('devops');
  });
  it("the 'devops' skill unlocks foreign services", () => {
    expect(decideServiceControl({ ...base, roleSkills: ['devops'] }, 'db')).toMatchObject({ allowed: true, actor: 'agent' });
  });
});

describe('service_restart / service_start / service_stop', () => {
  it('master restarts any service and the transition is audited as master', async () => {
    const m = makeManager();
    installManager(m);
    const { record } = makeStores();
    const res = await tool('service_restart').handler(
      { service_id: 'api' },
      makeCtx({ isMaster: true, role: 'master' }),
    );
    expect(res.isError).toBeUndefined();
    expect(m.restartService).toHaveBeenCalledWith(COMPANY_SESSION_ID, 'api');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: COMPANY_SESSION_ID,
        serviceId: 'api',
        toState: 'restarted',
        actor: 'master',
      }),
    );
  });

  it("'main' routes to restartDevServer", async () => {
    const m = makeManager();
    installManager(m);
    makeStores();
    await tool('service_restart').handler({ service_id: 'main' }, makeCtx({ isMaster: true, role: 'master' }));
    expect(m.restartDevServer).toHaveBeenCalledWith(COMPANY_SESSION_ID);
    expect(m.restartService).not.toHaveBeenCalled();
  });

  it('subordinate may restart its own service (audited as agent)', async () => {
    const m = makeManager();
    installManager(m);
    const { record } = makeStores();
    const res = await tool('service_restart').handler({ service_id: 'api' }, makeCtx({ bound: 'api' }));
    expect(res.isError).toBeUndefined();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ actor: 'agent' }));
  });

  it("subordinate without devops is refused for a sibling's service", async () => {
    const m = makeManager();
    installManager(m);
    const { record } = makeStores();
    const res = await tool('service_restart').handler({ service_id: 'db' }, makeCtx({ bound: 'api' }));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('devops');
    expect(m.restartService).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('devops skill unlocks sibling services', async () => {
    const m = makeManager();
    installManager(m);
    makeStores();
    const res = await tool('service_restart').handler(
      { service_id: 'db' },
      makeCtx({ bound: 'api', skills: ['devops'] }),
    );
    expect(res.isError).toBeUndefined();
    expect(m.restartService).toHaveBeenCalledWith(COMPANY_SESSION_ID, 'db');
  });

  it('attached services are refused with a readable message', async () => {
    const m = makeManager({ getService: vi.fn(() => ({ status: 'ready', attached: true })) });
    installManager(m);
    makeStores();
    const res = await tool('service_stop').handler({ service_id: 'legacy' }, makeCtx({ isMaster: true, role: 'master' }));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('externally-managed');
    expect(m.pauseRuntimeContainer).not.toHaveBeenCalled();
  });

  it('typed ServiceRestartError codes surface as actionable text', async () => {
    const m = makeManager({
      restartService: vi.fn(async () => {
        throw Object.assign(new Error('dev server never started'), { code: 'not_running' });
      }),
    });
    installManager(m);
    const { record } = makeStores();
    const res = await tool('service_restart').handler({ service_id: 'api' }, makeCtx({ isMaster: true, role: 'master' }));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('no running container');
    expect(res.content).toContain('service_start');
    expect(record).not.toHaveBeenCalled(); // failed ops are not audited as flips
  });

  it('service_start unpauses runtime-paused containers and resumes main otherwise', async () => {
    const m = makeManager({ getService: vi.fn(() => ({ status: 'ready', runtimePaused: true })) });
    installManager(m);
    makeStores();
    await tool('service_start').handler({ service_id: 'api' }, makeCtx({ isMaster: true, role: 'master' }));
    expect(m.unpauseRuntimeContainer).toHaveBeenCalledWith(
      COMPANY_SESSION_ID,
      'api',
    );

    const m2 = makeManager({ get: vi.fn(() => ({ status: 'paused' })) });
    installManager(m2);
    await tool('service_start').handler({ service_id: 'main' }, makeCtx({ isMaster: true, role: 'master' }));
    expect(m2.resumeSandbox).toHaveBeenCalledWith(COMPANY_SESSION_ID);
  });

  it('service_stop pauses via the runtime-pause path', async () => {
    const m = makeManager();
    installManager(m);
    const { record } = makeStores();
    await tool('service_stop').handler({ service_id: 'api' }, makeCtx({ isMaster: true, role: 'master' }));
    expect(m.pauseRuntimeContainer).toHaveBeenCalledWith(
      COMPANY_SESSION_ID,
      'api',
    );
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ toState: 'paused' }));
  });
});

describe('service_logs', () => {
  it('reads the store page, prefixes every line with service/stream, and pages back', async () => {
    installManager(makeManager());
    const { listPage } = makeStores();
    listPage.mockReturnValue([
      {
        id: NEWER_LOG_ID,
        seq: 12,
        serviceId: 'api',
        stream: 'devserver',
        line: 'newer',
        atMs: 2_000,
      },
      {
        id: OLDER_LOG_ID,
        seq: 11,
        serviceId: 'db',
        stream: 'container',
        line: 'older',
        atMs: 1_000,
      },
    ]);
    const res = await tool('service_logs').handler(
      { service_id: undefined, lines: 2, before_seq: 99 },
      makeCtx({ bound: 'api' }),
    );
    expect(res.isError).toBeUndefined();
    expect(listPage).toHaveBeenCalledWith(
      COMPANY_SESSION_ID,
      expect.objectContaining({ limit: 2, beforeSeq: 99 }),
    );
    const [first, second] = res.content.split('\n');
    expect(first).toContain('[db/container]');
    expect(first).toContain('older');
    expect(second).toContain('[api/devserver]');
    expect(res.content).toContain('before_seq=11'); // full page → cursor footer
  });

  it('degrades clearly when the store is not wired (main process)', async () => {
    installManager(makeManager());
    setServiceSupervisorStores(null);
    const res = await tool('service_logs').handler({}, makeCtx({ bound: 'api' }));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('read_sandbox_logs');
  });
});
