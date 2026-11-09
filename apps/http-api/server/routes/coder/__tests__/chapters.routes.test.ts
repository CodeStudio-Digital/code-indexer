import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { asSessionId, type SessionId } from '@mcp/agent-runtime-contracts';
import {
  mountCoderChapterRoutes,
  type RebuildConversationChaptersInput,
} from '../chapters.js';

const SESSION_ID = asSessionId('018f0f5e-7b2d-7a45-8c11-0123456789ab');
const OTHER_SESSION_ID = asSessionId('018f0f5e-7b2d-7a45-8c11-0123456789ac');
const CHAPTER_ID = '018f0f5e-7b2d-7a45-8c11-0123456789ad';
const MISSING_CHAPTER_ID = '018f0f5e-7b2d-7a45-8c11-0123456789ae';

function setup(options: {
  rebuild?: (sessionId: SessionId, input: RebuildConversationChaptersInput) => Promise<unknown>;
} = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const row = {
    id: CHAPTER_ID,
    seq: 3,
    revision: 1,
    session_id: SESSION_ID,
    ordinal: 3,
    start_message_seq: 10,
    end_message_seq: 20,
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
    getSession: async (id: SessionId) => id === SESSION_ID ? { id } : null,
    getConversationChapterStatus: async () => ({
      state: 'healthy', boundary_seq: 20, unsummarized_messages: 4, chapter_count: 1,
    }),
    listConversationChapters: async (...args: unknown[]) => {
      calls.push({ method: 'list', args });
      return { items: [row], next_cursor: 'chapter:2' };
    },
    searchConversationChapters: async (...args: unknown[]) => {
      calls.push({ method: 'search', args });
      return { items: [row], next_cursor: null };
    },
    getConversationChapter: async (sessionId: SessionId, chapterId: string) =>
      sessionId === SESSION_ID && chapterId === CHAPTER_ID ? row : null,
    listConversationChapterSource: async (...args: unknown[]) => {
      calls.push({ method: 'source', args });
      return { items: [{ seq: 10, role: 'user', content: [] }], next_cursor: 'message:10' };
    },
  };
  const app = new Hono();
  mountCoderChapterRoutes(
    app,
    { sessionStore },
    options.rebuild ? { rebuild: options.rebuild } : undefined,
  );
  return { app, calls };
}

