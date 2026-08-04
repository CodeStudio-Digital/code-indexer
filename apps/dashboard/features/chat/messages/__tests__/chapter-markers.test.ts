import { describe, expect, it } from 'vitest';
import type { ConversationChapter, PersistedMessage, VisualGroup } from '../../types.js';
import {
  activeChapterIdAtScrollOffset,
  loadedChapterMarkers,
} from '../chapter-markers.js';

const message: PersistedMessage = { role: 'user', content: [{ type: 'text', text: 'x' }] };

function chapter(id: string, ordinal: number, start: number, end: number): ConversationChapter {
  return {
    id,
    seq: ordinal,
    revision: 1,
    session_id: '018f0f5e-7b2d-7a45-8c11-0123456789ab',
    ordinal,
    start_message_seq: start,
    end_message_seq: end,
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

    const first = '018f0f5e-7b2d-7a45-8c11-0123456789ad';
    const second = '018f0f5e-7b2d-7a45-8c11-0123456789ae';
    const markers = loadedChapterMarkers([
      chapter(first, 1, 1, 20),
      chapter(second, 2, 21, 40),
    ], groups);

    expect(markers.get(0)?.map((item) => item.id)).toEqual([first]);
    expect(markers.get(2)?.map((item) => item.id)).toEqual([second]);
  });

  it('does not render a divider when the chapter range is not loaded', () => {
    const groups: VisualGroup[] = [{ kind: 'user', message, messageId: 100 }];
    expect(loadedChapterMarkers([
      chapter('018f0f5e-7b2d-7a45-8c11-0123456789ad', 1, 1, 20),
    ], groups).size).toBe(0);
  });
});

describe('chapter quick navigation', () => {
  it('ignores overscanned rows above the viewport when selecting the active chapter', () => {
    const rows = [
      { kind: 'chapter', chapter: { id: 'early' } },
      { kind: 'message' },
      { kind: 'chapter', chapter: { id: 'latest' } },
      { kind: 'message' },
      { kind: 'tail' },
    ];
    const mountedRows = [
      { index: 0, end: 68 },
      { index: 1, end: 480 },
      { index: 2, end: 548 },
      { index: 3, end: 920 },
      { index: 4, end: 1080 },
    ];

    expect(activeChapterIdAtScrollOffset(rows, mountedRows, 930)).toBe('latest');
  });

  it('clears the active chapter before the first chapter marker', () => {
    const rows = [
      { kind: 'history-control' },
      { kind: 'chapter', chapter: { id: 'first' } },
    ];
    const mountedRows = [
      { index: 0, end: 48 },
      { index: 1, end: 116 },
    ];

    expect(activeChapterIdAtScrollOffset(rows, mountedRows, 0)).toBeNull();
  });
});
