import { describe, expect, it } from 'vitest';
import { TurnProjector, type TurnProjectorScheduler } from '../turn-projector.js';
import { EMPTY_STATE, type SessionState, type UpdateSession } from '../types.js';

function harness() {
  let state: SessionState = { ...EMPTY_STATE };
  let nextHandle = 1;
  const frames = new Map<number, FrameRequestCallback>();
  const fallbacks = new Map<number, () => void>();
  const scheduler: TurnProjectorScheduler = {
    requestFrame(callback) {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame(handle) {
      frames.delete(handle);
    },
    setFallback(callback) {
      const handle = nextHandle++ as unknown as ReturnType<typeof setTimeout>;
      fallbacks.set(handle as unknown as number, callback);
      return handle;
    },
    clearFallback(handle) {
      fallbacks.delete(handle as unknown as number);
    },
  };
  const updateSession: UpdateSession = (_sessionId, patch) => {
    const next = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...next };
  };
  return {
    scheduler,
    updateSession,
    state: () => state,
    flushFrame() {
      const pending = [...frames.entries()];
      frames.clear();
      for (const [, callback] of pending) callback(0);
    },
  };
}

describe('TurnProjector', () => {
  it('folds ordered token events into one frame publication', () => {
    const test = harness();
    const projector = new TurnProjector({
      sessionId: 'session-1',
      updateSession: test.updateSession,
      scheduler: test.scheduler,
    });

    projector.dispatch('text', { text: 'Hello' });
    projector.dispatch('text', { text: ' world' });

    expect(test.state().currentTurn?.blocks).toEqual([]);
    test.flushFrame();
    expect(test.state().currentTurn?.blocks).toMatchObject([
      { type: 'text', text: 'Hello world' },
    ]);
  });

  it('publishes a user boundary synchronously and drops the previous semantic turn', () => {
    const test = harness();
    const projector = new TurnProjector({
      sessionId: 'session-2',
      initialBlocks: [{ type: 'text', text: 'previous answer', id: 'text-1' }],
      updateSession: test.updateSession,
      scheduler: test.scheduler,
    });

    projector.dispatch('user_message_boundary', { round_message_ids: ['message-2'] });

    expect(test.state().currentTurn?.blocks).toEqual([]);
  });

  it('commits the last pending frame before an owned stream is disposed', () => {
    const test = harness();
    const projector = new TurnProjector({
      sessionId: 'session-3',
      updateSession: test.updateSession,
      scheduler: test.scheduler,
    });

    projector.dispatch('text', { text: 'final token' });
    projector.dispose(true);

    expect(test.state().currentTurn?.blocks).toMatchObject([
      { type: 'text', text: 'final token' },
    ]);
    expect(projector.dispatch('text', { text: ' ignored' })).toBe(false);
  });

  it('bumps the structural revision only for events that change the block set', () => {
    const test = harness();
    const projector = new TurnProjector({
      sessionId: 'session-4',
      updateSession: test.updateSession,
      scheduler: test.scheduler,
    });

    projector.dispatch('text', { text: 'streaming' });
    test.flushFrame();
    expect(test.state().currentTurn?.rev).toBe(0);

    projector.dispatch('tool_call_start', { id: 't1', name: 'read_file' });
    test.flushFrame();
    expect(test.state().currentTurn?.rev).toBe(1);

    projector.dispatch('thinking', { text: 'more' });
    test.flushFrame();
    expect(test.state().currentTurn?.rev).toBe(1);
  });

  describe('startsMidTurn (cursorless reattach)', () => {
    it('keeps the accumulated turn until the replay rebuilds it', () => {
      const test = harness();
      test.updateSession('session-5', {
        currentTurn: { blocks: [{ type: 'text', text: 'accumulated' }] },
      });

      // Publishing an empty buffer from the constructor would wipe this.
      const projector = new TurnProjector({
        sessionId: 'session-5',
        updateSession: test.updateSession,
        scheduler: test.scheduler,
        startsMidTurn: true,
      });
      expect(test.state().currentTurn?.blocks).toMatchObject([{ text: 'accumulated' }]);

      projector.dispatch('text', { text: 'replayed' });
      test.flushFrame();
      expect(test.state().currentTurn?.startsMidTurn).toBe(true);
    });

    it('drops the suffix marker once a user boundary realigns the buffer', () => {
      const test = harness();
      const projector = new TurnProjector({
        sessionId: 'session-6',
        initialBlocks: [{ type: 'text', text: 'replayed tail' }],
        updateSession: test.updateSession,
        scheduler: test.scheduler,
        startsMidTurn: true,
      });
      expect(test.state().currentTurn?.startsMidTurn).toBe(true);

      projector.dispatch('user_message_boundary', { round_message_ids: ['m-2'] });

      expect(test.state().currentTurn?.startsMidTurn).toBeUndefined();
    });

    it('publishes normally when the stream owns the run from its start', () => {
      const test = harness();
      new TurnProjector({
        sessionId: 'session-7',
        updateSession: test.updateSession,
        scheduler: test.scheduler,
      });

      expect(test.state().currentTurn?.blocks).toEqual([]);
      expect(test.state().currentTurn?.startsMidTurn).toBeUndefined();
    });
  });
});
