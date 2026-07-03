import { describe, expect, it } from 'vitest';
import { createBus, publish, subscribe } from '../../coder-bus.js';
import { effectiveSince } from '../pumpBusToSSE.js';

describe('coder-bus busId', () => {
  it('assigns a unique bus id per instance', () => {
    const a = createBus(new AbortController());
    const b = createBus(new AbortController());
    expect(a.busId).toBeTruthy();
    expect(b.busId).toBeTruthy();
    expect(a.busId).not.toBe(b.busId);
  });
});

describe('subscribe replay cursor', () => {
  it('replays only events with seq > since, then live events', () => {
    const bus = createBus(new AbortController());
    publish(bus, 'a', {});
    publish(bus, 'b', {});
    publish(bus, 'c', {});
    const seen: number[] = [];
    subscribe(bus, (ev) => seen.push(ev.seq), 1);
    expect(seen).toEqual([2]);
    publish(bus, 'd', {});
    expect(seen).toEqual([2, 3]);
  });
});

describe('effectiveSince', () => {
  it('keeps a cursor that belongs to this bus', () => {
    expect(effectiveSince(5, 10)).toBe(5);
    expect(effectiveSince(9, 10)).toBe(9);
    expect(effectiveSince(-1, 0)).toBe(-1);
  });

  it('falls back to a full replay for a stale cursor from a previous bus', () => {
    // Bus seq restarts at 0 per run; a Last-Event-ID beyond nextSeq cannot
    // have come from this bus.
    expect(effectiveSince(10, 10)).toBe(-1);
    expect(effectiveSince(10877, 5)).toBe(-1);
  });
});
