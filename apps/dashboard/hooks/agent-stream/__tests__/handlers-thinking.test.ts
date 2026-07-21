import { describe, expect, it, vi } from 'vitest';
import { createEventHandlers } from '../handlers.js';
import type { StreamBlock, UpdateSession } from '../types.js';

function setup() {
  const blocks: StreamBlock[] = [];
  const handlers = createEventHandlers({
    sid: 1,
    blocks,
    toolIndex: new Map(),
    flush: vi.fn(),
    flushNow: vi.fn(),
    updateSession: vi.fn() as UpdateSession,
  });
  return { blocks, handlers };
}

describe('thinking stream composition', () => {
  it('coalesces reasoning across non-semantic activity and agent telemetry', () => {
    const { blocks, handlers } = setup();
    handlers.thinking({ text: 'Inspecting' }, 'thinking');
    handlers.tool_progress(
      { id: 'legacy-heartbeat', name: 'spawn_agent', elapsedMs: 1_000, note: 'still running' },
      'tool_progress',
    );
    handlers.agents_group_start(
      { groupId: 'group-1', agents: [{ index: 0, label: 'Scout' }] },
      'agents_group_start',
    );
    handlers.thinking({ text: ' and planning' }, 'thinking');

    const thinking = blocks.filter((block) => block.type === 'thinking');
    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toMatchObject({ text: 'Inspecting and planning' });
  });

  it('starts a new reasoning card across a real tool boundary', () => {
    const { blocks, handlers } = setup();
    handlers.thinking({ text: 'Before' }, 'thinking');
    handlers.tool_call_start({ id: 'tool-1', name: 'read_file' }, 'tool_call_start');
    handlers.thinking({ text: 'After' }, 'thinking');

    expect(blocks.filter((block) => block.type === 'thinking')).toHaveLength(2);
  });
});
