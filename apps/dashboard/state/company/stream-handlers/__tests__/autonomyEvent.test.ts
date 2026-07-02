/**
 * C1 — tests for the autonomy stream mapper (SSE event → AutonomyEvent)
 * and the autonomy slice ring semantics (bound, dedup, hydrate merge).
 */
import { describe, expect, it } from 'vitest';
import { create } from 'zustand';
import { mapAutonomyStreamEvent } from '../autonomyEvent.js';
import {
  createAutonomySlice,
  AUTONOMY_RING_MAX,
  type AutonomyEvent,
  type AutonomySlice,
} from '../../autonomySlice.js';

describe('mapAutonomyStreamEvent', () => {
  it('maps scheduler_dispatched to a dispatch event with server timestamp', () => {
    const ev = mapAutonomyStreamEvent('scheduler_dispatched', {
      cardId: 3, role: 'frontend', agentRunId: 42, at: 1111,
    });
    expect(ev).toMatchObject({
      type: 'dispatch', event: 'scheduler_dispatched',
      cardId: 3, role: 'frontend', agentRunId: 42, atMs: 1111,
    });
  });

  it('maps scheduler_skipped to a skip event carrying the reason', () => {
    const ev = mapAutonomyStreamEvent('scheduler_skipped', { cardId: 9, reason: 'no_role', at: 5 });
    expect(ev).toMatchObject({ type: 'skip', cardId: 9, reason: 'no_role', atMs: 5 });
  });

  it('maps scheduler_sweep to an aggregate dispatch event', () => {
    const ev = mapAutonomyStreamEvent('scheduler_sweep', { dispatched: 2, freeSlots: 4, at: 7 });
    expect(ev).toMatchObject({
      type: 'dispatch', event: 'scheduler_sweep', dispatched: 2, freeSlots: 4,
    });
  });

  it('maps plan_auto_approved to an approval event', () => {
    const ev = mapAutonomyStreamEvent('plan_auto_approved', { agentRunId: 42, role: 'backend' });
    expect(ev).toMatchObject({ type: 'approval', agentRunId: 42, role: 'backend' });
  });

  it('maps supervisor_incident using detectedAtMs as the timestamp', () => {
    const ev = mapAutonomyStreamEvent('supervisor_incident', {
      kind: 'agent_quarantined', agentRunId: 7, detail: 'too many recoveries', detectedAtMs: 999,
    });
    expect(ev).toMatchObject({
      type: 'incident', kind: 'agent_quarantined', agentRunId: 7,
      detail: 'too many recoveries', atMs: 999,
    });
  });

  it('maps master_nudge (case → kind)', () => {
    const ev = mapAutonomyStreamEvent('master_nudge', { case: 'decision', agentRunId: 3, at: 42 });
    expect(ev).toMatchObject({ type: 'nudge', kind: 'decision', agentRunId: 3, atMs: 42 });
  });

  it('returns null for non-autonomy events', () => {
    expect(mapAutonomyStreamEvent('agent_event', { foo: 1 })).toBeNull();
    expect(mapAutonomyStreamEvent('board_entry', {})).toBeNull();
    expect(mapAutonomyStreamEvent('kanban_card_moved', {})).toBeNull();
  });

  it('survives malformed payloads (null / array / wrong types)', () => {
    for (const payload of [null, undefined, [], 'x', { cardId: 'NaN', at: 'later' }]) {
      const ev = mapAutonomyStreamEvent('scheduler_dispatched', payload);
      expect(ev?.type).toBe('dispatch');
      expect(typeof ev?.atMs).toBe('number');
    }
  });

  it('generates unique ids for identical consecutive payloads', () => {
    const a = mapAutonomyStreamEvent('scheduler_sweep', { dispatched: 1, at: 1 });
    const b = mapAutonomyStreamEvent('scheduler_sweep', { dispatched: 1, at: 1 });
    expect(a?.id).not.toBe(b?.id);
  });
});

describe('autonomySlice', () => {
  function makeStore() {
    return create<AutonomySlice>()((...a) => ({ ...createAutonomySlice(...a) }));
  }
  const evt = (over: Partial<AutonomyEvent> = {}): AutonomyEvent => ({
    id: over.id ?? `id-${Math.random()}`,
    atMs: 1,
    type: 'dispatch',
    ...over,
  });

  it('pushes events and keeps the ring bounded', () => {
    const store = makeStore();
    for (let i = 0; i < AUTONOMY_RING_MAX + 20; i++) {
      store.getState().autonomyPushEvent(1, evt({ atMs: i, cardId: i }));
    }
    const state = store.getState().autonomy.get(1)!;
    expect(state.events).toHaveLength(AUTONOMY_RING_MAX);
    expect(state.events[state.events.length - 1]!.atMs).toBe(AUTONOMY_RING_MAX + 19);
  });

  it('drops an SSE replay of the same event (same server timestamp/fields)', () => {
    const store = makeStore();
    const wire = { cardId: 3, role: 'frontend', agentRunId: 42, at: 1111 };
    store.getState().autonomyPushEvent(1, mapAutonomyStreamEvent('scheduler_dispatched', wire)!);
    store.getState().autonomyPushEvent(1, mapAutonomyStreamEvent('scheduler_dispatched', wire)!);
    expect(store.getState().autonomy.get(1)!.events).toHaveLength(1);
  });

  it('hydrate seeds config + historical events before live ones, deduped', () => {
    const store = makeStore();
    const live = evt({ atMs: 50, type: 'incident', kind: 'stuck_detected' });
    store.getState().autonomyPushEvent(1, live);
    store.getState().autonomyHydrate(1, {
      config: { scheduler: true, freeze: false },
      events: [
        evt({ atMs: 10, type: 'approval' }),
        // Same weak key as the live incident → dropped.
        evt({ atMs: 50, type: 'incident', kind: 'stuck_detected' }),
      ],
    });
    const state = store.getState().autonomy.get(1)!;
    expect(state.initialized).toBe(true);
    expect(state.config).toMatchObject({ scheduler: true });
    expect(state.events.map((e) => e.atMs)).toEqual([10, 50]);
  });

  it('setConfig replaces config without touching events', () => {
    const store = makeStore();
    store.getState().autonomyPushEvent(1, evt());
    store.getState().autonomySetConfig(1, { freeze: true });
    const state = store.getState().autonomy.get(1)!;
    expect(state.config).toEqual({ freeze: true });
    expect(state.events).toHaveLength(1);
  });

  it('hydrate on an empty slot works (panel mounted before stream)', () => {
    const store = makeStore();
    store.getState().autonomyHydrate(7, { config: { scheduler: false }, events: [] });
    const state = store.getState().autonomy.get(7)!;
    expect(state.initialized).toBe(true);
    expect(state.events).toEqual([]);
  });
});
