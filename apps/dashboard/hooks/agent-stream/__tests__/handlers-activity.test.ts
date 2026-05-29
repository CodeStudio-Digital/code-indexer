import { describe, expect, it, vi } from 'vitest';
import { createEventHandlers } from '../handlers.js';
import type { StreamActivityBlock, StreamBlock, UpdateSession } from '../types.js';

function setup() {
  const blocks: StreamBlock[] = [];
  const toolIndex = new Map<string, number>();
  const flush = vi.fn();
  const flushNow = vi.fn();
  const updateSession: UpdateSession = vi.fn();
  const handlers = createEventHandlers({
    sid: 1,
    blocks,
    toolIndex,
    flush,
    flushNow,
    updateSession,
  });
  return { handlers, blocks, flush };
}

function activity(blocks: StreamBlock[], id: string): StreamActivityBlock | undefined {
  const block = blocks.find((b) => b.type === 'activity' && b.id === id);
  return block?.type === 'activity' ? block : undefined;
}

describe('activity handlers', () => {
  it('creates and updates a compact activity from operation events', () => {
    const { handlers, blocks } = setup();

    handlers.operation_started(
      {
        opId: 'provider-chat:run:1',
        kind: 'provider',
        label: 'zai:glm-5',
        phase: 'starting',
        status: 'running',
        startedAt: 1000,
        elapsedMs: 0,
      },
      'operation_started',
    );
    handlers.operation_progress(
      {
        opId: 'provider-chat:run:1',
        kind: 'provider',
        label: 'zai:glm-5',
        phase: 'streaming',
        status: 'running',
        note: 'awaiting provider',
        elapsedMs: 5000,
      },
      'operation_progress',
    );

    expect(activity(blocks, 'provider-chat:run:1')).toMatchObject({
      kind: 'provider',
      label: 'zai:glm-5',
      phase: 'streaming',
      note: 'awaiting provider',
      elapsedMs: 5000,
    });
  });

  it('marks terminal operation status without re-creating completed activities', () => {
    const { handlers, blocks, flush } = setup();

    handlers.operation_finished(
      {
        opId: 'provider-chat:run:1',
        kind: 'provider',
        label: 'zai:glm-5',
        phase: 'completed',
        status: 'completed',
      },
      'operation_finished',
    );
    expect(activity(blocks, 'provider-chat:run:1')).toBeUndefined();
    expect(flush).not.toHaveBeenCalled();

    handlers.operation_started(
      { opId: 'op:sub', kind: 'subagent', label: 'Explore', status: 'running' },
      'operation_started',
    );
    handlers.operation_finished(
      { opId: 'op:sub', kind: 'subagent', label: 'Explore', status: 'timed_out', phase: 'timeout' },
      'operation_finished',
    );
    expect(activity(blocks, 'op:sub')).toMatchObject({ status: 'timed_out', phase: 'timeout' });
  });

  it('removes provider activity when visible text arrives', () => {
    const { handlers, blocks } = setup();
    handlers.provider_call(
      { runId: 'run', turn: 1, provider: 'zai', model: 'glm-5', toolCount: 40 },
      'provider_call',
    );
    expect(activity(blocks, 'provider-chat:run:1')).toBeDefined();

    handlers.text({ text: 'hello' }, 'text');

    expect(activity(blocks, 'provider-chat:run:1')).toBeUndefined();
    expect(blocks.at(-1)).toMatchObject({ type: 'text', text: 'hello' });
  });

  it('keeps the chat alive between a tool result and the next tool start', () => {
    const { handlers, blocks } = setup();
    handlers.tool_call_start({ id: 'tool_1', name: 'exec_command' }, 'tool_call_start');
    handlers.tool_call_result(
      { id: 'tool_1', result: { content: 'ok' }, duration_ms: 10 },
      'tool_call_result',
    );
    handlers.tool_progress(
      { id: 'provider-chat:run:2', name: 'provider.chat', elapsedMs: 3000, note: 'awaiting provider' },
      'tool_progress',
    );
    expect(activity(blocks, 'provider-chat:run:2')).toMatchObject({
      kind: 'provider',
      status: 'running',
    });

    handlers.tool_call_start({ id: 'tool_2', name: 'read_file' }, 'tool_call_start');

    expect(activity(blocks, 'provider-chat:run:2')).toBeUndefined();
    expect(blocks.at(-1)).toMatchObject({ type: 'tool', call: { id: 'tool_2' } });
  });
});
