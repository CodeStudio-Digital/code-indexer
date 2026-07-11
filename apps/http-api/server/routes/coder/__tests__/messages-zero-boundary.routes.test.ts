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
});
