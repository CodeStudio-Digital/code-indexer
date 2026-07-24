import { describe, expect, it } from 'vitest';
import {
  groupMessages,
  mergeConsecutiveAssistantGroups,
  liveTurnContinuesPersistedAssistant,
  suppressLatestPersistedAssistantRun,
  suppressPersistedAgentDuplicates,
} from '../utils.js';
import type { PersistedMessage, VisualGroup } from '../types.js';

function assistant(id: number, content: PersistedMessage['content'], hasText = false): VisualGroup {
  return {
    kind: 'assistant',
    messages: [{ role: 'assistant', content }],
    messageIds: [id],
    usages: [undefined],
    hasText,
  };
}

describe('assistant visual grouping', () => {
  it('keeps persisted meta inputs out of the visible transcript', () => {
    const groups = groupMessages([
      {
        role: 'user',
        content: [{ type: 'text', text: '<system-reminder>internal</system-reminder>' }],
        isMeta: true,
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Visible request' }],
      },
    ], []);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      kind: 'user',
      message: { content: [{ text: 'Visible request' }] },
    });
  });

  it('renders all provider/tool cycles before the next user message under one assistant header', () => {
    const user: VisualGroup = {
      kind: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'go' }] },
      messageId: 1,
    };
    const groups = mergeConsecutiveAssistantGroups([
      user,
      assistant(2, [{ type: 'thinking', text: 'Inspect' }]),
      assistant(3, [{ type: 'tool_use', id: 'read-1', name: 'read_file', input: {} }]),
      assistant(4, [{ type: 'text', text: 'Done' }], true),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[1]).toMatchObject({
      kind: 'assistant',
      messageIds: [2, 3, 4],
      hasText: true,
    });
  });

  it('suppresses only the persisted spawn card owned by the live group', () => {
    const groups = [assistant(2, [
      { type: 'thinking', text: 'Delegating' },
      { type: 'tool_use', id: 'spawn-1', name: 'spawn_agent', input: { agents: [] } },
      { type: 'tool_use', id: 'read-1', name: 'read_file', input: {} },
    ])];
    const results = new Map([
      ['spawn-1', { content: '[spawn_agent background] job=job-1 group=group-1 agents=1 (Scout) started.' }],
    ]);

    const reconciled = suppressPersistedAgentDuplicates(
      groups,
      [{ groupId: 'group-1' }],
      results,
    );
    const remaining = reconciled[0]?.kind === 'assistant'
      ? reconciled[0].messages[0].content
      : [];
    expect(remaining.map((block) => block.type)).toEqual(['thinking', 'tool_use']);
    expect(remaining.find((block) => block.type === 'tool_use')?.id).toBe('read-1');
  });

  it('marks live content as a continuation until a real user message starts a new turn', () => {
    const assistantMessage: PersistedMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Working' }],
    };
    const toolMessage: PersistedMessage = {
      role: 'tool',
      content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'ok' }],
    };
    const userMessage: PersistedMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'Next request' }],
    };

    expect(liveTurnContinuesPersistedAssistant([assistantMessage, toolMessage])).toBe(true);
    expect(liveTurnContinuesPersistedAssistant([assistantMessage, userMessage])).toBe(false);
  });

  it('removes only the latest checkpointed assistant run when the complete run stays live', () => {
    const firstUser: VisualGroup = {
      kind: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'First request' }] },
      messageId: 1,
    };
    const latestUser: VisualGroup = {
      kind: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Latest request' }] },
      messageId: 3,
    };
    const groups = [
      firstUser,
      assistant(2, [{ type: 'text', text: 'Old completed answer' }], true),
      latestUser,
      assistant(4, [{ type: 'text', text: 'Checkpoint one' }], true),
      assistant(5, [{ type: 'tool_use', id: 'read-1', name: 'read_file', input: {} }]),
    ];

    expect(suppressLatestPersistedAssistantRun(groups)).toEqual(groups.slice(0, 3));
  });
});
