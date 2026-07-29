import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { asSessionId, type SessionId } from '@mcp/agent-runtime-contracts';
import { mountCoderSessionsRoutes } from '../sessions.js';
import type { ServerDeps } from '../../../deps.js';
import type { CoderRuntime } from '../state.js';

const SESSION_ID = asSessionId('44444444-4444-4444-8444-444444444444');
const MISSING_SESSION_ID = asSessionId('44444444-4444-4444-8444-444444444445');

vi.mock('../../../../sse/coderWorkerPoolSingleton.js', () => ({
  getCoderWorkerPool: () => ({
    abort: vi.fn(),
    isRunning: vi.fn(() => false),
  }),
}));

function setup() {
  const calls: Array<{ id: SessionId; enabled: boolean }> = [];
  const sessions = new Map<SessionId, { id: SessionId; thinking_enabled: boolean }>([
    [SESSION_ID, { id: SESSION_ID, thinking_enabled: false }],
  ]);
  const sessionStore = {
    getSession: (id: SessionId) => sessions.get(id) ?? null,
    setSessionThinkingEnabled: (id: SessionId, enabled: boolean) => {
      calls.push({ id, enabled });
      const session = sessions.get(id);
      if (session) session.thinking_enabled = enabled;
    },
    listRecentSessionsGlobal: () => [],
  };
  const app = new Hono();
  mountCoderSessionsRoutes(
    app,
    { sessionStore, providerStore: {} } as unknown as ServerDeps,
    { activeRuns: new Map() } as unknown as CoderRuntime,
  );
  const patchThinking = (id: SessionId, thinking: unknown) => app.request(
    `/api/coder/sessions/${id}/thinking`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thinking }),
    },
  );
  return { calls, patchThinking };
}

describe('coder PATCH /sessions/:id/thinking', () => {
  it('persists and returns the conversation state', async () => {
    const { calls, patchThinking } = setup();
    const response = await patchThinking(SESSION_ID, true);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ thinking_enabled: true });
    expect(calls).toEqual([{ id: SESSION_ID, enabled: true }]);
  });

  it('rejects non-boolean values without writing', async () => {
    const { calls, patchThinking } = setup();
    const response = await patchThinking(SESSION_ID, 'true');
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('returns 404 for a missing conversation', async () => {
    const { calls, patchThinking } = setup();
    const response = await patchThinking(MISSING_SESSION_ID, true);
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });
});
