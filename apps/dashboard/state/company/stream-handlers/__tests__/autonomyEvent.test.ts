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

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION_ID = '22222222-2222-4222-8222-222222222222';

describe('mapAutonomyStreamEvent', () => {
  it('maps scheduler_dispatched to a dispatch event with server timestamp', () => {
    const ev = mapAutonomyStreamEvent('scheduler_dispatched', {
      cardId: '33333333-3333-4333-8333-333333333333',
      role: 'frontend',
      agentRunId: '42424242-4242-4242-8242-424242424242',
      at: 1111,
    });
    expect(ev).toMatchObject({
      type: 'dispatch', event: 'scheduler_dispatched',
      cardId: '33333333-3333-4333-8333-333333333333',
      role: 'frontend',
      agentRunId: '42424242-4242-4242-8242-424242424242',
      atMs: 1111,
    });
  });

  it('maps scheduler_skipped to a skip event carrying the reason', () => {
    const cardId = '99999999-9999-4999-8999-999999999999';
    const ev = mapAutonomyStreamEvent('scheduler_skipped', { cardId, reason: 'no_role', at: 5 });
    expect(ev).toMatchObject({ type: 'skip', cardId, reason: 'no_role', atMs: 5 });
  });

  it('maps scheduler_sweep to an aggregate dispatch event', () => {
    const ev = mapAutonomyStreamEvent('scheduler_sweep', { dispatched: 2, freeSlots: 4, at: 7 });
    expect(ev).toMatchObject({
      type: 'dispatch', event: 'scheduler_sweep', dispatched: 2, freeSlots: 4,
    });
  });

  it('maps plan_auto_approved to an approval event', () => {
    const ev = mapAutonomyStreamEvent('plan_auto_approved', {
      agentRunId: '42424242-4242-4242-8242-424242424242',
      role: 'backend',
    });
    expect(ev).toMatchObject({
      type: 'approval',
      agentRunId: '42424242-4242-4242-8242-424242424242',
      role: 'backend',
    });
  });

  it('maps supervisor_incident using detectedAtMs as the timestamp', () => {
    const ev = mapAutonomyStreamEvent('supervisor_incident', {
      kind: 'agent_quarantined',
      agentRunId: '77777777-7777-4777-8777-777777777777',
      detail: 'too many recoveries',
      detectedAtMs: 999,
    });
    expect(ev).toMatchObject({
      type: 'incident',
      kind: 'agent_quarantined',
      agentRunId: '77777777-7777-4777-8777-777777777777',
      detail: 'too many recoveries', atMs: 999,
    });
  });

  it('maps master_nudge (case → kind)', () => {
    const ev = mapAutonomyStreamEvent('master_nudge', {
      case: 'decision',
      agentRunId: '33333333-3333-4333-8333-333333333333',
      at: 42,
    });
    expect(ev).toMatchObject({
      type: 'nudge',
      kind: 'decision',
      agentRunId: '33333333-3333-4333-8333-333333333333',
      atMs: 42,
    });
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
      const cardId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      store.getState().autonomyPushEvent(SESSION_ID, evt({ atMs: i, cardId }));
    }
    const state = store.getState().autonomy.get(SESSION_ID)!;
    expect(state.events).toHaveLength(AUTONOMY_RING_MAX);
    expect(state.events[state.events.length - 1]!.atMs).toBe(AUTONOMY_RING_MAX + 19);
  });

  it('drops an SSE replay of the same event (same server timestamp/fields)', () => {
    const store = makeStore();
    const wire = {
      cardId: '33333333-3333-4333-8333-333333333333',
      role: 'frontend',
      agentRunId: '42424242-4242-4242-8242-424242424242',
      at: 1111,
    };
    store.getState().autonomyPushEvent(
      SESSION_ID,
      mapAutonomyStreamEvent('scheduler_dispatched', wire)!,
    );
    store.getState().autonomyPushEvent(
      SESSION_ID,
      mapAutonomyStreamEvent('scheduler_dispatched', wire)!,
    );
    expect(store.getState().autonomy.get(SESSION_ID)!.events).toHaveLength(1);
  });

  it('hydrate seeds config + historical events before live ones, deduped', () => {
    const store = makeStore();
    const live = evt({ atMs: 50, type: 'incident', kind: 'stuck_detected' });
    store.getState().autonomyPushEvent(SESSION_ID, live);
    store.getState().autonomyHydrate(SESSION_ID, {
      config: { scheduler: true, freeze: false },
      events: [
        evt({ atMs: 10, type: 'approval' }),
        // Same weak key as the live incident → dropped.
        evt({ atMs: 50, type: 'incident', kind: 'stuck_detected' }),
      ],
    });
    const state = store.getState().autonomy.get(SESSION_ID)!;
    expect(state.initialized).toBe(true);
    expect(state.config).toMatchObject({ scheduler: true });
    expect(state.events.map((e) => e.atMs)).toEqual([10, 50]);
  });

  it('setConfig replaces config without touching events', () => {
    const store = makeStore();
    store.getState().autonomyPushEvent(SESSION_ID, evt());
    store.getState().autonomySetConfig(SESSION_ID, { freeze: true });
    const state = store.getState().autonomy.get(SESSION_ID)!;
    expect(state.config).toEqual({ freeze: true });
    expect(state.events).toHaveLength(1);
  });

  it('hydrate on an empty slot works (panel mounted before stream)', () => {
    const store = makeStore();
    store.getState().autonomyHydrate(
      OTHER_SESSION_ID,
      { config: { scheduler: false }, events: [] },
    );
    const state = store.getState().autonomy.get(OTHER_SESSION_ID)!;
    expect(state.initialized).toBe(true);
    expect(state.events).toEqual([]);
  });
});
