import { describe, expect, it } from 'vitest';
import type { MessagePage, SessionData } from '../../types.js';
import {
  shouldLoadEarlierAtScrollTop,
} from '../MessageList.js';
import { groupMessages } from '../../utils.js';
import {
  appendOptimisticUserMessage,
  mergeEarlierMessagePage,
  normalizeSessionMessageData,
  sessionDataForSelection,
} from '../session-message-data.js';

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';

function sessionData(sessionId: string, ids: number[]): SessionData {
  return {
    session: { id: sessionId } as SessionData['session'],
    messages: ids.map((id) => ({
      role: 'user' as const,
      content: [{ type: 'text' as const, text: `message-${id}` }],
    })),
    message_rows: ids.map((seq) => ({
      id: `row-${seq}`,
      seq,
      input_tokens: 0,
      output_tokens: 0,
    })),
  };
}

function messagePage(ids: number[], precedingUserSeq = 0): MessagePage {
  return {
    messages: ids.map((id) => ({
      role: 'user' as const,
      content: [{ type: 'text' as const, text: `page-${id}` }],
    })),
    message_rows: ids.map((seq) => ({
      id: `row-${seq}`,
      seq,
      input_tokens: 0,
      output_tokens: 0,
    })),
    next_before_seq: ids[0] ?? null,
    has_more: ids.length > 0,
    preceding_user_seq: precedingUserSeq,
  };
}

describe('conversation scroll pagination', () => {
  it.each([
    [-12, true],
    [0, true],
    [199, true],
    [200, true],
    [201, false],
    [900, false],
  ])('scrollTop %s => load earlier %s', (scrollTop, expected) => {
    expect(shouldLoadEarlierAtScrollTop(scrollTop)).toBe(expected);
  });

  it('normalizes duplicate cached rows without breaking message-row alignment', () => {
    const normalized = normalizeSessionMessageData(
      sessionData(SESSION_A, [1, 2, 2, 3]),
    );

    expect(normalized.message_rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(normalized.messages.map((message) => (
      message.content[0]?.type === 'text' ? message.content[0].text : null
    ))).toEqual(['message-1', 'message-2', 'message-3']);
  });

  it('does not expose a retained payload under another selected session', () => {
    expect(
      sessionDataForSelection(sessionData(SESSION_A, [1, 2]), SESSION_B),
    ).toBeNull();
    expect(
      sessionDataForSelection(sessionData(SESSION_A, [1, 2]), SESSION_A)
        ?.session.id,
    ).toBe(SESSION_A);
  });

  it('prepends only unseen rows from an overlapping page', () => {
    const result = mergeEarlierMessagePage(
      sessionData(SESSION_A, [3, 4]),
      messagePage([1, 2, 3], 99),
      SESSION_A,
    );

    expect(result.addedRows).toBe(2);
    expect(result.data.message_rows.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    expect(result.data.messages.map((message) => (
      message.content[0]?.type === 'text' ? message.content[0].text : null
    ))).toEqual(['page-1', 'page-2', 'message-3', 'message-4']);
    expect(result.data.preceding_user_seq).toBe(99);
  });

  it('integrates arbitrary chapter anchor pages by sequence, not request order', () => {
    const withChapter13 = mergeEarlierMessagePage(
      sessionData(SESSION_A, [2000, 2001]),
      messagePage([783, 841, 882], 782),
      SESSION_A,
    ).data;
    const withChapter17 = mergeEarlierMessagePage(
      withChapter13,
      messagePage([987, 1012, 1086], 986),
      SESSION_A,
    ).data;

    expect(withChapter17.message_rows.map((row) => row.seq)).toEqual([
      783, 841, 882, 987, 1012, 1086, 2000, 2001,
    ]);
    // The middle anchor must not replace the predecessor of the earliest
    // loaded window.
    expect(withChapter17.preceding_user_seq).toBe(782);
  });

  it('keeps optimistic rows at the live tail after an older page is merged', () => {
    const optimistic = appendOptimisticUserMessage(sessionData(SESSION_A, [10, 11]), {
      sessionId: SESSION_A,
      messageId: -900,
      text: 'pending',
    });
    const result = mergeEarlierMessagePage(
      optimistic,
      messagePage([1, 2], 0),
      SESSION_A,
    );

    expect(result.data.message_rows.map((row) => row.seq)).toEqual([1, 2, 10, 11, -900]);
  });

  it('retains current content when an overlapping page repeats the same row id', () => {
    const current = sessionData(SESSION_A, [2, 3]);
    const page = messagePage([1, 2], 0);
    const result = mergeEarlierMessagePage(current, page, SESSION_A);

    expect(result.data.messages.map((message) => (
      message.content[0]?.type === 'text' ? message.content[0].text : null
    ))).toEqual(['page-1', 'message-2', 'message-3']);
  });

  it('rejects a late page after the selected session changes', () => {
    const current = sessionData(SESSION_B, [8, 9]);
    const result = mergeEarlierMessagePage(
      current,
      messagePage([1, 2]),
      SESSION_A,
    );

    expect(result.addedRows).toBe(0);
    expect(result.data).toBe(current);
  });

  it('fails closed when the API breaks the parallel-array invariant', () => {
    const current = sessionData(SESSION_A, [3, 4]);
    const malformed = messagePage([1, 2]);
    malformed.messages.pop();
    const result = mergeEarlierMessagePage(current, malformed, SESSION_A);

    expect(result.addedRows).toBe(0);
    expect(result.data).toBe(current);
  });

  it('appends an aligned optimistic user row with attachments and skills', () => {
    const current = { ...sessionData(SESSION_A, []), total_messages: 0 };
    const updated = appendOptimisticUserMessage(current, {
      sessionId: SESSION_A,
      messageId: -101,
      text: 'inspect this',
      attachments: [
        { name: 'shot.png', mediaType: 'image/png', base64: 'aW1hZ2U=' },
        { name: 'notes.txt', mediaType: 'text/plain', text: 'details' },
      ],
      selectedSkillIds: ['unity'],
    });

    expect(updated.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'inspect this' },
        { type: 'image', mediaType: 'image/png', base64: 'aW1hZ2U=' },
        { type: 'document', name: 'notes.txt', mediaType: 'text/plain', text: 'details', base64: undefined },
      ],
      selectedSkillIds: ['unity'],
    }]);
    expect(updated.message_rows).toEqual([{
      id: 'optimistic:101',
      seq: -101,
      input_tokens: 0,
      output_tokens: 0,
      optimistic: true,
    }]);
    expect(updated.total_messages).toBe(1);

    const groups = groupMessages(updated.messages, updated.message_rows);
    expect(groups[0]?.kind).toBe('user');
    if (groups[0]?.kind === 'user') expect(groups[0].messageId).toBeUndefined();
  });

  it('rejects an optimistic row for a stale session updater', () => {
    const current = sessionData(SESSION_B, []);
    const updated = appendOptimisticUserMessage(current, {
      sessionId: SESSION_A,
      messageId: -102,
      text: 'stale',
    });

    expect(updated).toBe(current);
  });
});
