import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerDeps } from '../../../deps.js';

const H = vi.hoisted(() => ({
  getActive: vi.fn(),
  getOrSpawn: vi.fn(),
  evict: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock('../../../../sse/companyOrchestrator.js', () => ({
  getCompanyOrchestrator: H.getActive,
  evictCompanyOrchestrator: H.evict,
  deleteCompanyOrchestrator: vi.fn(),
  hasCompanyOrchestrator: vi.fn(() => false),
  getOrSpawnCompanyOrchestrator: H.getOrSpawn,
}));

vi.mock('../stream.js', () => ({
  activeOrchestrators: {
    get: H.getActive,
    has: (id: number) => !!H.getActive(id),
    delete: vi.fn(),
  },
}));

vi.mock('@mcp/api-handlers', () => ({
  generateAiPipeline: vi.fn(),
}));

const { mountCompanyChildRoutes } = await import('../children.js');
const { mountCompanyInboxRoutes } = await import('../inbox.js');
const { mountCompanyPipelineRoutes } = await import('../pipelines.js');
const { mountCompanyKanbanDispatchRoutes } = await import('../kanban-dispatch.js');
const { abortCompanyRuntime } = await import('../runtime-lifecycle.js');
const { ensureCompanyMasterLive } = await import('../ensure-master-live.js');

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function genericSession(id: number) {
  return {
    id,
    parent_session_id: null,
    runtime_kind: 'company',
    config_json: '{}',
    status: 'running',
  };
}

describe('worker-backed Company RPC boundaries', () => {
  beforeEach(() => {
    H.getActive.mockReset();
    H.getOrSpawn.mockReset();
    H.evict.mockReset();
    H.evict.mockResolvedValue(undefined);
  });

  it('awaits inbox reads and boolean mutations instead of serializing/trusting Promise objects', async () => {
    const listGate = deferred<Array<{ id: number; body: string }>>();
    const orchestrator = {
      inboxList: vi.fn(() => listGate.promise),
      inboxCancel: vi.fn(async () => false),
      inboxRespond: vi.fn(async () => false),
    };
    H.getActive.mockReturnValue(orchestrator);

    const app = new Hono();
    mountCompanyInboxRoutes(app, {
      companyStore: {
        getCompanySession: (id: number) => genericSession(id),
        listInboxMessages: vi.fn(() => []),
      },
    } as unknown as ServerDeps);

    const listResponse = Promise.resolve(app.request('/api/company/sessions/7/inbox'));
    await vi.waitFor(() => expect(orchestrator.inboxList).toHaveBeenCalledOnce());
    let listSettled = false;
    void listResponse.then(() => { listSettled = true; });
    await Promise.resolve();
    expect(listSettled).toBe(false);

    listGate.resolve([{ id: 11, body: 'worker result' }]);
    expect(await (await listResponse).json()).toEqual([{ id: 11, body: 'worker result' }]);

    const cancel = await app.request('/api/company/sessions/7/inbox/11/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(cancel.status).toBe(404);
  });

  it('awaits pipeline status and pause results before deciding the HTTP response', async () => {
    const orchestrator = {
      pipelineStatus: vi.fn(async () => null),
      pipelinePause: vi.fn(async () => false),
    };
    H.getActive.mockReturnValue(orchestrator);
    const companyStore = {
      getCompanySession: (id: number) => genericSession(id),
      getPipelineExecution: (id: number) => ({ id, company_session_id: 7 }),
      listPipelineNodeExecutions: vi.fn(() => []),
    };
    const app = new Hono();
    mountCompanyPipelineRoutes(app, {
      companyStore,
    } as unknown as ServerDeps);

    const status = await app.request('/api/company/sessions/7/pipelines/executions/31');
    expect(status.status).toBe(404);

    const pause = await app.request('/api/company/sessions/7/pipelines/executions/31/pause', {
      method: 'POST',
    });
    expect(pause.status).toBe(409);
  });

  it('awaits child creation and rename RPCs before reading or returning durable state', async () => {
    interface SessionRow {
      id: number;
      parent_session_id: number | null;
      runtime_kind: string;
      config_json: string;
      status: string;
      name: string;
    }
    const rows = new Map<number, SessionRow>([
      [7, { ...genericSession(7), name: 'Root' }],
      [8, { ...genericSession(8), parent_session_id: 7, name: 'Old' }],
    ]);
    const orchestrator = {
      createChildSession: vi.fn(async (name: string) => ({
        ...genericSession(9),
        parent_session_id: 7,
        name,
      })),
      renameChildSession: vi.fn(async (id: number, name: string) => {
        const row = rows.get(id);
        if (row) row.name = name;
      }),
    };
    H.getActive.mockImplementation((id: number) => id === 7 ? orchestrator : null);
    const app = new Hono();
    mountCompanyChildRoutes(app, {
      companyStore: {
        getCompanySession: (id: number) => rows.get(id) ?? null,
        createChildSession: vi.fn(),
        renameCompanySession: vi.fn(),
        listChildSessions: vi.fn(() => []),
      },
    } as unknown as ServerDeps);

    const created = await app.request('/api/company/sessions/7/children', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Async child' }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: 9, name: 'Async child' });

    const renamed = await app.request('/api/company/sessions/7/children/8', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New' }),
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ id: 8, name: 'New' });
  });

  it('does not replay child creation after losing the worker acknowledgement', async () => {
    const createChildSession = vi.fn(async () => {
      throw { code: 'port_closed', message: 'worker exited after create' };
    });
    H.getActive.mockReturnValue({ createChildSession });
    const directCreate = vi.fn();
    const app = new Hono();
    mountCompanyChildRoutes(app, {
      companyStore: {
        getCompanySession: (id: number) => ({
          ...genericSession(id),
          name: 'Root',
        }),
        createChildSession: directCreate,
      },
    } as unknown as ServerDeps);

    const response = await app.request('/api/company/sessions/7/children', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'One effect only' }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
    });
    expect(createChildSession).toHaveBeenCalledOnce();
    expect(directCreate).not.toHaveBeenCalled();
    expect(H.evict).toHaveBeenCalledWith(7);
  });

  it('does not spawn a card subordinate again after a dispatch timeout', async () => {
    const dispatchCard = vi.fn(async () => {
      throw { code: 'request_timeout', message: 'dispatch acknowledgement timed out' };
    });
    H.getOrSpawn.mockResolvedValue({
      orchestrator: { dispatchCard },
      bus: {},
    });
    const app = new Hono();
    mountCompanyKanbanDispatchRoutes(app, {
      companyStore: {
        getCompanySession: (id: number) => genericSession(id),
      },
    } as unknown as ServerDeps);

    const response = await app.request('/api/company/sessions/7/kanban/cards/91/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'backend' }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      cardId: 91,
    });
    expect(dispatchCard).toHaveBeenCalledOnce();
    expect(H.getOrSpawn).toHaveBeenCalledOnce();
    expect(H.evict).toHaveBeenCalledWith(7);
  });

  it('does not evict or acknowledge abort until the worker has completed both phases', async () => {
    const abortGate = deferred<void>();
    const evictGate = deferred<void>();
    const orchestrator = {
      abortAll: vi.fn(() => abortGate.promise),
    };
    H.getActive.mockReturnValue(orchestrator);
    H.evict.mockImplementation(() => evictGate.promise);

    const result = abortCompanyRuntime(7);
    await vi.waitFor(() => expect(orchestrator.abortAll).toHaveBeenCalledOnce());
    expect(H.evict).not.toHaveBeenCalled();

    abortGate.resolve();
    await vi.waitFor(() => expect(H.evict).toHaveBeenCalledWith(7));
    let settled = false;
    void result.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    evictGate.resolve();
    await expect(result).resolves.toEqual({ ok: true });
  });

  it('fences an abort whose worker acknowledgement timed out without replaying it', async () => {
    const abortAll = vi.fn(async () => {
      throw { code: 'request_timeout', message: 'abort acknowledgement timed out' };
    });
    H.getActive.mockReturnValue({ abortAll });

    await expect(abortCompanyRuntime(7)).resolves.toEqual({
      ok: false,
      reason: 'outcome_unknown',
      code: 'OUTCOME_UNKNOWN',
      error: 'abort acknowledgement timed out',
    });
    expect(abortAll).toHaveBeenCalledOnce();
    expect(H.evict).toHaveBeenCalledOnce();
    expect(H.evict).toHaveBeenCalledWith(7);
  });

  it('delivers through an orchestrator created by a concurrent request before returning success', async () => {
    const deliveryGate = deferred<{ ok: boolean }>();
    const orchestrator = {
      companySessionId: 7,
      metaBus: {},
      sendMessageToMaster: vi.fn(() => deliveryGate.promise),
    };
    H.getActive.mockReturnValue(orchestrator);

    const result = ensureCompanyMasterLive(
      7,
      { companyStore: {} } as Pick<ServerDeps, 'companyStore'>,
      {
        message: 'continue',
        attachments: [{ name: 'note.txt', mediaType: 'text/plain', text: 'hello' }],
        interject: true,
        thinking: true,
      },
    );
    await vi.waitFor(() => expect(orchestrator.sendMessageToMaster).toHaveBeenCalledWith(
      'continue',
      expect.objectContaining({ interject: true, thinking: true }),
    ));
    let settled = false;
    void result.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    deliveryGate.resolve({ ok: true });
    await expect(result).resolves.toMatchObject({
      orchestrator,
      resumed: false,
    });
  });

  it('does not replay a concurrent delivery after losing its worker acknowledgement', async () => {
    H.getActive.mockReturnValue({
      companySessionId: 7,
      metaBus: {},
      sendMessageToMaster: vi.fn(async () => {
        throw { code: 'port_closed' };
      }),
    });

    await expect(ensureCompanyMasterLive(
      7,
      { companyStore: {} } as Pick<ServerDeps, 'companyStore'>,
      { message: 'deliver once' },
    )).resolves.toMatchObject({
      status: 500,
      code: 'OUTCOME_UNKNOWN',
    });
    expect(H.evict).toHaveBeenCalledWith(7);
  });
});
