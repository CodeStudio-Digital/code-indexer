import { describe, expect, it } from 'vitest';
import {
  assignWaveIndexes,
  countWorkflowOutcomes,
  planWaves,
  validateWorkflowSteps,
  workflowStatusFromSteps,
  type WorkflowRecord,
  type WorkflowStepState,
} from '../workflow-types.js';

function step(id: string, dependsOn: string[] = [], status: WorkflowStepState['status'] = 'pending'): WorkflowStepState {
  return {
    id,
    title: id,
    prompt: `do ${id}`,
    profileId: 'explore',
    dependsOn,
    wave: 0,
    status,
  };
}

function record(steps: WorkflowStepState[]): WorkflowRecord {
  return {
    id: 'wf_test',
    name: 'test',
    status: 'running',
    steps,
    totalUsage: { input_tokens: 0, output_tokens: 0 },
    createdAt: 0,
    updatedAt: 0,
    runCount: 1,
  };
}

describe('validateWorkflowSteps', () => {
  it('accepts a well-formed DAG', () => {
    expect(validateWorkflowSteps([
      { id: 'a', prompt: 'x' },
      { id: 'b', prompt: 'y', depends_on: ['a'] },
    ])).toEqual([]);
  });

  it('rejects empty input, duplicate ids, unknown deps and self-deps', () => {
    expect(validateWorkflowSteps([])).toHaveLength(1);
    expect(validateWorkflowSteps([
      { id: 'a', prompt: 'x' },
      { id: 'a', prompt: 'y' },
    ]).some((i) => i.message.includes('duplicate'))).toBe(true);
    expect(validateWorkflowSteps([
      { id: 'a', prompt: 'x', depends_on: ['ghost'] },
    ]).some((i) => i.message.includes('unknown step'))).toBe(true);
    expect(validateWorkflowSteps([
      { id: 'a', prompt: 'x', depends_on: ['a'] },
    ]).some((i) => i.message.includes('depend on itself'))).toBe(true);
  });

  it('rejects invalid ids, empty prompts and >12 steps', () => {
    expect(validateWorkflowSteps([{ id: 'não válido!', prompt: 'x' }])
      .some((i) => i.message.includes('invalid step id'))).toBe(true);
    expect(validateWorkflowSteps([{ id: 'a', prompt: '   ' }])
      .some((i) => i.message.includes('non-empty prompt'))).toBe(true);
    const many = Array.from({ length: 13 }, (_, i) => ({ id: `s${i}`, prompt: 'x' }));
    expect(validateWorkflowSteps(many).some((i) => i.message.includes('at most 12'))).toBe(true);
  });

  it('detects dependency cycles', () => {
    const issues = validateWorkflowSteps([
      { id: 'a', prompt: 'x', depends_on: ['b'] },
      { id: 'b', prompt: 'y', depends_on: ['a'] },
    ]);
    expect(issues.some((i) => i.message.includes('cycle'))).toBe(true);
  });
});

describe('planWaves', () => {
  it('groups independent steps into one wave and chains dependents', () => {
    const waves = planWaves([
      step('a'), step('b'), step('c', ['a', 'b']), step('d', ['c']),
    ]);
    expect(waves).toEqual([['a', 'b'], ['c'], ['d']]);
  });

  it('treats terminal steps as satisfied on resume', () => {
    const waves = planWaves([
      step('a', [], 'completed'),
      step('b', ['a']),
      step('c', ['b'], 'failed'),
      step('d', ['c']),
    ]);
    // a and c are terminal; b and d are plannable (skip semantics for a
    // failed dep are the RUNNER's job, not the planner's).
    expect(waves).toEqual([['b', 'd']]);
  });

  it('throws on a cycle (safety net below validation)', () => {
    expect(() => planWaves([step('a', ['b']), step('b', ['a'])])).toThrow(/cycle/);
  });
});

describe('assignWaveIndexes + status rollup', () => {
  it('stamps 1-based wave indexes', () => {
    const steps = [step('a'), step('b', ['a']), step('c', ['a'])];
    const total = assignWaveIndexes(steps);
    expect(total).toBe(2);
    expect(steps.map((s) => [s.id, s.wave])).toEqual([['a', 1], ['b', 2], ['c', 2]]);
  });

  it('rolls up workflow status from step outcomes', () => {
    expect(workflowStatusFromSteps(record([step('a', [], 'completed')]))).toBe('completed');
    expect(workflowStatusFromSteps(record([step('a', [], 'completed'), step('b', [], 'partial')]))).toBe('partial');
    expect(workflowStatusFromSteps(record([step('a', [], 'failed'), step('b', [], 'skipped')]))).toBe('failed');
    const counts = countWorkflowOutcomes(record([
      step('a', [], 'completed'), step('b', [], 'failed'), step('c', [], 'skipped'), step('d'),
    ]));
    expect(counts).toEqual({ completed: 1, partial: 0, failed: 1, skipped: 1, pending: 1 });
  });
});
