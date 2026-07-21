import { describe, expect, it } from 'vitest';
import type { MessagePage, SessionData } from '../../types.js';
import { shouldLoadEarlierAtScrollTop } from '../MessageList.js';
import { groupMessages } from '../../utils.js';
import {
  appendOptimisticUserMessage,
  mergeEarlierMessagePage,
  normalizeSessionMessageData,
  sessionDataForSelection,
} from '../session-message-data.js';

function sessionData(sessionId: number, ids: number[]): SessionData {
  return {
    session: { id: sessionId } as SessionData['session'],
    messages: ids.map((id) => ({
      role: 'user' as const,
      content: [{ type: 'text' as const, text: `message-${id}` }],
    })),
    message_rows: ids.map((id) => ({ id, input_tokens: 0, output_tokens: 0 })),
  };
}

function messagePage(ids: number[], precedingUserMessageId = 0): MessagePage {
  return {
    messages: ids.map((id) => ({
      role: 'user' as const,
      content: [{ type: 'text' as const, text: `page-${id}` }],
    })),
    message_rows: ids.map((id) => ({ id, input_tokens: 0, output_tokens: 0 })),
    preceding_user_message_id: precedingUserMessageId,
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
    const normalized = normalizeSessionMessageData(sessionData(10, [1, 2, 2, 3]));

    expect(normalized.message_rows.map((row) => row.id)).toEqual([1, 2, 3]);
    expect(normalized.messages.map((message) => (
      message.content[0]?.type === 'text' ? message.content[0].text : null
    ))).toEqual(['message-1', 'message-2', 'message-3']);
  });

  it('does not expose a retained payload under another selected session', () => {
    expect(sessionDataForSelection(sessionData(10, [1, 2]), 20)).toBeNull();
    expect(sessionDataForSelection(sessionData(10, [1, 2]), 10)?.session.id).toBe(10);
  });

  it('prepends only unseen rows from an overlapping page', () => {
    const result = mergeEarlierMessagePage(
      sessionData(10, [3, 4]),
      messagePage([1, 2, 3], 99),
      10,
    );

    expect(result.addedRows).toBe(2);
    expect(result.data.message_rows.map((row) => row.id)).toEqual([1, 2, 3, 4]);
    expect(result.data.messages.map((message) => (
      message.content[0]?.type === 'text' ? message.content[0].text : null
    ))).toEqual(['page-1', 'page-2', 'message-3', 'message-4']);
    expect(result.data.preceding_user_message_id).toBe(99);
  });

  it('rejects a late page after the selected session changes', () => {
    const current = sessionData(20, [8, 9]);
    const result = mergeEarlierMessagePage(current, messagePage([1, 2]), 10);

    expect(result.addedRows).toBe(0);
    expect(result.data).toBe(current);
  });

  it('fails closed when the API breaks the parallel-array invariant', () => {
    const current = sessionData(10, [3, 4]);
    const malformed = messagePage([1, 2]);
    malformed.messages.pop();
    const result = mergeEarlierMessagePage(current, malformed, 10);

    expect(result.addedRows).toBe(0);
    expect(result.data).toBe(current);
  });

  it('appends an aligned optimistic user row with attachments and skills', () => {
    const current = { ...sessionData(10, []), total_messages: 0 };
    const updated = appendOptimisticUserMessage(current, {
      sessionId: 10,
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
      id: -101,
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
    const current = sessionData(20, []);
    const updated = appendOptimisticUserMessage(current, {
      sessionId: 10,
      messageId: -102,
      text: 'stale',
    });

    expect(updated).toBe(current);
  });
});
