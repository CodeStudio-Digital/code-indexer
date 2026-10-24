import { afterEach, expect, it, vi } from 'vitest';
import { NativeAttemptChannelBudget } from '../native/NativeAttemptChannelBudget.js';
import type { ActiveAttemptAuthoritySnapshot } from '../driver/HostLifecycleTypes.js';

afterEach(() => vi.useRealTimers());

it.each(['control', 'management'])('drains before %s exhaustion without revoking execution authority', async channel => {
  vi.useFakeTimers();
  const authority = new AbortController();
  const budget = new NativeAttemptChannelBudget();
  const snapshot = { signal: authority.signal, remainingControlIdentities: 65_530,
    remainingManagementIdentities: 4_090 } as ActiveAttemptAuthoritySnapshot;
  const inspect = vi.fn(() => snapshot);
  budget.start(inspect);
  expect(budget.signal.aborted).toBe(false);
  const reduced = { ...snapshot, ...(channel === 'control'
    ? { remainingControlIdentities: 8_192 } : { remainingManagementIdentities: 1_000 }) };
  inspect.mockReturnValue(reduced);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(budget.signal.reason).toBe('ipc_identity_budget');
  expect(authority.signal.aborted).toBe(false);
  const calls = inspect.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(inspect).toHaveBeenCalledTimes(calls);
});

it('respects a smaller negotiated budget and stops polling when closed or fenced', async () => {
  vi.useFakeTimers();
  for (const fenced of [false, true]) {
    const authority = new AbortController();
    const budget = new NativeAttemptChannelBudget();
    const inspect = vi.fn(() => ({ signal: authority.signal, remainingControlIdentities: 128,
      remainingManagementIdentities: 64 } as ActiveAttemptAuthoritySnapshot));
    budget.start(inspect);
    expect(budget.signal.aborted).toBe(false);
    if (fenced) { authority.abort(); await vi.advanceTimersByTimeAsync(1_000); }
    else budget.close();
    const calls = inspect.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(inspect).toHaveBeenCalledTimes(calls);
    expect(budget.signal.aborted).toBe(false);
  }
});
