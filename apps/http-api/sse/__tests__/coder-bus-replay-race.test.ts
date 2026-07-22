/**
 * Regression — replay/subscribe race. Previously `subscribe` and
 * `subscribeWithReplay` replayed the buffer first and registered the
 * subscriber AFTER, so a (reentrant) publish during the replay loop was
 * never delivered, and a reentrant publish that triggered buffer eviction
 * could shift the live array mid-iteration and skip events. The subscriber
 * is now registered first; live events arriving during the replay are
 * queued (dedup by seq) and flushed right after it.
 *
 * Pure unit test — no HTTP server, no DB.
 */
import { describe, it, expect } from 'vitest';
import { createBus, publish, subscribe, subscribeWithReplay } from '../../coder-bus.js';

describe('subscribe — replay race', () => {
  it('delivers a reentrant publish exactly once, after the replay, in order', () => {
    const bus = createBus(new AbortController());
    publish(bus, 'a', {}); // seq 0
    publish(bus, 'b', {}); // seq 1
    const seen: Array<{ seq: number; event: string }> = [];
    subscribe(bus, (ev) => {
      seen.push({ seq: ev.seq, event: ev.event });
      if (ev.event === 'a') {
        // Reentrant publish mid-replay: before the fix this event was lost
        // (the subscriber was not yet registered).
        publish(bus, 'c', {}); // seq 2
      }
    }, -1);
    expect(seen).toEqual([
      { seq: 0, event: 'a' },
      { seq: 1, event: 'b' },
      { seq: 2, event: 'c' },
    ]);
    // Live events keep flowing after the replay.
    publish(bus, 'd', {}); // seq 3
    expect(seen).toHaveLength(4);
    expect(seen[3]).toEqual({ seq: 3, event: 'd' });
  });

  it('does not skip replay events when a reentrant publish triggers eviction', () => {
    const bus = createBus(new AbortController());
    // Fill the ring exactly to the cap so the next publish evicts the head.
    for (let i = 0; i < 2000; i++) publish(bus, 'fill', { i });
    const seen: number[] = [];
    subscribe(bus, (ev) => {
      seen.push(ev.seq);
      if (ev.seq === 0) {
        // Reentrant publish → count eviction splices the head of the live
        // buffer. The snapshot replay must still yield every event.
        publish(bus, 'trigger-eviction', {}); // seq 2000
      }
    }, -1);
    expect(seen).toHaveLength(2001);
    for (let i = 0; i < 2000; i++) expect(seen[i]).toBe(i);
    expect(seen[2000]).toBe(2000);
  });

  it('keeps strict seq order when a queued event reentrantly publishes during the drain', () => {
    const bus = createBus(new AbortController());
    publish(bus, 'a', {}); // 0
    publish(bus, 'b', {}); // 1
    const seen: number[] = [];
    subscribe(bus, (ev) => {
      seen.push(ev.seq);
      if (ev.seq === 0) {
        // Two reentrant publishes mid-replay → both queued (2, 3).
        publish(bus, 'c', {});
        publish(bus, 'd', {});
      }
      if (ev.seq === 2) {
        // Handling the FIRST queued event publishes another event (4) while
        // an older queued event (3) is still pending — it must be appended
        // and delivered AFTER it, not immediately.
        publish(bus, 'e', {});
      }
    }, -1);
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });

  it('replays only events with seq > since and stops after unsubscribe', () => {
    const bus = createBus(new AbortController());
    publish(bus, 'a', {});
    publish(bus, 'b', {});
    const seen: number[] = [];
    const off = subscribe(bus, (ev) => seen.push(ev.seq), 0);
    expect(seen).toEqual([1]);
    off();
    publish(bus, 'c', {});
    expect(seen).toEqual([1]);
    expect(bus.subscribers.size).toBe(0);
  });
});

describe('subscribeWithReplay — replay race', () => {
  it('queues live events published during the window replay', () => {
    const bus = createBus(new AbortController());
    publish(bus, 'a', {}); // 0
    publish(bus, 'b', {}); // 1
    publish(bus, 'c', {}); // 2 — deliberately NOT in the trimmed window
    const window = bus.buffer.filter((ev) => ev.seq <= 1);
    const seen: number[] = [];
    subscribeWithReplay(bus, (ev) => {
      seen.push(ev.seq);
      if (ev.seq === 0) publish(bus, 'd', {}); // seq 3 — reentrant
    }, window);
    expect(seen).toEqual([0, 1, 3]);
    publish(bus, 'e', {}); // seq 4 — live
    expect(seen).toEqual([0, 1, 3, 4]);
  });
});
