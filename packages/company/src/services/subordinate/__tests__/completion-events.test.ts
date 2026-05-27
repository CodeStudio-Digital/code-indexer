/**
 * Tests for C5 — SubordinateCompletionBus.
 *
 * Locks in:
 *   - registration / unsubscribe
 *   - emit() is fire-and-forget (caller returns before listeners run)
 *   - listener errors don't affect other listeners or future emits
 *   - emitSync runs listeners in order, awaiting async ones
 *   - clear() drops all
 */
import { describe, expect, it, vi } from 'vitest';
import {
  SubordinateCompletionBus,
  type SubordinateCompletionEvent,
} from '../completion-events.js';

function makeEvent(overrides: Partial<SubordinateCompletionEvent> = {}): SubordinateCompletionEvent {
  return {
    agentRunId: 1,
    role: 'frontend',
    outcome: 'completed',
    emittedAtMs: Date.now(),
    ...overrides,
  };
}

describe('SubordinateCompletionBus', () => {
  it('starts empty', () => {
    const bus = new SubordinateCompletionBus();
    expect(bus.size()).toBe(0);
  });

  it('on() registers a listener and returns an unsubscribe', async () => {
    const bus = new SubordinateCompletionBus();
    const listener = vi.fn();
    const off = bus.on(listener);
    expect(bus.size()).toBe(1);

    await bus.emitSync(makeEvent());
    expect(listener).toHaveBeenCalledTimes(1);

    off();
    expect(bus.size()).toBe(0);
    await bus.emitSync(makeEvent());
    expect(listener).toHaveBeenCalledTimes(1); // unchanged
  });

  it('emit() is fire-and-forget — caller returns before listeners run', async () => {
    const bus = new SubordinateCompletionBus();
    let listenerRan = false;
    bus.on(() => { listenerRan = true; });

    bus.emit(makeEvent());
    // Listeners should NOT have fired yet (scheduled via setImmediate).
    expect(listenerRan).toBe(false);

    // Yield to event loop: setImmediate runs.
    await new Promise<void>((r) => setImmediate(r));
    expect(listenerRan).toBe(true);
  });

  it('emitSync awaits async listeners in registration order', async () => {
    const bus = new SubordinateCompletionBus();
    const order: string[] = [];
    bus.on(async () => { await new Promise((r) => setTimeout(r, 10)); order.push('first'); });
    bus.on(() => { order.push('second'); });

    await bus.emitSync(makeEvent());
    expect(order).toEqual(['first', 'second']);
  });

  it('one listener throwing does not affect other listeners', async () => {
    const bus = new SubordinateCompletionBus();
    const a = vi.fn();
    const b = vi.fn(() => { throw new Error('listener-B exploded'); });
    const c = vi.fn();
    bus.on(a);
    bus.on(b);
    bus.on(c);

    await bus.emitSync(makeEvent());
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it('subsequent emits still work after a listener error', async () => {
    const bus = new SubordinateCompletionBus();
    let count = 0;
    bus.on(() => { count++; throw new Error('boom'); });

    await bus.emitSync(makeEvent());
    await bus.emitSync(makeEvent());
    expect(count).toBe(2);
  });

  it('clear() removes all listeners', async () => {
    const bus = new SubordinateCompletionBus();
    const listener = vi.fn();
    bus.on(listener);
    bus.on(vi.fn());
    bus.clear();
    expect(bus.size()).toBe(0);
    await bus.emitSync(makeEvent());
    expect(listener).not.toHaveBeenCalled();
  });

  it('listener snapshot is frozen at emit time (concurrent on/off does not affect this event)', async () => {
    const bus = new SubordinateCompletionBus();
    const fired: string[] = [];
    bus.on(() => { fired.push('a'); });
    bus.on(() => {
      fired.push('b');
      // mid-emit: add a third listener. It must NOT fire for THIS event.
      bus.on(() => { fired.push('c-added-mid-emit'); });
    });
    await bus.emitSync(makeEvent());
    expect(fired).toEqual(['a', 'b']);

    // But it fires on the NEXT event.
    fired.length = 0;
    await bus.emitSync(makeEvent());
    expect(fired).toEqual(['a', 'b', 'c-added-mid-emit']);
  });

  it('event payload propagates unchanged', async () => {
    const bus = new SubordinateCompletionBus();
    const received: SubordinateCompletionEvent[] = [];
    bus.on((e) => { received.push(e); });

    const event = makeEvent({
      agentRunId: 42,
      role: 'qa',
      outcome: 'failed',
      failureReason: 'timeout',
      durationMs: 5_000,
      tokensUsed: { input: 1000, output: 500 },
      kanbanCardId: 7,
    });
    await bus.emitSync(event);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);
  });
});
