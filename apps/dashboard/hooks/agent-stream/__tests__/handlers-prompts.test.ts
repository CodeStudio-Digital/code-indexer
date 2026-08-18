/**
 * Prompt event handling: what reaches the card, and what happens when the
 * attach replay delivers the same prompt twice.
 */
import { describe, expect, it, vi } from 'vitest';
import { createEventHandlers } from '../handlers.js';
import type { SessionId, StreamBlock, UpdateSession } from '../types.js';

function setup() {
  const blocks: StreamBlock[] = [];
  const handlers = createEventHandlers({
    sid: 1 as unknown as SessionId,
    blocks,
    toolIndex: new Map<string, number>(),
    flush: vi.fn(),
    flushNow: vi.fn(),
    updateSession: vi.fn() as UpdateSession,
  });
  return { handlers, blocks };
}

describe('question handler', () => {
  it('carries multiSelect through to the card', () => {
    const { handlers, blocks } = setup();
    handlers.question({
      id: 'q1',
      question: 'Which ones?',
      options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
      multiSelect: true,
    }, 'question');

    // Dropping it made the first option click submit instead of toggling.
    expect(blocks[0]).toMatchObject({ type: 'question', question: { multiSelect: true } });
  });

  it('leaves multiSelect undefined for a single-answer question', () => {
    const { handlers, blocks } = setup();
    handlers.question({ id: 'q1', question: 'Scope?' }, 'question');

    expect(blocks[0]).toMatchObject({ type: 'question' });
    expect((blocks[0] as { question: { multiSelect?: boolean } }).question.multiSelect).toBeUndefined();
  });
});

describe('prompt replay idempotency', () => {
  it('replaces a re-delivered question instead of rendering it twice', () => {
    const { handlers, blocks } = setup();
    handlers.question({ id: 'q1', question: 'Scope?' }, 'question');
    handlers.question({ id: 'q1', question: 'Scope?' }, 'question');

    expect(blocks).toHaveLength(1);
  });

  it('applies the newest payload for the same prompt id', () => {
    const { handlers, blocks } = setup();
    handlers.tasks_posted({ tool_use_id: 't1', summary: 'First', tasks: [], version: 1 }, 'tasks_posted');
    handlers.tasks_posted({ tool_use_id: 't1', summary: 'Revised', tasks: [], version: 2 }, 'tasks_posted');

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ tasks: { summary: 'Revised', version: 2 } });
  });

  it('keeps genuinely different prompts side by side', () => {
    const { handlers, blocks } = setup();
    handlers.decision({ id: 'd1', questions: [{ id: 'a', question: 'A?', options: [] }] }, 'decision');
    handlers.decision({ id: 'd2', questions: [{ id: 'b', question: 'B?', options: [] }] }, 'decision');
    handlers.plan({ id: 'p1', plan: 'do it' }, 'plan');
    handlers.plan({ id: 'p1', plan: 'do it' }, 'plan');
    handlers.spec({ id: 's1', name: 'Spec', body: '#', spec_path: 's.md' }, 'spec');

    expect(blocks.map((b) => b.type)).toEqual(['decision', 'decision', 'plan', 'spec']);
  });
});
