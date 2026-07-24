/**
 * Perf W2 — trimmed attach replay. A cursorless attach must NOT replay the
 * whole ring: it gets capped cross-turn state kinds + the complete live tail
 * (from the last `message_complete`, inclusive), in strict buffer order.
 * Cursor subscriptions (`since >= 0`) keep the untouched full-replay path.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  attachReplayCap,
  attachReplayTrimEnabled,
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
  delete process.env.CODER_ATTACH_REPLAY_TRIM;
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

  it('never applies the prefix cap to a live turn with no message_complete', () => {
    process.env.CODER_ATTACH_REPLAY_MAX_EVENTS = '3';
    const bus = createBus(new AbortController());
    for (let i = 0; i < 10; i++) publish(bus, 'text', { delta: `d${i}` });
    expect(seqs(buildAttachReplay(bus))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(attachReplayCap()).toBe(3);
  });

  it('caps only reconstructible cross-turn state and preserves the complete live tail', () => {
    process.env.CODER_ATTACH_REPLAY_MAX_EVENTS = '3';
    const bus = createBus(new AbortController());
    for (let i = 0; i < 6; i++) {
      publish(bus, 'tasks_posted', { version: i });
    }
    publish(bus, 'message_complete', { turn: 1 });
    for (let i = 0; i < 10; i++) publish(bus, 'text', { delta: `live-${i}` });

    expect(seqs(buildAttachReplay(bus))).toEqual([
      3, 4, 5,
      6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
  });

  it('cap default is DEFAULT_ATTACH_REPLAY_MAX_EVENTS and garbage env falls back', () => {
    process.env.CODER_ATTACH_REPLAY_MAX_EVENTS = 'banana';
    expect(attachReplayCap()).toBe(DEFAULT_ATTACH_REPLAY_MAX_EVENTS);
  });

  it('enables bounded semantic replay by default with an emergency opt-out', () => {
    expect(attachReplayTrimEnabled()).toBe(true);
    process.env.CODER_ATTACH_REPLAY_TRIM = '1';
    expect(attachReplayTrimEnabled()).toBe(true);
    process.env.CODER_ATTACH_REPLAY_TRIM = '0';
    expect(attachReplayTrimEnabled()).toBe(false);
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
