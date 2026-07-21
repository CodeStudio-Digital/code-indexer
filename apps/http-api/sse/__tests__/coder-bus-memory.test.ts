import { describe, expect, it, vi } from 'vitest';
import {
  BUFFER_BYTE_CAP,
  BUFFER_CAP,
  clearReplayBuffer,
  createBus,
  publish,
  subscribe,
} from '../../coder-bus.js';

describe('coder replay buffer memory budget', () => {
  it('keeps the existing row cap for small events', () => {
    const bus = createBus(new AbortController());
    for (let index = 0; index < BUFFER_CAP + 5; index++) publish(bus, 'text', { text: 'x' });

    expect(bus.buffer).toHaveLength(BUFFER_CAP);
    expect(bus.droppedBufferEvents).toBe(5);
    expect(bus.buffer[0]?.seq).toBe(5);
  });

  it('evicts replay rows by retained bytes while still delivering them live', () => {
    const bus = createBus(new AbortController());
    const live = vi.fn();
    subscribe(bus, live, bus.nextSeq);

    const chunk = 'x'.repeat(Math.ceil(BUFFER_BYTE_CAP / 2));
    publish(bus, 'tool_call_result', { result: chunk });
    publish(bus, 'tool_call_result', { result: chunk });

    expect(live).toHaveBeenCalledTimes(2);
    expect(bus.buffer).toHaveLength(1);
    expect(bus.droppedBufferEvents).toBe(1);
    expect(bus.bufferBytes).toBeLessThanOrEqual(BUFFER_BYTE_CAP);
  });

  it('does not retain one event that exceeds the whole replay budget', () => {
    const bus = createBus(new AbortController());
    const live = vi.fn();
    subscribe(bus, live, bus.nextSeq);

    publish(bus, 'tool_call_result', { result: 'x'.repeat(BUFFER_BYTE_CAP + 1) });

    expect(live).toHaveBeenCalledOnce();
    expect(bus.buffer).toHaveLength(0);
    expect(bus.droppedBufferEvents).toBe(1);
    expect(bus.bufferBytes).toBe(0);
  });

  it('compacts a full replay ring correctly when one oversized row evicts it', () => {
    const bus = createBus(new AbortController());
    for (let index = 0; index < BUFFER_CAP; index++) publish(bus, 'text', { text: 'x' });

    publish(bus, 'tool_call_result', { result: 'x'.repeat(BUFFER_BYTE_CAP + 1) });

    expect(bus.buffer).toEqual([]);
    expect(bus.bufferEventBytes).toEqual([]);
    expect(bus.bufferBytes).toBe(0);
    expect(bus.droppedBufferEvents).toBe(BUFFER_CAP + 1);
  });

  it('releases all replay accounting with the worker-side buffer', () => {
    const bus = createBus(new AbortController());
    publish(bus, 'text', { text: 'hello' });

    clearReplayBuffer(bus);

    expect(bus.buffer).toEqual([]);
    expect(bus.bufferEventBytes).toEqual([]);
    expect(bus.bufferBytes).toBe(0);
  });
});
