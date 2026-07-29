/**
 * env_* tools — per-service scope surface (D1, migration 192).
 *
 * Pure fakes: the env store via `setEnvToolStore`, the sandbox manager
 * via `setSandboxManagerForTests` (same pattern as service-tools tests).
 * Pins the tri-state `service` param of env_set (omitted → undefined so
 * the store PRESERVES an existing scope; '' → null clears; CSV → set)
 * and the `[scope: ...]` suffix env_list renders for scoped vars.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type {
  CompanySessionEnvRow,
  CompanySessionEnvStore,
} from '@mcp/store/company-session-env-store.js';
import { setSandboxManagerForTests } from '@mcp/services/sandbox/sandbox-manager.js';
import type { SandboxManager } from '@mcp/services/sandbox/sandbox-manager.js';
import { envTools, setEnvToolStore } from '../env-tools.js';

const COMPANY_SESSION_ID = '00000000-0000-4000-8000-000000000007';
const AGENT_RUN_ID = '00000000-0000-4000-8000-000000000001';
const ENV_ID = '00000000-0000-4000-8000-000000000101';

const tool = (name: string) => {
  const t = envTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
};

function row(over: Partial<CompanySessionEnvRow>): CompanySessionEnvRow {
  return {
    id: ENV_ID,
    seq: 1,
    session_id: COMPANY_SESSION_ID,
    key: 'K',
    value: 'v',
    is_secret: 0,
    source: 'user',
    service_scope: null,
    created_at: '',
    updated_at: '',
    ...over,
  };
}

function makeStore(rows: CompanySessionEnvRow[] = []) {
  const upsert = vi.fn();
  const store = {
    list: vi.fn(() => rows),
    get: vi.fn(() => null),
    upsert,
    delete: vi.fn(),
    asRecord: vi.fn(() => ({})),
    asRecordForService: vi.fn(() => ({})),
  };
  setEnvToolStore(store as unknown as CompanySessionEnvStore);
  return { store, upsert };
}

function installFakeManager(): void {
  setSandboxManagerForTests({
    syncEnvsToAllContainers: vi.fn(async () => undefined),
  } as unknown as SandboxManager);
}

const ctx = {
  cwd: '/tmp',
  projectName: 'p',
  companyContext: {
    companySessionId: COMPANY_SESSION_ID,
    agentRole: 'dev',
    agentRunId: AGENT_RUN_ID,
  },
} as unknown as ToolContext;

afterEach(() => {
  setEnvToolStore(null);
  setSandboxManagerForTests(null);
});

describe('env_set — service scope param', () => {
  it('omitted service → serviceScope undefined (store preserves scope)', async () => {
    const { upsert } = makeStore();
    installFakeManager();
    const res = await tool('env_set').handler({ key: 'K', value: 'v' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(upsert).toHaveBeenCalledWith(COMPANY_SESSION_ID, 'K', 'v', false, {
      source: 'agent',
      serviceScope: undefined,
    });
  });

  it("service: 'main,api' → serviceScope CSV + echoed in the ok message", async () => {
    const { upsert } = makeStore();
    installFakeManager();
    const res = await tool('env_set').handler(
      { key: 'K', value: 'v', service: 'main,api' },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(String(res.content)).toContain('scope: main,api');
    expect(upsert).toHaveBeenCalledWith(COMPANY_SESSION_ID, 'K', 'v', false, {
      source: 'agent',
      serviceScope: 'main,api',
    });
  });

  it("service: '' → serviceScope null (explicitly clears the scope)", async () => {
    const { upsert } = makeStore();
    installFakeManager();
    const res = await tool('env_set').handler({ key: 'K', value: 'v', service: '' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(String(res.content)).toContain('scope: all services');
    expect(upsert).toHaveBeenCalledWith(COMPANY_SESSION_ID, 'K', 'v', false, {
      source: 'agent',
      serviceScope: null,
    });
  });
});

describe('env_list — scope suffix', () => {
  it('renders [scope: ...] for scoped vars only', async () => {
    makeStore([
      row({ key: 'SHARED', value: 'x' }),
      row({ key: 'API_ONLY', value: 'y', service_scope: 'api' }),
    ]);
    const res = await tool('env_list').handler({}, ctx);
    expect(res.isError).toBeFalsy();
    const text = String(res.content);
    expect(text).toContain('API_ONLY=y [scope: api]');
    expect(text).toContain('SHARED=x');
    expect(text).not.toContain('SHARED=x [scope');
  });
});
