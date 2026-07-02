/**
 * Tests for the ApprovalBatcher (C4) — debounce/aggregation shell + pure
 * summary formatting. Timing is driven by an injected scheduler (fake
 * clock): tests trigger the flush by hand, no real timers involved.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ApprovalBatcher,
  formatPendingPlansSummary,
  planTitle,
} from '../approval-batcher.js';

/** Manual scheduler: captures the callback + delay, fires on demand. */
function fakeSchedule() {
  const pending: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const schedule = (fn: () => void, ms: number): (() => void) => {
    const entry = { fn, ms, cancelled: false };
    pending.push(entry);
    return () => { entry.cancelled = true; };
  };
  const fire = (): void => {
    for (const entry of pending.splice(0)) {
      if (!entry.cancelled) entry.fn();
    }
  };
  return { schedule, fire, pending };
}

describe('planTitle', () => {
  it('takes the first non-empty line', () => {
    expect(planTitle('\n\n  1. Do the thing\n2. more')).toBe('1. Do the thing');
  });
  it('truncates long titles with an ellipsis', () => {
    const long = 'x'.repeat(120);
    const title = planTitle(long);
    expect(title.length).toBe(80);
    expect(title.endsWith('…')).toBe(true);
  });
  it('degrades for an empty plan', () => {
    expect(planTitle('   \n  ')).toBe('(empty plan)');
  });
});

describe('formatPendingPlansSummary', () => {
  it('aggregates N plans into one [SYSTEM] message with per-plan lines', () => {
    const msg = formatPendingPlansSummary([
      { agentRunId: 12, role: 'backend', planText: 'Add auth API\ndetails…' },
      { agentRunId: 13, role: 'frontend', planText: 'Build login form' },
    ]);
    expect(msg).toContain('2 subordinate plans are awaiting your approval');
    expect(msg).toContain('@backend (agent_run_id=12): "Add auth API"');
    expect(msg).toContain('@frontend (agent_run_id=13): "Build login form"');
    expect(msg).toContain('approve_subordinate_plans');
  });
});

describe('ApprovalBatcher', () => {
  it('arms ONE window per burst — signals coalesce into a single flush', () => {
    const clock = fakeSchedule();
    const flush = vi.fn();
    const batcher = new ApprovalBatcher({ flush, schedule: clock.schedule, windowMs: 5_000 });

    batcher.signal();
    batcher.signal();
    batcher.signal();
    expect(batcher.armed).toBe(true);
    expect(clock.pending.filter((p) => !p.cancelled)).toHaveLength(1);
    expect(clock.pending[0].ms).toBe(5_000);
    expect(flush).not.toHaveBeenCalled();

    clock.fire();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(batcher.armed).toBe(false);
  });

  it('a new signal AFTER a flush arms a fresh window', () => {
    const clock = fakeSchedule();
    const flush = vi.fn();
    const batcher = new ApprovalBatcher({ flush, schedule: clock.schedule });

    batcher.signal();
    clock.fire();
    batcher.signal();
    clock.fire();
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('cancel() drops the armed window without flushing', () => {
    const clock = fakeSchedule();
    const flush = vi.fn();
    const batcher = new ApprovalBatcher({ flush, schedule: clock.schedule });

    batcher.signal();
    batcher.cancel();
    expect(batcher.armed).toBe(false);
    clock.fire();
    expect(flush).not.toHaveBeenCalled();
  });

  it('a throwing flush does not wedge the batcher (next signal still works)', () => {
    const clock = fakeSchedule();
    const flush = vi.fn(() => { throw new Error('boom'); });
    const batcher = new ApprovalBatcher({ flush, schedule: clock.schedule });

    batcher.signal();
    expect(() => clock.fire()).not.toThrow();
    expect(batcher.armed).toBe(false);
    batcher.signal();
    expect(batcher.armed).toBe(true);
  });
});
