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
    sid: '00000000-0000-4000-8000-000000000007',
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
  it('publishes each reported usage once, including cache-only turns and identical successive counts', () => {
    const { handlers, blocks } = setup();
    const event = {
      operation_id: 'assistant:run:message:2',
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 16 },
      message: { content: [{ type: 'tool_use', id: 'edit-a' }] },
    };
    handlers.message_complete(event, 'message_complete');
    handlers.message_complete(event, 'message_complete');
    handlers.message_complete({ ...event, operation_id: 'assistant:run:message:3' }, 'message_complete');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'usage', id: event.operation_id, toolIds: ['edit-a'],
      tokens: { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 16 } });
    handlers.user_message_boundary({}, 'user_message_boundary');
    expect(blocks).toHaveLength(0);
    handlers.message_complete({ ...event, usage: {} }, 'message_complete');
    expect(blocks).toMatchObject([{ type: 'usage', id: event.operation_id, toolIds: ['edit-a'],
      tokens: { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 } }]);
  });
  it('preserves an unmetered call boundary and applies late counters to its original position exactly once', () => {
    const { blocks, handlers } = setup();
    handlers.thinking({ text: 'Reading paths' }, 'thinking');
    const first = { operation_id: 'first', message: { content: [{ type: 'tool_use', id: 'a' }] }, usage: null };
    handlers.message_complete(first, 'message_complete');
    handlers.message_complete(first, 'message_complete');
    handlers.tool_call_start({ id: 'a', name: 'read_file' }, 'tool_call_start');
    handlers.text({ text: 'Next call' }, 'text');
    handlers.message_complete({ operation_id: 'next', usage: { input_tokens: 10, output_tokens: 1 } }, 'message_complete');
    expect(blocks.map(block => block.type)).toEqual(['thinking', 'usage', 'tool', 'text', 'usage']);
    expect(blocks[1]).toMatchObject({ id: 'first', toolIds: ['a'], tokens: { input_tokens: 0, output_tokens: 0 } });
    const late = { operation_id: 'first', usage: { input_tokens: 4, output_tokens: 2 } };
    handlers.message_complete(late, 'message_complete');
    handlers.message_complete(late, 'message_complete');
    expect(blocks.filter(block => block.type === 'usage')).toMatchObject([
      { id: 'first', toolIds: ['a'], tokens: { input_tokens: 4, output_tokens: 2 } },
      { id: 'next', tokens: { input_tokens: 10, output_tokens: 1 } },
    ]);
  });

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
      id: 'task-update-1',
      name: 'update_task',
      result: {
        content: 'Task update refused: task does not exist.',
        isError: true,
        input: { status: 'complete' },
      },
      duration_ms: 0,
    };

    handlers.tool_call_result(refusal, 'tool_call_result');

    expect(blocks).toHaveLength(1);
    expect(toolIndex.get('task-update-1')).toBe(0);
    expect(blocks[0]).toMatchObject({
      type: 'tool',
      call: {
        id: 'task-update-1',
        name: 'update_task',
        input: { status: 'complete' },
        result: {
          content: 'Task update refused: task does not exist.',
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
});
