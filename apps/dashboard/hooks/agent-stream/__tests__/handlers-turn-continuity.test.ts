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
});
