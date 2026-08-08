/**
 * PR-E unit tests for `BudgetTracker` and `loadDefaultTokenCap`.
 * Integration with execute_tasks lives in `execute-tasks-budget.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BudgetTracker,
  loadDefaultTokenCap,
  type BudgetAskCallback,
} from '../execute-tasks/task-run-budget.js';

describe('BudgetTracker — unit', () => {
  it('null cap → always continue, no ask', async () => {
    const b = new BudgetTracker({ tokensCap: null });
    const ask = vi.fn();
    expect(await b.checkBeforeTask({ ask })).toBe('continue');
    expect(ask).not.toHaveBeenCalled();
  });

  it('projected spend under cap → continue, no ask', async () => {
    const b = new BudgetTracker({ tokensCap: 10_000, estimatePerTask: 100 });
    b.addSpend(5_000, 0);
    const ask = vi.fn();
    expect(await b.checkBeforeTask({ ask })).toBe('continue');
    expect(ask).not.toHaveBeenCalled();
  });

  it('projected over cap with no ask callback → abort (conservative)', async () => {
    const b = new BudgetTracker({ tokensCap: 100, estimatePerTask: 500 });
    expect(await b.checkBeforeTask()).toBe('abort');
    expect(b.snapshot().cancelled).toBe(true);
  });

  it('ask answers continue+50% → cap raised, returns continue', async () => {
    const b = new BudgetTracker({ tokensCap: 1_000, estimatePerTask: 500 });
    b.addSpend(900, 0);
    const ask: BudgetAskCallback = async () => 'continue+50%';
    expect(await b.checkBeforeTask({ ask })).toBe('continue');
    expect(b.snapshot().cap).toBe(1_500);
  });

  it('ask answers stop_after_current → returns skip, future calls keep skipping', async () => {
    const b = new BudgetTracker({ tokensCap: 100, estimatePerTask: 500 });
    const ask: BudgetAskCallback = async () => 'stop_after_current';
    expect(await b.checkBeforeTask({ ask })).toBe('skip');
    expect(b.snapshot().stopAfterCurrent).toBe(true);
    // Subsequent gate calls don't re-ask.
    const askSecond = vi.fn();
    expect(await b.checkBeforeTask({ ask: askSecond })).toBe('skip');
    expect(askSecond).not.toHaveBeenCalled();
  });

  it('ask answers cancel_pending → returns abort, future calls keep aborting', async () => {
    const b = new BudgetTracker({ tokensCap: 100, estimatePerTask: 500 });
    const ask: BudgetAskCallback = async () => 'cancel_pending';
    expect(await b.checkBeforeTask({ ask })).toBe('abort');
    expect(b.snapshot().cancelled).toBe(true);
    expect(await b.checkBeforeTask({ ask: vi.fn() })).toBe('abort');
  });

  it('addSpend accumulates input + output tokens', () => {
    const b = new BudgetTracker({ tokensCap: 100 });
    b.addSpend(10, 20);
    b.addSpend(30, 5);
    expect(b.snapshot().spent).toBe(65);
  });

  it('addSpend tolerates missing fields (NaN/undefined)', () => {
    const b = new BudgetTracker({ tokensCap: 100 });
    b.addSpend(0, 0);
    b.addSpend(undefined as unknown as number, undefined as unknown as number);
    expect(b.snapshot().spent).toBe(0);
  });
});

describe('loadDefaultTokenCap', () => {
  it('is always unlimited; budgets belong to explicit run policy', () => {
    expect(loadDefaultTokenCap()).toBeNull();
    process.env.CODER_TASKS_DEFAULT_TOKEN_CAP = '500.7';
    expect(loadDefaultTokenCap()).toBeNull();
    delete process.env.CODER_TASKS_DEFAULT_TOKEN_CAP;
  });
});
