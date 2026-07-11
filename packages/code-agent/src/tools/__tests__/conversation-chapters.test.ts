import { describe, expect, it } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { recallConversationTool } from '../conversation-chapters.js';

const chapter = {
  id: 7,
  session_id: 1,
  ordinal: 2,
  start_message_id: 10,
  end_message_id: 12,
  source: 'auto' as const,
  trigger: 'threshold',
  title: 'Authentication decision',
  chapter_json: '{}',
  chapter_text: '# Authentication decision\nUse signed cookies.',
  resume_json: '{}',
  resume_text: 'Continue with tests.',
  version: 3,
  metrics_json: null,
  created_at: '2026-07-10 10:00:00',
  superseded_at: null,
};

function context(): ToolContext {
  return {
    conversationHistory: {
      list: () => ({ items: [chapter], next_cursor: null }),
      search: () => ({ items: [{ ...chapter, rank: -1 }], next_cursor: null }),
      get: (id: number) => id === 7 ? chapter : null,
      source: () => ({
        items: [{
          id: 10,
          session_id: 1,
          role: 'user',
          content_json: JSON.stringify([{ type: 'text', text: 'original request' }]),
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          created_at: '2026-07-10 09:00:00',
        }],
        next_cursor: null,
      }),
    },
  } as unknown as ToolContext;
}

describe('recall_conversation', () => {
  it('supports list, search, get and original source modes', async () => {
    const ctx = context();
    const list = await recallConversationTool.handler({ mode: 'list' }, ctx);
    expect(list.content).toContain('Authentication decision');
    const search = await recallConversationTool.handler({ mode: 'search', query: 'cookies' }, ctx);
    expect(search.content).toContain('signed cookies');
    const get = await recallConversationTool.handler({ mode: 'get', chapter_id: 7 }, ctx);
    expect(get.content).toContain('Resume snapshot');
    const source = await recallConversationTool.handler({ mode: 'source', chapter_id: 7 }, ctx);
    expect(source.content).toContain('original request');
  });

  it('requires query/id and stays session-scoped through the injected port', async () => {
    const ctx = context();
    expect((await recallConversationTool.handler({ mode: 'search' }, ctx)).isError).toBe(true);
    expect((await recallConversationTool.handler({ mode: 'get', chapter_id: 99 }, ctx)).isError).toBe(true);
  });
});
