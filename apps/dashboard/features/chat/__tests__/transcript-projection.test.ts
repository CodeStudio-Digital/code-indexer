import { describe, expect, it } from 'vitest';
import type { AssistantTurn } from '../../../hooks/useAgentStream.js';
import {
  buildTranscriptProjection,
  projectTranscriptHistory,
} from '../transcript-projection.js';
import type { PersistedMessage, SessionData } from '../types.js';

const user = (text: string): PersistedMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
});

const assistant = (...content: PersistedMessage['content']): PersistedMessage => ({
  role: 'assistant',
  content,
});

function session(messages: PersistedMessage[]): SessionData {
  return {
    session: {
      id: 'session-1',
      project_id: 1,
      title: 'Test',
      provider: 'openai',
      model: 'test',
      status: 'in_progress',
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_creation_tokens: 0,
      last_turn_input_tokens: 0,
      group_id: null,
      is_archived: false,
      archived_at: null,
      is_favorite: false,
      favorited_at: null,
      created_at: '',
      updated_at: '',
    },
    messages,
    message_rows: messages.map((_, index) => ({
      id: `row-${index + 1}`,
      seq: index + 1,
      input_tokens: 0,
      output_tokens: 0,
    })),
  };
}

describe('buildTranscriptProjection', () => {
  it('selects one canonical copy when a completed live turn is already durable', () => {
    const data = session([user('question'), assistant({ type: 'text', text: 'answer' })]);
    const live: AssistantTurn = { blocks: [{ type: 'text', text: 'answer', id: 'live-text' }] };

    const projection = buildTranscriptProjection(data, live);

    expect(projection.live.duplicated).toBe(true);
    expect(projection.live.blocks).toEqual([]);
    expect(projectTranscriptHistory(projection.historyGroups, projection)).toHaveLength(2);
  });

  it('keeps the complete ordered live run when history only checkpointed its prefix', () => {
    const data = session([
      user('question'),
      assistant(
        { type: 'text', text: 'first' },
        { type: 'tool_use', id: 'tool-1', name: 'shell_command', input: {} },
      ),
    ]);
    const live: AssistantTurn = {
      blocks: [
        { type: 'text', text: 'first', id: 'text-1' },
        { type: 'tool', call: { id: 'tool-1', name: 'shell_command', status: 'done' } },
        { type: 'text', text: 'second', id: 'text-2' },
      ],
    };

    const projection = buildTranscriptProjection(data, live);
    const history = projectTranscriptHistory(projection.historyGroups, projection);

    expect(projection.live.replacesPersistedTail).toBe(true);
    expect(projection.live.blocks.map((block) => block.type)).toEqual(['text', 'tool', 'text']);
    expect(history.map((group) => group.kind)).toEqual(['user']);
  });

  it('indexes durable tool results once for all persisted renderers', () => {
    const data = session([
      user('question'),
      assistant({ type: 'tool_use', id: 'tool-1', name: 'shell_command', input: {} }),
      { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
    ]);

    const projection = buildTranscriptProjection(data, null);

    expect(projection.toolResultsById.get('tool-1')).toEqual({
      content: 'ok',
      isError: false,
      truncated: false,
      originalLength: undefined,
    });
  });
});
