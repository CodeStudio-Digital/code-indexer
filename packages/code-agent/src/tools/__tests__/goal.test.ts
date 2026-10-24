import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { goalTools } from '../goal.js';

type GoalSnapshot = NonNullable<ReturnType<NonNullable<ToolContext['getGoalState']>>>;

const createGoal = goalTools.find((tool) => tool.name === 'create_goal')!;
const updateGoal = goalTools.find((tool) => tool.name === 'update_goal')!;

function harness(initial: GoalSnapshot | null = null) {
  let goal = initial;
  const upsertGoalState = vi.fn(async (next: GoalSnapshot) => {
    goal = next;
  });
  const noteGoalUnchanged = vi.fn();
  const ctx = {
    cwd: process.cwd(),
    projectName: 'goal-tool-test',
    currentToolUseId: 'goal-tool-use',
    getGoalState: () => goal,
    upsertGoalState,
    noteGoalUnchanged,
  } as unknown as ToolContext;
  return { ctx, getGoal: () => goal, upsertGoalState, noteGoalUnchanged };
}

describe('advisory goal tools', () => {
  it('gives a replacement objective a new generation even within the same clock tick', async () => {
    vi.useFakeTimers();
    const now = '2026-10-07T00:00:00.000Z';
    vi.setSystemTime(now);
    try {
      const { ctx, getGoal } = harness({ text: 'Old', status: 'complete', createdAt: now, updatedAt: now, budgetTokens: null, completionNote: 'Done' });
      expect((await createGoal.handler({ goal: 'New' }, ctx)).isError).not.toBe(true);
      expect(Date.parse(getGoal()!.createdAt)).toBe(Date.parse(now) + 1);
    } finally { vi.useRealTimers(); }
  });
  it('treats redundant create_goal as idempotent success without replacing state', async () => {
    const existing: GoalSnapshot = {
      text: 'Original objective',
      status: 'in_progress',
      budgetTokens: null,
      completionNote: null,
      createdAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
    };
    const { ctx, getGoal, upsertGoalState, noteGoalUnchanged } = harness(existing);

    const result = await createGoal.handler({ goal: 'Accidental replacement' }, ctx);

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('left unchanged');
    expect(getGoal()?.text).toBe('Original objective');
    expect(upsertGoalState).not.toHaveBeenCalled();
    expect(noteGoalUnchanged).toHaveBeenCalledWith({
      toolUseId: 'goal-tool-use',
      toolName: 'create_goal',
    });
  });

  it('treats repeated completion as idempotent success', async () => {
    const complete: GoalSnapshot = {
      text: 'Finished objective',
      status: 'complete',
      budgetTokens: null,
      completionNote: 'Done',
      createdAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:10:00.000Z',
    };
    const { ctx, getGoal, upsertGoalState, noteGoalUnchanged } = harness(complete);

    const result = await updateGoal.handler({ status: 'complete' }, ctx);

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('already complete');
    expect(getGoal()?.status).toBe('complete');
    expect(upsertGoalState).not.toHaveBeenCalled();
    expect(noteGoalUnchanged).toHaveBeenCalledWith({
      toolUseId: 'goal-tool-use',
      toolName: 'update_goal',
    });
  });

  it('keeps missing state as a persistence-integrity error', async () => {
    const { ctx } = harness();

    const result = await updateGoal.handler({ status: 'complete' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('No goal set');
  });
});
