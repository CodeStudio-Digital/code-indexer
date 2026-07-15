import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { ServerDeps } from '../../../deps.js';
import type { CoderRuntime } from '../state.js';
import { mountCoderSessionsRoutes } from '../sessions.js';

describe('coder archived message pagination', () => {
  it('anchors after maxMessageId when no visible row can supply before_id', async () => {
    const calls: unknown[][] = [];
    const sessionStore = {
      getSession: (id: number) => id === 1 ? { id: 1 } : null,
      maxMessageId: () => 42,
      previousUserMessageId: () => null,
      loadMessagesBefore: (...args: unknown[]) => {
        calls.push(args);
        return { messages: [], message_rows: [] };
      },
      listRecentSessionsGlobal: () => [],
    };
    const app = new Hono();
    mountCoderSessionsRoutes(
      app,
      { sessionStore, providerStore: {} } as unknown as ServerDeps,
      { activeRuns: new Map() } as unknown as CoderRuntime,
    );

    const response = await app.request('/api/coder/sessions/1/messages?include_archived=1&limit=25');

    expect(response.status).toBe(200);
    expect(calls).toEqual([[1, 43, 25, true]]);
  });

  it('returns the user turn that precedes a compacted assistant window', async () => {
    const sessionStore = {
      getSession: (id: number) => id === 1 ? { id: 1 } : null,
      loadSessionMessagesTail: () => ({
        session: { id: 1 },
        messages: [{ role: 'assistant', content: [] }],
        message_rows: [{ id: 20 }],
      }),
      getMessageCount: () => 1,
      getArchivedMessageCount: () => 19,
      previousUserMessageId: (_sessionId: number, beforeId: number) => beforeId === 20 ? 11 : null,
      listRecentSessionsGlobal: () => [],
    };
    const app = new Hono();
    mountCoderSessionsRoutes(
      app,
      { sessionStore, providerStore: {} } as unknown as ServerDeps,
      { activeRuns: new Map() } as unknown as CoderRuntime,
    );

    const response = await app.request('/api/coder/sessions/1?tail=60');

    expect(response.status).toBe(200);
    expect((await response.json()).preceding_user_message_id).toBe(11);
  });
});
