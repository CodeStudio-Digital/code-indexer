import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asCompanySessionId } from '@mcp/session-storage';
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
    has: (id: string) => !!H.getActive(id),
    delete: vi.fn(),
  },
}));

vi.mock('@mcp/company/services/CompanySessionFiles.js', () => ({
  CompanySessionFiles: class {
    getSession() {
      return {
        runtime_kind: 'company',
        parent_session_id: null,
      };
    }

    listInboxMessagesSync() {
      return [];
    }

    getKanbanCardFullSync(id: string) {
      return { id };
    }
  },
}));

const { mountCompanyChildRoutes } = await import('../children.js');
const { mountCompanyInboxRoutes } = await import('../inbox.js');
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

const SESSION_ID = asCompanySessionId(
  '00000000-0000-4000-8000-000000000007',
);
const CHILD_ID = '00000000-0000-4000-8000-000000000008';
const NEW_CHILD_ID = '00000000-0000-4000-8000-000000000009';
const INBOX_ID = '00000000-0000-4000-8000-000000000011';
const KANBAN_CARD_ID = '00000000-0000-4000-8000-000000000091';

function genericSession(id: string) {
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
    const listGate = deferred<Array<{ id: string; body: string }>>();
    const orchestrator = {
      inboxList: vi.fn(() => listGate.promise),
      inboxCancel: vi.fn(async () => false),
      inboxRespond: vi.fn(async () => false),
    };
    H.getActive.mockReturnValue(orchestrator);

    const app = new Hono();
    mountCompanyInboxRoutes(app, {
      sessionStore: {
        ensureCatalog: vi.fn(async () => undefined),
      },
    } as unknown as ServerDeps);

    const listResponse = Promise.resolve(
      app.request(`/api/company/sessions/${SESSION_ID}/inbox`),
    );
    await vi.waitFor(() => expect(orchestrator.inboxList).toHaveBeenCalledOnce());
    let listSettled = false;
    void listResponse.then(() => { listSettled = true; });
    await Promise.resolve();
    expect(listSettled).toBe(false);

    listGate.resolve([{ id: INBOX_ID, body: 'worker result' }]);
    expect(await (await listResponse).json()).toEqual([
      { id: INBOX_ID, body: 'worker result' },
    ]);

    const cancel = await app.request(
      `/api/company/sessions/${SESSION_ID}/inbox/${INBOX_ID}/cancel`,
      {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      },
    );
    expect(cancel.status).toBe(404);
  });

  it('awaits child creation and rename RPCs before reading or returning durable state', async () => {
    interface SessionRow {
      id: string;
      parent_session_id: string | null;
      runtime_kind: string;
      config_json: string;
      status: string;
      name: string;
    }
    const rows = new Map<string, SessionRow>([
      [SESSION_ID, { ...genericSession(SESSION_ID), name: 'Root' }],
      [
        CHILD_ID,
        {
          ...genericSession(CHILD_ID),
          parent_session_id: SESSION_ID,
          name: 'Old',
        },
      ],
    ]);
    const operationalSessionFiles = {
      getCompanySession: vi.fn(async (id: string) => rows.get(id) ?? null),
      getCompanySessionFull: vi.fn(async () => ({
        projects: [{ project_id: 7, label: null }],
      })),
      createCompanySession: vi.fn(async (input: { name: string }) => ({
        ...genericSession(NEW_CHILD_ID),
        parent_session_id: SESSION_ID,
        name: input.name,
      })),
      renameCompanySession: vi.fn(async (id: string, name: string) => {
        const row = rows.get(id);
        if (!row) return null;
        row.name = name;
        return row;
      }),
    };
    H.getActive.mockReturnValue(null);
    const app = new Hono();
    mountCompanyChildRoutes(app, {
      operationalSessionFiles,
    } as unknown as ServerDeps);

    const created = await app.request(
      `/api/company/sessions/${SESSION_ID}/children`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Async child' }),
      },
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      id: NEW_CHILD_ID,
      name: 'Async child',
    });

    const renamed = await app.request(
      `/api/company/sessions/${SESSION_ID}/children/${CHILD_ID}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'New' }),
      },
    );
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      id: CHILD_ID,
      name: 'New',
    });
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
      sessionStore: {
        ensureCatalog: vi.fn(async () => undefined),
      },
    } as unknown as ServerDeps);

    const response = await app.request(
      `/api/company/sessions/${SESSION_ID}/kanban/cards/${KANBAN_CARD_ID}/dispatch`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'backend' }),
      },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      cardId: KANBAN_CARD_ID,
    });
    expect(dispatchCard).toHaveBeenCalledOnce();
    expect(H.getOrSpawn).toHaveBeenCalledOnce();
    expect(H.evict).toHaveBeenCalledWith(SESSION_ID);
  });

  it('does not evict or acknowledge abort until the worker has completed both phases', async () => {
    const abortGate = deferred<void>();
    const evictGate = deferred<void>();
    const orchestrator = {
      abortAll: vi.fn(() => abortGate.promise),
    };
    H.getActive.mockReturnValue(orchestrator);
    H.evict.mockImplementation(() => evictGate.promise);

    const result = abortCompanyRuntime(SESSION_ID);
    await vi.waitFor(() => expect(orchestrator.abortAll).toHaveBeenCalledOnce());
    expect(H.evict).not.toHaveBeenCalled();

    abortGate.resolve();
    await vi.waitFor(() => expect(H.evict).toHaveBeenCalledWith(SESSION_ID));
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

    await expect(abortCompanyRuntime(SESSION_ID)).resolves.toEqual({
      ok: false,
      reason: 'outcome_unknown',
      code: 'OUTCOME_UNKNOWN',
      error: 'abort acknowledgement timed out',
    });
    expect(abortAll).toHaveBeenCalledOnce();
    expect(H.evict).toHaveBeenCalledOnce();
    expect(H.evict).toHaveBeenCalledWith(SESSION_ID);
  });

  it('delivers through an orchestrator created by a concurrent request before returning success', async () => {
    const deliveryGate = deferred<{ ok: boolean }>();
    const orchestrator = {
      companySessionId: SESSION_ID,
      metaBus: {},
      sendMessageToMaster: vi.fn(() => deliveryGate.promise),
    };
    H.getActive.mockReturnValue(orchestrator);

    const result = ensureCompanyMasterLive(
      SESSION_ID,
      { sessionStore: {} } as Pick<ServerDeps, 'sessionStore'>,
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
      companySessionId: SESSION_ID,
      metaBus: {},
      sendMessageToMaster: vi.fn(async () => {
        throw { code: 'port_closed' };
      }),
    });

    await expect(ensureCompanyMasterLive(
      SESSION_ID,
      { sessionStore: {} } as Pick<ServerDeps, 'sessionStore'>,
      { message: 'deliver once' },
    )).resolves.toMatchObject({
      status: 500,
      code: 'OUTCOME_UNKNOWN',
    });
    expect(H.evict).toHaveBeenCalledWith(SESSION_ID);
  });
});
