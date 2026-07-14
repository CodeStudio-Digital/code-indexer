import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { ServerDeps } from '../../../deps.js';
import { mountCoderChapterRoutes } from '../chapters.js';

function setup(options: { rebuild?: (sessionId: number, input: { scope?: string }) => Promise<unknown> } = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const row = {
    id: 7,
    session_id: 1,
    ordinal: 3,
    start_message_id: 10,
    end_message_id: 20,
    source: 'auto',
    trigger: 'threshold',
    title: 'A useful chapter',
    chapter_json: '{}',
    chapter_text: 'summary',
    resume_json: '{}',
    resume_text: 'resume',
    version: 3,
    metrics_json: '{}',
    created_at: '2026-07-10T12:00:00.000Z',
    superseded_at: null,
  };
  const sessionStore = {
    getSession: (id: number) => id === 1 ? { id } : null,
    getConversationChapterStatus: () => ({
      state: 'healthy', boundary_id: 20, unsummarized_messages: 4, chapter_count: 1,
    }),
    listConversationChapters: (...args: unknown[]) => {
      calls.push({ method: 'list', args });
      return { items: [row], next_cursor: '2' };
    },
    searchConversationChapters: (...args: unknown[]) => {
      calls.push({ method: 'search', args });
      return { items: [row], next_cursor: null };
    },
    getConversationChapter: (sessionId: number, chapterId: number) =>
      sessionId === 1 && chapterId === 7 ? row : null,
    listConversationChapterSource: (...args: unknown[]) => {
      calls.push({ method: 'source', args });
      return { items: [{ id: 10, role: 'user', content_json: '[]' }], next_cursor: '10' };
    },
  };
  const app = new Hono();
  mountCoderChapterRoutes(
    app,
    { sessionStore } as unknown as ServerDeps,
    options.rebuild ? { rebuild: options.rebuild } : undefined,
  );
  return { app, calls };
}

describe('coder conversation chapter routes', () => {
  it('lists and searches chapters with bounded cursor pagination', async () => {
    const { app, calls } = setup();
    const list = await app.request('/api/coder/sessions/1/chapters?limit=999&cursor=3');
    expect(list.status).toBe(200);
    const listBody = await list.json() as { next_cursor: string; status: { state: string } };
    expect(listBody.next_cursor).toBe('2');
    expect(listBody.status.state).toBe('healthy');
    expect(calls[0]).toEqual({ method: 'list', args: [1, { limit: 50, cursor: '3' }] });

    const search = await app.request('/api/coder/sessions/1/chapters?q=first%20decision&limit=5');
    expect(search.status).toBe(200);
    expect(calls[1]).toEqual({ method: 'search', args: [1, 'first decision', { limit: 5, cursor: undefined }] });
  });

  it('gets a session-scoped chapter and its paginated source messages', async () => {
    const { app, calls } = setup();
    const detail = await app.request('/api/coder/sessions/1/chapters/7');
    expect(detail.status).toBe(200);
    expect((await detail.json() as { id: number }).id).toBe(7);

    const source = await app.request('/api/coder/sessions/1/chapters/7/messages?limit=20&cursor=9');
    expect(source.status).toBe(200);
    expect(calls.find((call) => call.method === 'source')).toEqual({
      method: 'source',
      args: [1, 7, { limit: 20, cursor: '9' }],
    });
  });

  it('returns 404 across sessions and rejects malformed chapter ids', async () => {
    const { app } = setup();
    expect((await app.request('/api/coder/sessions/2/chapters')).status).toBe(404);
    expect((await app.request('/api/coder/sessions/1/chapters/99')).status).toBe(404);
    expect((await app.request('/api/coder/sessions/1/chapters/nope')).status).toBe(400);
  });

  it('keeps rebuild disabled until the compaction service supplies an orchestrator', async () => {
    const { app } = setup();
    const response = await app.request('/api/coder/sessions/1/chapters/rebuild', { method: 'POST' });
    expect(response.status).toBe(501);
  });

  it('accepts an injected rebuild orchestrator without coupling it to the store', async () => {
    const seen: Array<{ sessionId: number; scope?: string }> = [];
    const { app } = setup({ rebuild: async (sessionId, input) => {
      seen.push({ sessionId, scope: input.scope });
      return { queued: true };
    } });
    const response = await app.request('/api/coder/sessions/1/chapters/rebuild', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'all' }),
    });
    expect(response.status).toBe(202);
    expect(seen).toEqual([{ sessionId: 1, scope: 'all' }]);
  });
});
