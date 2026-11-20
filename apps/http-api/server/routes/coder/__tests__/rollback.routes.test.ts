import { HttpRouter } from '@mcp/shared/http/router.js';
import { asSessionId, type SessionId } from '@mcp/agent-runtime-contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerDeps } from '../../../deps.js';
import type { CoderRuntime } from '../state.js';
import { mountCoderRollbackRoute } from '../rollback.js';

const SESSION_ID = asSessionId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

const poolMock = vi.hoisted(() => ({
  isRunning: vi.fn(() => false),
  evict: vi.fn(async () => undefined),
}));

vi.mock('../../../../sse/coderWorkerPoolSingleton.js', () => ({
  getCoderWorkerPool: () => poolMock,
}));

function setup() {
  const rollbackSessionToSeq = vi.fn((sessionId: SessionId, seq: number) => ({
    sessionId,
    seq,
  }));
  const app = new HttpRouter();
  mountCoderRollbackRoute(
    app,
    {
      sessionStore: {
        getSession: (id: SessionId) => id === SESSION_ID ? { id } : null,
        rollbackSessionToSeq,
      },
    } as unknown as ServerDeps,
    { activeRuns: new Map() } as unknown as CoderRuntime,
  );
  return { app, rollbackSessionToSeq };
}

describe('coder rollback route UUID/seq contract', () => {
  beforeEach(() => {
    poolMock.isRunning.mockReset().mockReturnValue(false);
    poolMock.evict.mockReset().mockResolvedValue(undefined);
  });

  it('uses an opaque session UUID and conversation seq', async () => {
    const { app, rollbackSessionToSeq } = setup();
    const response = await app.request(`/api/coder/sessions/${SESSION_ID}/rollback-to-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seq: 17 }),
    });

    expect(response.status).toBe(200);
    expect(poolMock.evict).toHaveBeenCalledWith(SESSION_ID);
    expect(rollbackSessionToSeq).toHaveBeenCalledWith(SESSION_ID, 17);
    expect(poolMock.evict.mock.invocationCallOrder[0])
      .toBeLessThan(rollbackSessionToSeq.mock.invocationCallOrder[0]);
    expect(await response.json()).toMatchObject({ ok: true, sessionId: SESSION_ID, seq: 17 });
  });

  it('waits for an ended worker to release its writer before rolling back', async () => {
    let releaseEviction!: () => void;
    poolMock.evict.mockImplementation(() => new Promise<undefined>((resolve) => {
      releaseEviction = () => resolve(undefined);
    }));
    const { app, rollbackSessionToSeq } = setup();
    const responsePromise = app.request(`/api/coder/sessions/${SESSION_ID}/rollback-to-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seq: 17 }),
    });

    await vi.waitFor(() => expect(poolMock.evict).toHaveBeenCalledWith(SESSION_ID));
    expect(rollbackSessionToSeq).not.toHaveBeenCalled();

    releaseEviction();
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(rollbackSessionToSeq).toHaveBeenCalledWith(SESSION_ID, 17);
  });

  it('refuses rollback while the worker still has a run in progress', async () => {
    poolMock.isRunning.mockReturnValue(true);
    const { app, rollbackSessionToSeq } = setup();
    const response = await app.request(`/api/coder/sessions/${SESSION_ID}/rollback-to-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seq: 17 }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'run_active' });
    expect(poolMock.evict).not.toHaveBeenCalled();
    expect(rollbackSessionToSeq).not.toHaveBeenCalled();
  });

  it('does not accept the legacy numeric session/message-id contract', async () => {
    const { app, rollbackSessionToSeq } = setup();
    const numericSession = await app.request('/api/coder/sessions/1/rollback-to-message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seq: 17 }),
    });
    const legacyBody = await app.request(`/api/coder/sessions/${SESSION_ID}/rollback-to-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message_id: 17 }),
    });

    expect(numericSession.status).toBe(400);
    expect(legacyBody.status).toBe(400);
    expect(rollbackSessionToSeq).not.toHaveBeenCalled();
  });
});
