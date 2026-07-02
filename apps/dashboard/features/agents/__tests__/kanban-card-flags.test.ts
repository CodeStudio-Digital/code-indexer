/**
 * Pure kanban card-flag helpers (C3): the AUTO chip predicate and the
 * recompute fingerprint the auto-debounce keys off. Defensive by contract —
 * malformed cards must degrade, never throw (the dashboard has no tsc gate).
 */
import { describe, expect, it } from 'vitest';
import { isAutoDispatched, kanbanRecomputeFingerprint } from '../kanban-card-flags.js';

const autoComment = {
  id: 1, card_id: 7, author_role: 'scheduler', agent_run_id: 42,
  content: '[AUTO] Scheduler dispatched @frontend (run=42) for this card while the master was idle.',
  created_at: '2026-07-01 10:00:00',
};

function card(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    column: 'in_progress',
    title: 'Build login',
    tag: null,
    blocked_by: [] as number[],
    agents: [],
    comments: [] as unknown[],
    ...over,
  } as never;
}

describe('isAutoDispatched', () => {
  it('true for an in_progress card with the scheduler [AUTO] dispatch comment', () => {
    expect(isAutoDispatched(card({ comments: [autoComment] }))).toBe(true);
  });

  it('false once the card left in_progress (chip is status, not history)', () => {
    expect(isAutoDispatched(card({ column: 'review', comments: [autoComment] }))).toBe(false);
  });

  it('false for human/master comments or other scheduler comments', () => {
    expect(isAutoDispatched(card({ comments: [{ ...autoComment, author_role: 'human' }] }))).toBe(false);
    expect(isAutoDispatched(card({
      comments: [{ ...autoComment, content: '[AUTO] Reset to `todo`: the assigned agent ended…' }],
    }))).toBe(false);
  });

  it('degrades to false on malformed input (never throws)', () => {
    expect(isAutoDispatched(null)).toBe(false);
    expect(isAutoDispatched(undefined)).toBe(false);
    expect(isAutoDispatched(card({ comments: undefined }))).toBe(false);
    expect(isAutoDispatched(card({ comments: [null, { content: 42 }] }))).toBe(false);
  });
});

describe('kanbanRecomputeFingerprint', () => {
  it('changes when a card moves column and when deps/assignments change', () => {
    const base = [card()];
    const moved = [card({ column: 'review' })];
    const blocked = [card({ blocked_by: [3] })];
    const assigned = [card({ agents: [{ role: 'qa', unassigned_at: null }] })];
    const fp = kanbanRecomputeFingerprint(base as never);
    expect(kanbanRecomputeFingerprint(moved as never)).not.toBe(fp);
    expect(kanbanRecomputeFingerprint(blocked as never)).not.toBe(fp);
    expect(kanbanRecomputeFingerprint(assigned as never)).not.toBe(fp);
  });

  it('is STABLE across comment/checklist churn (no recompute loop fuel)', () => {
    const a = [card({ comments: [] })];
    const b = [card({ comments: [autoComment] })];
    expect(kanbanRecomputeFingerprint(a as never)).toBe(kanbanRecomputeFingerprint(b as never));
  });

  it('is order-insensitive and null-safe', () => {
    const one = [card({ id: 1 }), card({ id: 2, column: 'todo' })];
    const two = [card({ id: 2, column: 'todo' }), card({ id: 1 })];
    expect(kanbanRecomputeFingerprint(one as never)).toBe(kanbanRecomputeFingerprint(two as never));
    expect(kanbanRecomputeFingerprint(null)).toBe('');
  });
});
