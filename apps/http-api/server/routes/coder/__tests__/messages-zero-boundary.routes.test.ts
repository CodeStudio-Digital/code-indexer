import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { asSessionId, type SessionId } from '@mcp/agent-runtime-contracts';
import type { ServerDeps } from '../../../deps.js';
import type { CoderRuntime } from '../state.js';
import { mountCoderSessionsRoutes } from '../sessions.js';

const SESSION_ID = asSessionId('018f0f5e-7b2d-7a45-8c11-0123456789ab');

vi.mock('../../../../sse/coderWorkerPoolSingleton.js', () => ({
  getCoderWorkerPool: () => ({
    abort: vi.fn(),
    getBus: vi.fn(() => null),
    isRunning: vi.fn(() => false),
  }),
}));

describe('coder archived message pagination', () => {
  it('anchors after maxMessageSeq when no visible row can supply before_seq', async () => {
    const calls: unknown[][] = [];
    const sessionStore = {
      getSession: (id: SessionId) => id === SESSION_ID ? { id: SESSION_ID } : null,
      maxMessageSeq: () => 42,
      previousUserMessageSeq: () => null,
      loadMessagesBefore: (...args: unknown[]) => {
        calls.push(args);
        return { messages: [], message_rows: [], next_cursor: 17 };
      },
      listRecentSessionsGlobal: () => [],
    };
    const app = new Hono();
    mountCoderSessionsRoutes(
      app,
      { sessionStore, providerStore: {} } as unknown as ServerDeps,
      { activeRuns: new Map() } as unknown as CoderRuntime,
    );

    const response = await app.request(
      `/api/coder/sessions/${SESSION_ID}/messages?include_archived=1&limit=25`,
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([[SESSION_ID, 43, 25, true]]);
    expect(await response.json()).toMatchObject({
      next_before_seq: 17,
      has_more: true,
    });

    const legacyNumeric = await app.request('/api/coder/sessions/1/messages?include_archived=1');
    expect(legacyNumeric.status).toBe(400);
  });

  it('returns the user turn that precedes a compacted assistant window', async () => {
    const sessionStore = {
      getSession: (id: SessionId) => id === SESSION_ID ? { id: SESSION_ID } : null,
      loadSessionMessagesTail: () => ({
        session: { id: SESSION_ID },
        messages: [{ role: 'assistant', content: [] }],
        message_rows: [{ seq: 20 }],
      }),
      getMessageCount: () => 1,
      getArchivedMessageCount: () => 19,
      previousUserMessageSeq: (_sessionId: SessionId, beforeSeq: number) => beforeSeq === 20 ? 11 : null,
      listRecentSessionsGlobal: () => [],
    };
    const app = new Hono();
    mountCoderSessionsRoutes(
      app,
      { sessionStore, providerStore: {} } as unknown as ServerDeps,
      { activeRuns: new Map() } as unknown as CoderRuntime,
    );

    const response = await app.request(`/api/coder/sessions/${SESSION_ID}?tail=60`);

    expect(response.status).toBe(200);
    expect((await response.json()).preceding_user_seq).toBe(11);
  });
});
