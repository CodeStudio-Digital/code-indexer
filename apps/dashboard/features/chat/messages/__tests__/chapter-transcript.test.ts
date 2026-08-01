import { describe, expect, it } from 'vitest';
import type { ConversationChapter, PersistedMessage, VisualGroup } from '../../types.js';
import {
  buildChapterTranscript,
  sortChaptersChronologically,
  visualGroupKey,
} from '../chapter-transcript.js';

const message: PersistedMessage = { role: 'user', content: [{ type: 'text', text: 'x' }] };
const sessionId = '018f0f5e-7b2d-7a45-8c11-0123456789ab';

function chapter(id: string, ordinal: number, start: number, end: number): ConversationChapter {
  return {
    id,
    seq: ordinal,
    revision: 1,
    session_id: sessionId,
    ordinal,
    start_message_seq: start,
    end_message_seq: end,
    source: 'auto',
    trigger: 'threshold',
    title: `Chapter ${ordinal}`,
    version: 3,
    created_at: '2026-07-10T12:00:00.000Z',
  };
}

function userGroup(seq: number, id = `row-${seq}`): VisualGroup {
  return {
    kind: 'user',
    message,
    messageId: seq,
    usage: { id, seq, input_tokens: 0, output_tokens: 0 },
  };
}

describe('chapter transcript timeline', () => {
  it('sorts chapter #13 before #17 by transcript range even if the API returns newest first', () => {
    const chapter13 = chapter('chapter-13', 13, 841, 882);
    const chapter17 = chapter('chapter-17', 17, 1012, 1086);
    expect(sortChaptersChronologically([chapter17, chapter13]).map((item) => item.ordinal))
      .toEqual([13, 17]);
  });

  it('renders compact chapter nodes in sequence and suppresses duplicate loaded source rows', () => {
    const chapter13 = chapter('chapter-13', 13, 841, 882);
    const chapter17 = chapter('chapter-17', 17, 1012, 1086);
    const timeline = buildChapterTranscript(
      [chapter17, chapter13],
      [userGroup(850), userGroup(1050), userGroup(1200)],
    );

    expect(timeline.map((item) => item.kind === 'chapter' ? `c${item.chapter.ordinal}` : `m${item.seq}`))
      .toEqual(['c13', 'c17', 'm1200']);
  });

  it('uses stable database row ids for virtual keys, including optimistic messages', () => {
    const optimistic: VisualGroup = {
      kind: 'user',
      message,
      usage: {
        id: 'optimistic:123',
        seq: -123,
        input_tokens: 0,
        output_tokens: 0,
        optimistic: true,
      },
    };
    expect(visualGroupKey(optimistic)).toBe('user:optimistic:123');
  });
});
