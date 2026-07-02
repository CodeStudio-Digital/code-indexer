/**
 * Tests for the pure autonomous-scheduler decision core.
 */
import { describe, expect, it } from 'vitest';
import {
  findOrphanedCards,
  selectDispatchTargets,
  type SchedulerCard,
  type SchedulerRun,
} from '../dispatch-core.js';

function card(over: Partial<SchedulerCard> & { id: number }): SchedulerCard {
  return {
    column: 'todo',
    blockedBy: [],
    assignedAgentRunIds: [],
    ...over,
  };
}

describe('findOrphanedCards', () => {
  it('flags an in_progress card whose only agent is dead', () => {
    const cards = [card({ id: 1, column: 'in_progress', assignedAgentRunIds: [10] })];
    const runs: SchedulerRun[] = [{ agentRunId: 10, live: false }];
    expect(findOrphanedCards(cards, runs)).toEqual([1]);
  });

  it('does NOT flag an in_progress card with a live agent', () => {
    const cards = [card({ id: 1, column: 'in_progress', assignedAgentRunIds: [10] })];
    const runs: SchedulerRun[] = [{ agentRunId: 10, live: true }];
    expect(findOrphanedCards(cards, runs)).toEqual([]);
  });

  it('flags an in_progress card with NO assigned agents (moved but never picked up)', () => {
    const cards = [card({ id: 2, column: 'in_progress', assignedAgentRunIds: [] })];
    expect(findOrphanedCards(cards, [])).toEqual([2]);
  });

  it('keeps a card alive if ANY assigned agent is live', () => {
    const cards = [card({ id: 3, column: 'in_progress', assignedAgentRunIds: [10, 11] })];
    const runs: SchedulerRun[] = [
      { agentRunId: 10, live: false },
      { agentRunId: 11, live: true },
    ];
    expect(findOrphanedCards(cards, runs)).toEqual([]);
  });

  it('ignores cards in non-in_progress columns', () => {
    const cards = [
      card({ id: 1, column: 'todo' }),
      card({ id: 2, column: 'done' }),
      card({ id: 3, column: 'review', assignedAgentRunIds: [10] }),
    ];
    expect(findOrphanedCards(cards, [])).toEqual([]);
  });
});

describe('selectDispatchTargets', () => {
  const base = { runningCount: 0, concurrencyLimit: 10 };

  it('picks unblocked, unassigned todo/backlog cards in priority order', () => {
    const prioritizedCards = [
      card({ id: 1, column: 'todo' }),
      card({ id: 2, column: 'backlog' }),
      card({ id: 3, column: 'todo' }),
    ];
    expect(selectDispatchTargets({ ...base, prioritizedCards })).toEqual([1, 2, 3]);
  });

  it('skips blocked cards', () => {
    const prioritizedCards = [
      card({ id: 1, column: 'todo', blockedBy: [99] }),
      card({ id: 2, column: 'todo' }),
    ];
    expect(selectDispatchTargets({ ...base, prioritizedCards })).toEqual([2]);
  });

  it('skips already-assigned cards', () => {
    const prioritizedCards = [
      card({ id: 1, column: 'todo', assignedAgentRunIds: [5] }),
      card({ id: 2, column: 'todo' }),
    ];
    expect(selectDispatchTargets({ ...base, prioritizedCards })).toEqual([2]);
  });

  it('skips cards not in a dispatchable column', () => {
    const prioritizedCards = [
      card({ id: 1, column: 'in_progress' }),
      card({ id: 2, column: 'review' }),
      card({ id: 3, column: 'todo' }),
    ];
    expect(selectDispatchTargets({ ...base, prioritizedCards })).toEqual([3]);
  });

  it('caps dispatch at the free concurrency slots', () => {
    const prioritizedCards = [card({ id: 1 }), card({ id: 2 }), card({ id: 3 })];
    expect(
      selectDispatchTargets({ prioritizedCards, runningCount: 8, concurrencyLimit: 10 }),
    ).toEqual([1, 2]);
  });

  it('returns nothing when the fleet is already at the cap', () => {
    const prioritizedCards = [card({ id: 1 })];
    expect(
      selectDispatchTargets({ prioritizedCards, runningCount: 10, concurrencyLimit: 10 }),
    ).toEqual([]);
  });

  it('honors maxPerSweep as a softer per-tick ceiling', () => {
    const prioritizedCards = [card({ id: 1 }), card({ id: 2 }), card({ id: 3 })];
    expect(
      selectDispatchTargets({ ...base, prioritizedCards, maxPerSweep: 1 }),
    ).toEqual([1]);
  });

  // ── C3 — soft WIP limit on in_progress ─────────────────────────
  describe('wip limit', () => {
    const three = [card({ id: 1 }), card({ id: 2 }), card({ id: 3 })];

    it('caps the batch so in_progress never exceeds the limit', () => {
      expect(
        selectDispatchTargets({
          ...base, prioritizedCards: three,
          wip: { inProgressCount: 1, limit: 3 },
        }),
      ).toEqual([1, 2]);
    });

    it('returns nothing when in_progress is already AT the limit', () => {
      expect(
        selectDispatchTargets({
          ...base, prioritizedCards: three,
          wip: { inProgressCount: 3, limit: 3 },
        }),
      ).toEqual([]);
    });

    it('returns nothing when in_progress is already OVER the limit (humans may exceed)', () => {
      expect(
        selectDispatchTargets({
          ...base, prioritizedCards: three,
          wip: { inProgressCount: 5, limit: 3 },
        }),
      ).toEqual([]);
    });

    it('limit null = no WIP ceiling', () => {
      expect(
        selectDispatchTargets({
          ...base, prioritizedCards: three,
          wip: { inProgressCount: 99, limit: null },
        }),
      ).toEqual([1, 2, 3]);
    });

    it('composes with maxPerSweep and free slots (tightest wins)', () => {
      expect(
        selectDispatchTargets({
          prioritizedCards: three,
          runningCount: 8,
          concurrencyLimit: 10, // 2 free slots
          maxPerSweep: 2,
          wip: { inProgressCount: 2, limit: 3 }, // 1 of WIP room
        }),
      ).toEqual([1]);
    });
  });
});
