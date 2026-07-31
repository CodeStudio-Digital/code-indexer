import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  asSessionId,
  type SessionId,
} from '@mcp/agent-runtime-contracts';
import { mountCoderSessionsRoutes } from '../sessions.js';
import type { ServerDeps } from '../../../deps.js';
import type { CoderRuntime } from '../state.js';

const SESSION_ID = asSessionId(
  '66666666-6666-4666-8666-666666666666',
);

const worker = vi.hoisted(() => ({
  setRunLimits: vi.fn(async () => false),
}));

vi.mock('../../../../sse/coderWorkerPoolSingleton.js', () => ({
  getCoderWorkerPool: () => ({
    abort: vi.fn(),
    isRunning: () => false,
    setRunLimits: worker.setRunLimits,
  }),
}));

function setup() {
  const session = {
    id: SESSION_ID,
    max_turns: null as number | null,
    max_auto_continues: 15,
  };
  const setSessionRunLimits = vi.fn(
    (
      _id: SessionId,
      maxTurns: number | null,
      maxAutoContinues: number,
    ) => {
      session.max_turns = maxTurns;
      session.max_auto_continues = maxAutoContinues;
    },
  );
  const sessionStore = {
    getSession: (id: SessionId) => id === SESSION_ID ? session : null,
    setSessionRunLimits,
    listRecentSessionsGlobal: () => [],
  };
  const app = new Hono();
  mountCoderSessionsRoutes(
    app,
    {
      sessionStore,
      providerStore: {},
    } as unknown as ServerDeps,
    { activeRuns: new Map() } as unknown as CoderRuntime,
  );
  const patch = (body: unknown) => app.request(
    `/api/coder/sessions/${SESSION_ID}/run-limits`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { patch, session, setSessionRunLimits };
}

describe('coder PATCH /sessions/:id/run-limits', () => {
  it('persists an enabled per-session limit and auto-continue cap', async () => {
    worker.setRunLimits.mockResolvedValueOnce(false);
    const { patch, session, setSessionRunLimits } = setup();

    const response = await patch({
      max_turns: 80,
      max_auto_continues: 4,
    });

    expect(response.status).toBe(200);
    expect(setSessionRunLimits).toHaveBeenCalledWith(SESSION_ID, 80, 4);
    expect(session).toMatchObject({
      max_turns: 80,
      max_auto_continues: 4,
    });
  });

  it('uses null as the explicit unlimited state', async () => {
    worker.setRunLimits.mockResolvedValueOnce(false);
    const { patch, setSessionRunLimits } = setup();

    const response = await patch({
      max_turns: null,
      max_auto_continues: 15,
    });

    expect(response.status).toBe(200);
    expect(setSessionRunLimits).toHaveBeenCalledWith(SESSION_ID, null, 15);
  });

  it('rejects invalid values without writing', async () => {
    const { patch, setSessionRunLimits } = setup();
    const response = await patch({
      max_turns: 0,
      max_auto_continues: -1,
    });
    expect(response.status).toBe(400);
    expect(setSessionRunLimits).not.toHaveBeenCalled();
  });
});
