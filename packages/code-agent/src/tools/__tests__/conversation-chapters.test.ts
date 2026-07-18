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

function context(overrides: { chapterText?: string; sourceText?: string } = {}): ToolContext {
  const selectedChapter = overrides.chapterText
    ? { ...chapter, chapter_text: overrides.chapterText }
    : chapter;
  return {
    conversationHistory: {
      list: () => ({ items: [selectedChapter], next_cursor: null }),
      search: () => ({ items: [{ ...selectedChapter, rank: -1 }], next_cursor: null }),
      get: (id: number) => id === 7 ? selectedChapter : null,
      source: () => ({
        items: [{
          id: 10,
          session_id: 1,
          role: 'user',
          content_json: JSON.stringify([{ type: 'text', text: overrides.sourceText ?? 'original request' }]),
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

  it('keeps source messages intact and marks only the recoverable search preview', async () => {
    const sourceText = `SOURCE-BEGIN-${'x'.repeat(9_000)}-SOURCE-END`;
    const chapterText = `CHAPTER-BEGIN-${'y'.repeat(3_000)}-CHAPTER-END`;
    const ctx = context({ sourceText, chapterText });

    const search = await recallConversationTool.handler({ mode: 'search', query: 'chapter' }, ctx);
    expect(search.content).not.toContain('CHAPTER-END');
    expect(search.sourceTruncations).toEqual([{
      technique: 'conversation-search-preview',
      inputSize: chapterText.length,
      outputSize: 1_200,
      unit: 'chars',
      recoverable: true,
    }]);

    const source = await recallConversationTool.handler({ mode: 'source', chapter_id: 7 }, ctx);
    expect(source.content).toContain('SOURCE-BEGIN-');
    expect(source.content).toContain('-SOURCE-END');
    expect(source.sourceTruncations).toBeUndefined();
  });
});
