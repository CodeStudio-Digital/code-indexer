import { expect, it } from 'vitest';
import { nativeCoderExecutionBudget } from '../workers/native-coder-budget.js';
const now = 1000, executorExpiresAt = new Date(now + 600_000).toISOString();
const policy = { maxTurns: null, maxToolCalls: null, maxWallMs: null, cancellation: 'cooperative_then_kill' as const };
it('seals a finite execution window independently from the renewable executor lease', () => {
  expect(nativeCoderExecutionBudget({ maxTurns: 0, policy, now, executorExpiresAt })).toEqual({
    deadlineAtUnixMs: now + 86_401_000, executionDeadlineAtUnixMs: now + 86_400_000, maxTurns: undefined, maxToolCalls: undefined,
  });
});
it('narrows every execution limit from the sealed policy', () => {
  expect(nativeCoderExecutionBudget({ maxTurns: 50, policy: { ...policy, maxTurns: 3, maxToolCalls: 4, maxWallMs: 10_000 }, now, executorExpiresAt })).toEqual({
    deadlineAtUnixMs: now + 11_000, executionDeadlineAtUnixMs: now + 10_000, maxTurns: 3, maxToolCalls: 4,
  });
});
it('keeps a smaller user turn limit and the requested execution window across renewals', () => {
  expect(nativeCoderExecutionBudget({ maxTurns: 2, policy: { ...policy, maxTurns: 5, maxWallMs: 900_000 }, now, executorExpiresAt })).toMatchObject({
    deadlineAtUnixMs: now + 901_000, executionDeadlineAtUnixMs: now + 900_000, maxTurns: 2,
  });
});
it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid policy budget: %s', value => {
  expect(() => nativeCoderExecutionBudget({ maxTurns: 2, policy: { ...policy, maxToolCalls: value }, now, executorExpiresAt })).toThrow('Invalid native execution budget');
});
it('rejects expired or invalid executor authority', () => {
  for (const expiry of ['invalid', new Date(now).toISOString(), new Date(now + 1000).toISOString()]) expect(() => nativeCoderExecutionBudget({ maxTurns: 2, now, executorExpiresAt: expiry })).toThrow('live executor lease');
});
