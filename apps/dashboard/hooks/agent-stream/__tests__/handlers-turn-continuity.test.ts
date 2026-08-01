import { describe, expect, it, vi } from 'vitest';
import { createEventHandlers } from '../handlers.js';
import type { StreamBlock, UpdateSession } from '../types.js';

function setup() {
  const blocks: StreamBlock[] = [];
  const toolIndex = new Map<string, number>();
  const flush = vi.fn();
  const flushNow = vi.fn();
  const onMessageComplete = vi.fn();
  const handlers = createEventHandlers({
    sid: 7,
    blocks,
    toolIndex,
    flush,
    flushNow,
    updateSession: vi.fn() as UpdateSession,
    onMessageComplete,
  });
  return { blocks, toolIndex, flush, flushNow, onMessageComplete, handlers };
}

describe('live transcript continuity across provider turns', () => {
  it('keeps auto-continue telemetry out of the conversation transcript', () => {
    const { blocks, flush, handlers } = setup();

    handlers.text({ text: 'Still working.' }, 'text');
    flush.mockClear();
    handlers.auto_continue({ count: 1, max: 15 }, 'auto_continue');

    expect(blocks).toEqual([
      expect.objectContaining({ type: 'text', text: 'Still working.' }),
    ]);
    expect(flush).not.toHaveBeenCalled();
  });

  it('keeps completed thinking/text while the following tool executes', () => {
    const { blocks, toolIndex, handlers } = setup();

    handlers.thinking({ text: 'Investigating' }, 'thinking');
    handlers.text({ text: 'I found the orchestration path.' }, 'text');
    handlers.message_complete({ usage: {} }, 'message_complete');
    handlers.tool_call_start({ id: 'tool-1', name: 'run_command', input: { command: 'rg workflow' } }, 'tool_call_start');
    handlers.tool_call_result({
      id: 'tool-1',
      result: { content: 'matched' },
      duration_ms: 428,
    }, 'tool_call_result');

    expect(blocks.map((block) => block.type)).toEqual(['thinking', 'text', 'tool']);
    expect(toolIndex.get('tool-1')).toBe(2);
    expect(blocks[2]).toMatchObject({
      type: 'tool',
      call: { id: 'tool-1', status: 'done', durationMs: 428 },
    });
  });

  it('accumulates the next provider cycle and refetches only once mid-run', () => {
    const { blocks, onMessageComplete, handlers } = setup();

    handlers.text({ text: 'First cycle' }, 'text');
    handlers.message_complete({ usage: {} }, 'message_complete');
    handlers.tool_call_start({ id: 'tool-1', name: 'run_command' }, 'tool_call_start');
    handlers.tool_call_result({
      id: 'tool-1',
      result: { content: 'ok' },
      duration_ms: 10,
    }, 'tool_call_result');
    handlers.thinking({ text: 'Second cycle' }, 'thinking');
    handlers.message_complete({ usage: {} }, 'message_complete');

    expect(blocks.map((block) => block.type)).toEqual(['text', 'tool', 'thinking']);
    expect(onMessageComplete).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh visible transcript when an injected user message reaches the runner', () => {
    const { blocks, toolIndex, flushNow, onMessageComplete, handlers } = setup();

    handlers.text({ text: 'Previous user turn' }, 'text');
    handlers.tool_call_start({
      id: 'old-tool',
      name: 'run_command',
      input: { command: 'rg old' },
    }, 'tool_call_start');
    blocks.push({
      type: 'activity',
      id: 'background-agent',
      kind: 'subagent',
      label: 'Background agent',
      status: 'running',
      startedAt: 1,
      lastEventAt: 2,
    });
    handlers.message_complete({ usage: {} }, 'message_complete');

    handlers.user_message_boundary({
      round_message_ids: [1222],
    }, 'user_message_boundary');

    expect(blocks.map((block) => block.type)).toEqual(['activity']);
    expect(toolIndex.size).toBe(0);
    expect(flushNow).toHaveBeenCalledTimes(2);
    // The persisted injected user row is fetched only after the preceding live
    // transcript has been cleared, eliminating the transient duplicate frame.
    expect(onMessageComplete).toHaveBeenCalledTimes(2);

    handlers.text({ text: 'Current user turn' }, 'text');
    handlers.message_complete({ usage: {} }, 'message_complete');

    expect(blocks.map((block) => block.type)).toEqual(['activity', 'text']);
    expect(onMessageComplete).toHaveBeenCalledTimes(2);
  });

  it('materializes and deduplicates a result-only pre-dispatch refusal', () => {
    const { blocks, toolIndex, flush, handlers } = setup();
    const refusal = {
      id: 'goal-update-1',
      name: 'update_goal',
      result: {
        content: '[goal-verifier] Refused `update_goal`: requirements remain.',
        isError: true,
        input: { status: 'complete' },
      },
      duration_ms: 0,
    };

    handlers.tool_call_result(refusal, 'tool_call_result');

    expect(blocks).toHaveLength(1);
    expect(toolIndex.get('goal-update-1')).toBe(0);
    expect(blocks[0]).toMatchObject({
      type: 'tool',
      call: {
        id: 'goal-update-1',
        name: 'update_goal',
        input: { status: 'complete' },
        result: {
          content: '[goal-verifier] Refused `update_goal`: requirements remain.',
          isError: true,
        },
        durationMs: 0,
        status: 'error',
      },
    });

    handlers.tool_call_result(refusal, 'tool_call_result');

    expect(blocks).toHaveLength(1);
    expect(toolIndex.size).toBe(1);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('keeps a successful goal mutation pending until the durable ack arrives', () => {
    const { blocks, handlers } = setup();
    handlers.tool_call_start({
      id: 'goal-create-durable',
      name: 'create_goal',
      input: { goal: 'Ship safely' },
    }, 'tool_call_start');
    handlers.tool_call_result({
      id: 'goal-create-durable',
      name: 'create_goal',
      result: { content: 'Goal set. Status: in_progress.' },
      duration_ms: 2,
      persistence: 'pending',
    }, 'tool_call_result');

    expect(blocks[0]).toMatchObject({
      type: 'tool',
      call: {
        status: 'running',
        awaitingPersistence: true,
        result: { content: 'Goal set. Status: in_progress.' },
      },
    });

    handlers.goal_mutations_persisted({
      toolUseIds: ['goal-create-durable'],
    }, 'goal_mutations_persisted');

    expect(blocks[0]).toMatchObject({
      type: 'tool',
      call: { status: 'done', awaitingPersistence: false },
    });
  });

  it('compensates a provisional goal success to an error when persistence fails', () => {
    const { blocks, handlers } = setup();
    handlers.tool_call_start({
      id: 'goal-complete-durable',
      name: 'update_goal',
      input: { status: 'complete' },
    }, 'tool_call_start');
    handlers.tool_call_result({
      id: 'goal-complete-durable',
      name: 'update_goal',
      result: { content: 'Goal marked complete.' },
      duration_ms: 3,
      persistence: 'pending',
    }, 'tool_call_result');
    handlers.goal_mutations_persistence_failed({
      toolUseIds: ['goal-complete-durable'],
      message: 'goal mutation lost its expected objective',
    }, 'goal_mutations_persistence_failed');

    expect(blocks[0]).toMatchObject({
      type: 'tool',
      call: {
        status: 'error',
        awaitingPersistence: false,
        result: {
          content: 'goal mutation lost its expected objective',
          isError: true,
        },
      },
    });
  });
});
