import { describe, expect, it, vi } from 'vitest';
import { createEventHandlers } from '../handlers.js';
import { EMPTY_STATE, type SessionState, type StreamBlock, type UpdateSession } from '../types.js';

function setup() {
  const blocks: StreamBlock[] = [];
  const toolIndex = new Map<string, number>();
  let state: SessionState = { ...EMPTY_STATE };
  const updateSession: UpdateSession = vi.fn((_sid, patch) => {
    const next = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...next };
  });
  const handlers = createEventHandlers({
    sid: '00000000-0000-4000-8000-000000000001',
    blocks,
    toolIndex,
    flush: vi.fn(),
    flushNow: vi.fn(),
    updateSession,
  });
  return { handlers, getState: () => state };
}

describe('live snapshot inventory refresh', () => {
  it('refreshes once after an edit tool completes, not once per file write', () => {
    const { handlers, getState } = setup();
    handlers.tool_call_start({ id: 'edit-1', name: 'apply_patch', input: {} }, 'tool_call_start');
    handlers.session_snapshot_changed({}, 'session_snapshot_changed');
    handlers.session_snapshot_changed({}, 'session_snapshot_changed');

    expect(getState()).toMatchObject({
      snapshotTick: 2,
      snapshotInventoryTick: 0,
    });

    handlers.tool_call_result({
      id: 'edit-1',
      duration_ms: 25,
      result: { content: 'Done!' },
    }, 'tool_call_result');

    expect(getState()).toMatchObject({
      snapshotTick: 2,
      snapshotInventoryTick: 1,
    });

    // A replayed/duplicate terminal event has no new dirty snapshot to flush.
    handlers.tool_call_result({
      id: 'edit-1',
      duration_ms: 25,
      result: { content: 'Done!' },
    }, 'tool_call_result');
    expect(getState().snapshotInventoryTick).toBe(1);
  });

  it('does not refresh the snapshot inventory after a read-only tool', () => {
    const { handlers, getState } = setup();
    handlers.tool_call_start({ id: 'read-1', name: 'read_file', input: {} }, 'tool_call_start');
    handlers.tool_call_result({
      id: 'read-1',
      duration_ms: 10,
      result: { content: 'source' },
    }, 'tool_call_result');

    expect(getState().snapshotInventoryTick).toBe(0);
  });
});
