import { describe, expect, it } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import {
  evaluateGoalLifecycleAtFinish,
  goalLifecycleRefusalBeforeTool,
} from '../executing-goal-gate.js';
import { makeTestContext } from './test-helpers.js';

function contextWithGoal(status: 'in_progress' | 'complete' | null) {
  const { ctx } = makeTestContext({
    toolContext: {
      cwd: process.cwd(),
      projectName: 'goal-advisory-test',
      getGoalState: () => status == null
        ? null
        : {
            text: 'Track this objective',
            status,
            budgetTokens: null,
            completionNote: null,
            createdAt: '2026-07-23T00:00:00.000Z',
            updatedAt: '2026-07-23T00:00:00.000Z',
          },
    } as ToolContext,
  });
  return ctx;
}

describe('advisory goal lifecycle', () => {
  it.each([
    ['no goal', null],
    ['an active goal', 'in_progress'],
    ['a completed goal', 'complete'],
  ] as const)('allows a clean finish with %s', (_label, status) => {
    const ctx = contextWithGoal(status);
    ctx.opts.goalLifecycleIntent = 'required_fresh';

    expect(evaluateGoalLifecycleAtFinish(ctx)).toBeNull();
  });

  it('allows a clean finish when persisted goal state cannot be read', () => {
    const { ctx } = makeTestContext({
      toolContext: {
        cwd: process.cwd(),
        projectName: 'goal-advisory-test',
        getGoalState: () => {
          throw new Error('database unavailable');
        },
      } as ToolContext,
    });

    expect(evaluateGoalLifecycleAtFinish(ctx)).toBeNull();
  });

  it.each([
    ['edit_file', { path: 'src/a.ts', old_string: 'a', new_string: 'b' }],
    ['run_command', { command: 'pnpm test' }],
    ['update_goal', { status: 'complete' }],
    ['update_goal', { status: 'superseded', note: 'user pivoted' }],
  ])('does not let goal state authorize or refuse %s', (name, input) => {
    const ctx = contextWithGoal(null);
    ctx.bridge = {
      backgroundJobs: {
        hasActive: () => true,
        hasUncollectedTerminal: () => true,
        park: async () => 'work',
      },
    };

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      name,
      input,
      { effectiveToolNames: new Set(['create_goal', 'update_goal', name]) },
    )).toBeNull();
  });
});
