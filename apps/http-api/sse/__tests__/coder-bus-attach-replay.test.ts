/**
 * Perf W2 — trimmed attach replay. A cursorless attach must NOT replay the
 * whole ring: it gets cross-turn state kinds + the live tail (from the last
 * `message_complete`, inclusive), in strict buffer order, under a hard cap.
 * Cursor subscriptions (`since >= 0`) keep the untouched full-replay path.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  attachReplayCap,
  buildAttachReplay,
  createBus,
  DEFAULT_ATTACH_REPLAY_MAX_EVENTS,
  publish,
  subscribe,
  subscribeWithReplay,
  type BufferedEvent,
} from '../../coder-bus.js';

afterEach(() => {
  delete process.env.CODER_ATTACH_REPLAY_MAX_EVENTS;
});

function seqs(events: BufferedEvent[]): number[] {
  return events.map((e) => e.seq);
}

describe('buildAttachReplay', () => {
  it('keeps transcript+state kinds from old turns + the live tail; drops old deltas/logs', () => {
    const bus = createBus(new AbortController());
    publish(bus, 'text', { delta: 'old-turn' });          // 0 — old delta, dropped
    publish(bus, 'tasks_posted', { tasks: [] });          // 1 — state, kept
    publish(bus, 'tool_call_start', { id: 't1' });        // 2 — transcript, kept
    publish(bus, 'tool_call_result', { id: 't1' });       // 3 — transcript, kept
    publish(bus, 'message_complete', { i: 'turn1' });     // 4 — transcript, kept
    publish(bus, 'agents_group_start', { gid: 'g1' });    // 5 — state, kept
    publish(bus, 'worker_log', { message: 'noise' });     // 6 — old log, dropped
    publish(bus, 'thinking', { delta: 'mid' });           // 7 — old delta, dropped
    publish(bus, 'message_complete', { i: 'turn2' });     // 8 — LAST boundary, kept
    publish(bus, 'text', { delta: 'live-1' });            // 9 — tail, kept
    publish(bus, 'worker_log', { message: 'live' });      // 10 — tail, kept

    expect(seqs(buildAttachReplay(bus))).toEqual([1, 2, 3, 4, 5, 8, 9, 10]);
  });

  it('with no message_complete the whole buffer is the live turn', () => {
    const bus = createBus(new AbortController());
    publish(bus, 'text', { delta: 'a' });
    publish(bus, 'thinking', { delta: 'b' });
    expect(seqs(buildAttachReplay(bus))).toEqual([0, 1]);
  });

  it('applies the hard cap keeping the MOST RECENT events', () => {
    process.env.CODER_ATTACH_REPLAY_MAX_EVENTS = '3';
    const bus = createBus(new AbortController());
    for (let i = 0; i < 10; i++) publish(bus, 'text', { delta: `d${i}` });
    expect(seqs(buildAttachReplay(bus))).toEqual([7, 8, 9]);
    expect(attachReplayCap()).toBe(3);
  });

  it('cap default is DEFAULT_ATTACH_REPLAY_MAX_EVENTS and garbage env falls back', () => {
    process.env.CODER_ATTACH_REPLAY_MAX_EVENTS = 'banana';
    expect(attachReplayCap()).toBe(DEFAULT_ATTACH_REPLAY_MAX_EVENTS);
  });
});

describe('subscribeWithReplay vs subscribe', () => {
  it('subscribeWithReplay replays the given window then forwards live events', () => {
    const bus = createBus(new AbortController());
    publish(bus, 'text', { delta: 'old' });               // 0
    publish(bus, 'message_complete', {});                 // 1
    publish(bus, 'text', { delta: 'live' });              // 2

    const seen: number[] = [];
    subscribeWithReplay(bus, (ev) => seen.push(ev.seq), buildAttachReplay(bus));
    expect(seen).toEqual([1, 2]);
    publish(bus, 'text', { delta: 'after' });             // 3 — live
    expect(seen).toEqual([1, 2, 3]);
  });

  it('cursor subscriptions keep the untouched full replay (dedup contract)', () => {
    const bus = createBus(new AbortController());
    for (let i = 0; i < 5; i++) publish(bus, 'text', { delta: `d${i}` });
    const seen: number[] = [];
    subscribe(bus, (ev) => seen.push(ev.seq), 1);
    expect(seen).toEqual([2, 3, 4]);
  });
});
