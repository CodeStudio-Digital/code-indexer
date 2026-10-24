import { expect, it } from 'vitest';
import { NativeGoalProjection, parseNativeGoalMutation, type NativeGoalState } from '../native-goal-projection.js';

const goal: NativeGoalState = { text: 'Preserve settings', status: 'in_progress', budgetTokens: 1000,
  completionNote: null, createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' };
const mutation = (next = goal, expected: NativeGoalState | null = null, toolName = 'create_goal', toolUseId = 'one') =>
  ({ version: 1, toolUseId, toolName, expected, next });

it('rebuilds the same goal and revision, with no revision inflation for no-ops', () => {
  const first = new NativeGoalProjection('session'), recovered = new NativeGoalProjection('session');
  const completed = { ...goal, status: 'complete' as const, completionNote: 'Checked', updatedAt: '2026-10-07T00:01:00.000Z' };
  const changes = [mutation(), mutation(goal, goal, 'create_goal', 'two'),
    mutation(completed, goal, 'update_goal', 'three'), mutation(completed, completed, 'update_goal', 'four')];
  for (const p of [first, recovered]) for (const m of changes) p.apply(m, m.toolUseId, m.toolName, false);
  expect(recovered.value).toEqual(first.value);
  expect(first.value).toMatchObject({ text: goal.text, status: 'complete', completion_note: 'Checked', revision: 2, mutation_seq: 2 });
});

it('rejects failed, unattributed, discontinuous and missing committed changes', () => {
  const p = new NativeGoalProjection('session');
  expect(p.value).toBeUndefined();
  p.apply(undefined, 'one', 'create_goal', true);
  expect(p.value).toBeUndefined();
  expect(() => p.apply(mutation(), 'other', 'create_goal', false)).toThrow('attribution');
  expect(() => p.apply(mutation(), 'one', 'read_file', false)).toThrow('attribution');
  expect(() => p.apply(mutation(), 'one', 'create_goal', true)).toThrow('Failed');
  expect(() => p.apply(undefined, 'one', 'create_goal', false)).toThrow('confirmed mutation');
  p.apply(mutation(), 'one', 'create_goal', false);
  expect(() => p.apply(mutation(), 'one', 'create_goal', false)).toThrow('discontinuous');
});

it('rejects oversized state, nonfinite budgets and goal replacement disguised as completion', () => {
  for (const next of [{ ...goal, text: 'x'.repeat(8193) }, { ...goal, budgetTokens: Infinity }, { ...goal, createdAt: 'bad' }]) {
    expect(() => parseNativeGoalMutation(mutation(next), 'one', 'create_goal')).toThrow('state');
  }
  expect(() => parseNativeGoalMutation(mutation({ ...goal, text: 'Changed', status: 'complete' }, goal, 'update_goal'), 'one', 'update_goal')).toThrow('transition');
  expect(() => parseNativeGoalMutation(mutation({ ...goal, status: 'superseded' }, goal, 'update_goal'), 'one', 'update_goal')).toThrow('transition');
});
