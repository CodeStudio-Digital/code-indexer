/**
 * Route-level idempotency tests for company POST /start and POST /resume.
 *
 * A `ReconnectingSSEClient` retry re-POSTs the body (stable `client_msg_id`).
 * These assert the retry replays the master's metaBus instead of (a) hitting
 * the "Already running" 409 on /start, or (b) sending a duplicate message to
 * the master on /resume.
 *
 * The orchestrator singleton + master-resolve are mocked so the route mounts
 * without spawning real worker threads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

type Orch = {
  metaBus: unknown;
  pipelineRecoverRunning: () => Promise<void>;
  sendMessageToMaster: (...args: unknown[]) => void;
};
const H = vi.hoisted(() => ({
  orch: null as Orch | null,
  onSpawn: null as null | (() => Orch),
  resolveAndRunMaster: vi.fn(async () => {}),
}));

vi.mock('../../../../sse/companyOrchestrator.js', () => ({
  getCompanyOrchestrator: () => H.orch,
  hasCompanyOrchestrator: () => !!H.orch,
  deleteCompanyOrchestrator: () => { H.orch = null; },
  getOrSpawnCompanyOrchestrator: async () => {
    if (!H.orch && H.onSpawn) H.orch = H.onSpawn();
    return { orchestrator: H.orch, bus: H.orch!.metaBus };
  },
}));
vi.mock('../master-resolve.js', () => ({ resolveAndRunMaster: H.resolveAndRunMaster }));
vi.mock('../ensure-master-live.js', () => ({ ensureCompanyMasterLive: vi.fn(async () => ({ orchestrator: H.orch })) }));

import { mountCompanyStreamRoutes } from '../stream.js';
import { createBus, markEnded, type CoderRunBus } from '../../../../coder-bus.js';
import type { ServerDeps } from '../../../deps.js';

function makeOrch() {
  return {
    metaBus: createBus(new AbortController()),
    pipelineRecoverRunning: vi.fn(async () => {}),
    sendMessageToMaster: vi.fn(),
  };
}

function setup(sessionOverrides: Record<string, unknown> = {}) {
  const deps = {
    companyStore: {
      getCompanySession: (id: number) => ({
        id,
        config_json: '{}',
        status: 'idle',
        runtime_kind: 'company',
        ...sessionOverrides,
      }),
      listAgentRuns: () => [],
      setLastUserMessage: () => {},
      updateCompanySessionStatus: () => {},
    },
    db: {},
    providerStore: { getProvider: () => undefined },
  } as unknown as ServerDeps;

  const app = new Hono();
  mountCompanyStreamRoutes(app, deps);

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  return { app, deps, post };
}

beforeEach(() => {
  H.orch = null;
  H.onSpawn = null;
  H.resolveAndRunMaster.mockClear();
});

describe('company POST /resume idempotency', () => {
  it('a retry with the same client_msg_id does not re-send to the master', async () => {
    const orch = makeOrch();
    H.orch = orch;
    const h = setup();

    const r1 = await h.post('/api/company/sessions/1/resume', { message: 'hi', client_msg_id: 'R1' });
    expect(r1.status).toBe(200);
    expect(orch.sendMessageToMaster).toHaveBeenCalledTimes(1);

    const r2 = await h.post(
      '/api/company/sessions/1/resume',
      { message: 'hi', client_msg_id: 'R1' },
      { 'Last-Event-ID': '0' },
    );
    expect(r2.status).toBe(200);
    expect(orch.sendMessageToMaster).toHaveBeenCalledTimes(1); // not re-sent

    markEnded(orch.metaBus as CoderRunBus, 'done', {});
  });
});

describe('company POST /start idempotency', () => {
  it('a retry replays instead of the "Already running" 409', async () => {
    H.onSpawn = makeOrch;
    const h = setup();

    const r1 = await h.post('/api/company/sessions/1/start', { user_message: 'go', client_msg_id: 'S1' });
    expect(r1.status).toBe(200);
    expect(H.resolveAndRunMaster).toHaveBeenCalledTimes(1);
    expect(H.resolveAndRunMaster).toHaveBeenCalledWith(
      expect.anything(),
      false,
      expect.objectContaining({ provider: 'anthropic', model: 'claude-sonnet-4-6' }),
    );

    // Orchestrator now exists → without dedup this retry would 409.
    const r2 = await h.post(
      '/api/company/sessions/1/start',
      { user_message: 'go', client_msg_id: 'S1' },
      { 'Last-Event-ID': '0' },
    );
    expect(r2.status).toBe(200);
    expect(H.resolveAndRunMaster).toHaveBeenCalledTimes(1); // no second master start

    markEnded(H.orch!.metaBus as CoderRunBus, 'done', {});
  });

  it('fails closed before spawn when an App Master runtime is incomplete', async () => {
    H.onSpawn = makeOrch;
    const h = setup({ runtime_kind: 'app_studio', config_json: '{}' });

    const response = await h.post('/api/company/sessions/1/start', { user_message: 'go' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'MASTER_RUNTIME_INVALID' });
    expect(H.orch).toBeNull();
    expect(H.resolveAndRunMaster).not.toHaveBeenCalled();
  });

  it('uses the configured App Master and skips generic pipeline recovery', async () => {
    H.onSpawn = makeOrch;
    const h = setup({
      runtime_kind: 'app_studio',
      config_json: JSON.stringify({
        master_provider: 'openai-chatgpt',
        master_model: 'gpt-5.6-terra',
      }),
    });

    const response = await h.post('/api/company/sessions/1/start', { user_message: 'go' });
    expect(response.status).toBe(200);
    expect(H.resolveAndRunMaster).toHaveBeenCalledWith(
      expect.anything(),
      false,
      expect.objectContaining({
        provider: 'openai-chatgpt',
        model: 'gpt-5.6-terra',
      }),
    );
    expect(H.orch!.pipelineRecoverRunning).not.toHaveBeenCalled();
    markEnded(H.orch!.metaBus as CoderRunBus, 'done', {});
  });

  it('a genuine second start (no key) still gets the "Already running" 409', async () => {
    const orch = makeOrch();
    H.orch = orch; // already running
    const h = setup();

    const res = await h.post('/api/company/sessions/1/start', { user_message: 'go' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'Already running' });

    markEnded(orch.metaBus as CoderRunBus, 'done', {});
  });
});