describe('coder conversation chapter routes', () => {
  it('pairs calls at a page boundary using bounded recorded results without loading another page', async () => {
    const calls: string[] = [];
    const app = new Hono();
    mountCoderChapterRoutes(app, { sessionStore: {
      getSession: async () => ({ id: SESSION_ID }),
      listConversationChapterSource: async () => {
        calls.push('page');
        return { items: [{ seq: 70, role: 'assistant', content: [
          { type: 'tool_use', id: 'already-paired', name: 'read_file' },
          { type: 'tool_use', id: 'next-page', name: 'read_file' },
        ] }, { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'already-paired', content: 'inline' },
        ] }], next_cursor: 'message:100' };
      },
      getToolResultsByToolUseIds: async (sessionId, ids) => {
        expect(sessionId).toBe(SESSION_ID);
        expect(ids).toEqual(['next-page']);
        calls.push('results');
        return [{ tool_use_id: 'next-page', result_text: 'x'.repeat(6000), is_error: true }];
      },
      previousUserMessageSeq: async (sessionId, seq) => {
        expect(sessionId).toBe(SESSION_ID); expect(seq).toBe(70); return 55;
      },
    } });
    const response = await app.request(`/api/coder/sessions/${SESSION_ID}/chapters/${CHAPTER_ID}/messages?limit=100`);
    expect(response.status).toBe(200);
    expect(calls).toEqual(['page', 'results']);
    const body = await response.json();
    expect(body.next_cursor).toBe('message:100');
    expect(body.preceding_user_seq).toBe(55);
    expect(body.tool_results).toEqual([{ tool_use_id: 'next-page', content: 'x'.repeat(4000),
      is_error: true, _truncated: true, _originalLength: 6000 }]);
  });

  it('lists and searches chapters with bounded cursor pagination', async () => {
    const { app, calls } = setup();
    const list = await app.request(`/api/coder/sessions/${SESSION_ID}/chapters?limit=999&cursor=chapter:3`);
    expect(list.status).toBe(200);
    const listBody = await list.json() as { next_cursor: string; status: { state: string } };
    expect(listBody.next_cursor).toBe('chapter:2');
    expect(listBody.status.state).toBe('healthy');
    expect(calls[0]).toEqual({
      method: 'list',
      args: [SESSION_ID, { limit: 50, cursor: 'chapter:3' }],
    });

    const search = await app.request(`/api/coder/sessions/${SESSION_ID}/chapters?q=first%20decision&limit=5`);
    expect(search.status).toBe(200);
    expect(calls[1]).toEqual({
      method: 'search',
      args: [SESSION_ID, 'first decision', { limit: 5, cursor: undefined }],
    });
  });

  it('returns lightweight timeline markers and keeps full detail on demand', async () => {
    const { app } = setup();
    const preview = await app.request(
      `/api/coder/sessions/${SESSION_ID}/chapters?detail=preview`,
    );
    const previewBody = await preview.json() as { items: Array<Record<string, unknown>> };
    expect(previewBody.items[0]).toMatchObject({ id: CHAPTER_ID, title: 'A useful chapter' });
    expect(previewBody.items[0]).not.toHaveProperty('chapter_json');
    expect(previewBody.items[0]).not.toHaveProperty('resume_json');
    expect(previewBody.items[0]).not.toHaveProperty('metrics_json');

    const detail = await app.request(`/api/coder/sessions/${SESSION_ID}/chapters/${CHAPTER_ID}`);
    expect(await detail.json()).toMatchObject({
      chapter_json: '{}',
      chapter_text: 'summary',
      resume_json: '{}',
      resume_text: 'resume',
    });
  });

  it('gets a session-scoped chapter and its paginated source messages', async () => {
    const { app, calls } = setup();
    const detail = await app.request(`/api/coder/sessions/${SESSION_ID}/chapters/${CHAPTER_ID}`);
    expect(detail.status).toBe(200);
    expect((await detail.json() as { id: string }).id).toBe(CHAPTER_ID);

    const source = await app.request(
      `/api/coder/sessions/${SESSION_ID}/chapters/${CHAPTER_ID}/messages?limit=20&cursor=message:9`,
    );
    expect(source.status).toBe(200);
    expect(calls.find((call) => call.method === 'source')).toEqual({
      method: 'source',
      args: [SESSION_ID, CHAPTER_ID, { limit: 20, cursor: 'message:9' }],
    });
  });

  it('returns 404 across sessions and rejects malformed chapter ids', async () => {
    const { app } = setup();
    expect((await app.request(`/api/coder/sessions/${OTHER_SESSION_ID}/chapters`)).status).toBe(404);
    expect((await app.request(`/api/coder/sessions/${SESSION_ID}/chapters/${MISSING_CHAPTER_ID}`)).status).toBe(404);
    expect((await app.request(`/api/coder/sessions/${SESSION_ID}/chapters/nope`)).status).toBe(400);
    expect((await app.request('/api/coder/sessions/1/chapters')).status).toBe(400);
  });

  it('rejects a cursor from the wrong sequence domain', async () => {
    const { app } = setup();
    expect((await app.request(
      `/api/coder/sessions/${SESSION_ID}/chapters?cursor=message:3`,
    )).status).toBe(400);
  });

  it('keeps rebuild disabled until the compaction service supplies an orchestrator', async () => {
    const { app } = setup();
    const response = await app.request(`/api/coder/sessions/${SESSION_ID}/chapters/rebuild`, { method: 'POST' });
    expect(response.status).toBe(501);
  });

  it('accepts an injected rebuild orchestrator without coupling it to the store', async () => {
    const seen: Array<{ sessionId: SessionId; scope?: string }> = [];
    const { app } = setup({ rebuild: async (sessionId, input) => {
      seen.push({ sessionId, scope: input.scope });
      return { queued: true };
    } });
    const response = await app.request(`/api/coder/sessions/${SESSION_ID}/chapters/rebuild`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'all' }),
    });
    expect(response.status).toBe(202);
    expect(seen).toEqual([{ sessionId: SESSION_ID, scope: 'all' }]);
  });
});
