import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mountCoderSessionsRoutes } from '../sessions.js';
import type { ServerDeps } from '../../../deps.js';
import type { CoderRuntime } from '../state.js';

function setup() {
  const calls: Array<{ id: number; enabled: boolean }> = [];
  const sessions = new Map<number, { id: number; thinking_enabled: boolean }>([
    [1, { id: 1, thinking_enabled: false }],
  ]);
  const sessionStore = {
    getSession: (id: number) => sessions.get(id) ?? null,
    setSessionThinkingEnabled: (id: number, enabled: boolean) => {
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
  const patchThinking = (id: number, thinking: unknown) => app.request(
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
    const response = await patchThinking(1, true);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ thinking_enabled: true });
    expect(calls).toEqual([{ id: 1, enabled: true }]);
  });

  it('rejects non-boolean values without writing', async () => {
    const { calls, patchThinking } = setup();
    const response = await patchThinking(1, 'true');
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('returns 404 for a missing conversation', async () => {
    const { calls, patchThinking } = setup();
    const response = await patchThinking(99, true);
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });
});
