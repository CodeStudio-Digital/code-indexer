import { describe, expect, it } from 'vitest';
import type { ConversationChapter, PersistedMessage, VisualGroup } from '../../types.js';
import { loadedChapterMarkers } from '../chapter-markers.js';

const message: PersistedMessage = { role: 'user', content: [{ type: 'text', text: 'x' }] };

function chapter(id: number, start: number, end: number): ConversationChapter {
  return {
    id,
    session_id: 1,
    ordinal: id,
    start_message_id: start,
    end_message_id: end,
    source: 'auto',
    trigger: 'threshold',
    title: `Chapter ${id}`,
    version: 3,
    created_at: '2026-07-10T12:00:00.000Z',
  };
}

describe('loadedChapterMarkers', () => {
  it('places a divider at the first loaded group within each chapter range', () => {
    const groups: VisualGroup[] = [
      { kind: 'user', message, messageId: 12 },
      { kind: 'assistant', messages: [message], messageIds: [13, 14], usages: [], hasText: true },
      { kind: 'user', message, messageId: 31 },
    ];

    const markers = loadedChapterMarkers([chapter(1, 1, 20), chapter(2, 21, 40)], groups);

    expect(markers.get(0)?.map((item) => item.id)).toEqual([1]);
    expect(markers.get(2)?.map((item) => item.id)).toEqual([2]);
  });

  it('does not render a divider when the chapter range is not loaded', () => {
    const groups: VisualGroup[] = [{ kind: 'user', message, messageId: 100 }];
    expect(loadedChapterMarkers([chapter(1, 1, 20)], groups).size).toBe(0);
  });
});
