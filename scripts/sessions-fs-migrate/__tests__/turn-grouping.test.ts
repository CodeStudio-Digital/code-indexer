import { describe, expect, it } from 'vitest';
import {
  groupLegacyMessagesIntoTurns,
  type LegacyConversationMessage,
} from '../exporter.js';

function message(
  id: string,
  role: string,
  isMeta = false,
  runId: string | null = null,
): LegacyConversationMessage<string> {
  return {
    id,
    role,
    isMeta,
    runId,
    createdAt: `2026-01-01T00:00:${id.padStart(2, '0')}Z`,
    value: id,
  };
}

describe('legacy conversation turn grouping', () => {
  it('preserves every message in order and creates one commit per visible user turn', () => {
    const source = [
      message('1', 'system', true),
      message('2', 'assistant'),
      message('3', 'user'),
      message('4', 'assistant', false, 'run-a'),
      message('5', 'user', true, 'run-a'),
      message('6', 'assistant', false, 'run-b'),
      message('7', 'user'),
      message('8', 'assistant', false, 'run-c'),
    ];
    const groups = groupLegacyMessagesIntoTurns(source);

    expect(groups.map((group) => group.kind)).toEqual([
      'legacy_preamble',
      'turn',
      'turn',
    ]);
    expect(groups.map((group) => group.messages.map((item) => item.id))).toEqual([
      ['1', '2'],
      ['3', '4', '5', '6'],
      ['7', '8'],
    ]);
    expect(groups.flatMap((group) => group.messages.map((item) => item.id))).toEqual(
      source.map((item) => item.id),
    );
    expect(groups.filter((group) => group.kind === 'turn')).toHaveLength(2);
  });

  it('retains an all-meta transcript as one explicit preamble commit', () => {
    expect(groupLegacyMessagesIntoTurns([
      message('1', 'system', true),
      message('2', 'user', true),
    ])).toMatchObject([
      {
        kind: 'legacy_preamble',
        messages: [{ id: '1' }, { id: '2' }],
      },
    ]);
  });
});
