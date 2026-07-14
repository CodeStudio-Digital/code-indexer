import { describe, expect, it } from 'vitest';
import type { ConversationChapter } from '../../types.js';
import { chapterPreviewText, resolvedChapterKind } from '../ConversationChapters.js';

function chapter(overrides: Partial<ConversationChapter> = {}): ConversationChapter {
  return {
    id: 1,
    session_id: 1241,
    ordinal: 1,
    start_message_id: 10,
    end_message_id: 30,
    source: 'auto',
    trigger: 'threshold',
    title: 'Reliable compaction',
    version: 3,
    created_at: '2026-07-13T12:00:00.000Z',
    ...overrides,
  };
}

describe('chapter visual metadata', () => {
  it('derives a stable visual kind for legacy and milestone rows', () => {
    expect(resolvedChapterKind(chapter())).toBe('context');
    expect(resolvedChapterKind(chapter({ trigger: 'milestone:plan-approved' }))).toBe('milestone');
    expect(resolvedChapterKind(chapter({ source: 'rebuild' }))).toBe('rebuild');
    expect(resolvedChapterKind(chapter({ chapter_kind: 'milestone', source: 'rebuild' }))).toBe('milestone');
  });

  it('prefers the structured summary for marker previews', () => {
    expect(chapterPreviewText(chapter({
      chapter_json: JSON.stringify({
        summary: 'Structured preview',
        work_completed: ['Fallback work'],
      }),
      chapter_text: 'Plain-text fallback',
    }))).toBe('Structured preview');
  });

  it('falls back through chapter and resume content without exposing raw JSON', () => {
    expect(chapterPreviewText(chapter({ chapter_text: 'Plain-text fallback' }))).toBe('Plain-text fallback');
    expect(chapterPreviewText(chapter({
      resume_json: { current_focus: 'Continue checkpoint retry work' },
    }))).toBe('Continue checkpoint retry work');
    expect(chapterPreviewText(chapter({ chapter_json: '{invalid' }))).toBe('');
  });
});
