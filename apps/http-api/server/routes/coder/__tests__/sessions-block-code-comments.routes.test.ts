import { describe, expect, it, vi } from 'vitest';
import { HttpRouter } from '@mcp/shared/http/router.js';
import { asSessionId, type SessionId } from '@mcp/agent-runtime-contracts';
import { mountCoderSessionsRoutes } from '../sessions.js';
import type { ServerDeps } from '../../../deps.js';
import type { CoderRuntime } from '../state.js';

const SESSION_ID = asSessionId('55555555-5555-4555-8555-555555555555');
const MISSING_SESSION_ID = asSessionId('55555555-5555-4555-8555-555555555556');

vi.mock('../../../../sse/coderWorkerPoolSingleton.js', () => ({
  getCoderWorkerPool: () => ({
    abort: vi.fn(),
    isRunning: vi.fn(() => false),
    setBlockCodeComments: vi.fn(async () => false),
  }),
}));

function setup() {
  const calls: Array<{ id: SessionId; enabled: boolean }> = [];
  const sessions = new Map<SessionId, { id: SessionId; block_code_comments: boolean }>([
    [SESSION_ID, { id: SESSION_ID, block_code_comments: true }],
  ]);
  const sessionStore = {
    getSession: (id: SessionId) => sessions.get(id) ?? null,
    setSessionBlockCodeComments: (id: SessionId, enabled: boolean) => {
      calls.push({ id, enabled });
      const session = sessions.get(id);
      if (session) session.block_code_comments = enabled;
    },
  };
  const app = new HttpRouter();
  mountCoderSessionsRoutes(
    app,
    { sessionStore, providerStore: {} } as unknown as ServerDeps,
    { activeRuns: new Map() } as unknown as CoderRuntime,
  );
  const patchSetting = (id: SessionId, enabled: unknown) => app.request(
    `/api/coder/sessions/${id}/block-code-comments`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    },
  );
  return { calls, patchSetting };
}

describe('coder PATCH /sessions/:id/block-code-comments', () => {
  it('persists and returns the disabled state', async () => {
    const { calls, patchSetting } = setup();
    const response = await patchSetting(SESSION_ID, false);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ block_code_comments: false });
    expect(calls).toEqual([{ id: SESSION_ID, enabled: false }]);
  });

  it('rejects non-boolean values without writing', async () => {
    const { calls, patchSetting } = setup();
    const response = await patchSetting(SESSION_ID, 'false');
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('returns 404 for a missing conversation', async () => {
    const { calls, patchSetting } = setup();
    const response = await patchSetting(MISSING_SESSION_ID, true);
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });
});
