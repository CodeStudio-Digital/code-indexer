import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { maybeGoalCompletionRefusal } from '../executing-plan-gate.js';
import { makeTestContext } from './test-helpers.js';

function contextWithVerifier(
  status: 'in_progress' | 'complete',
  verifyGoalCompletion: () => Promise<{
    goalMet: boolean;
    gaps: Array<{ description: string; severity: string }>;
  } | null>,
) {
  const goal = {
    text: 'Fix the requested behavior',
    status,
    budgetTokens: null,
    completionNote: null,
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
  } as const;
  const { ctx } = makeTestContext({
    toolContext: {
      cwd: process.cwd(),
      projectName: 'goal-verifier-test',
      getGoalState: () => goal,
    } as ToolContext,
  });
  ctx.bridge = { verifyGoalCompletion } as never;
  return ctx;
}

describe('maybeGoalCompletionRefusal', () => {
  it('does not invoke the verifier for a trivial turn without an active goal', async () => {
    const verifier = vi.fn(async () => ({ goalMet: true, gaps: [] }));
    const { ctx } = makeTestContext({
      toolContext: {
        cwd: process.cwd(),
        projectName: 'goal-verifier-test',
        getGoalState: () => null,
      } as ToolContext,
    });
    ctx.bridge = { verifyGoalCompletion: verifier } as never;

    expect(await maybeGoalCompletionRefusal(ctx)).toBeNull();
    expect(verifier).not.toHaveBeenCalled();
  });

  it('refuses update_goal before persistence when the independent verifier finds gaps', async () => {
    const verifier = vi.fn(async () => ({
      goalMet: false,
      gaps: [{ description: 'Regression case is still failing', severity: 'high' }],
    }));
    const ctx = contextWithVerifier('in_progress', verifier);

    const refusal = await maybeGoalCompletionRefusal(ctx);

    expect(refusal).toContain('Refused `update_goal`');
    expect(refusal).toContain('Regression case is still failing');
    expect(refusal).toContain('remains in_progress');
    expect(ctx.goalVerifyAttempts).toBe(1);
  });

  it('allows persistence only after a positive independent verdict', async () => {
    const verifier = vi.fn(async () => ({ goalMet: true, gaps: [] }));
    const ctx = contextWithVerifier('in_progress', verifier);

    expect(await maybeGoalCompletionRefusal(ctx)).toBeNull();
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(ctx.goalVerifyAttempts).toBe(0);
  });

  it('stops spending verifier calls after repeated negative verdicts and stays fail-closed', async () => {
    const verifier = vi.fn(async () => ({ goalMet: false, gaps: [] }));
    const ctx = contextWithVerifier('in_progress', verifier);

    expect(await maybeGoalCompletionRefusal(ctx)).toContain('Refused `update_goal`');
    expect(await maybeGoalCompletionRefusal(ctx)).toContain('Refused `update_goal`');
    expect(await maybeGoalCompletionRefusal(ctx)).toContain('already found unmet requirements');
    expect(verifier).toHaveBeenCalledTimes(2);
  });

  it('grants a fresh bounded verifier budget after write or validation evidence advances', async () => {
    const verifier = vi.fn(async () => ({ goalMet: false, gaps: [] }));
    const ctx = contextWithVerifier('in_progress', verifier);
    const evidence = (lastWriteSeq: number, lastValidationSeq: number | null) => ({
      status: lastValidationSeq != null ? 'fresh' as const : 'missing' as const,
      changedFiles: ['src/goal.ts'],
      lastWriteSeq,
      lastValidationSeq,
      lastSuccessfulValidationSeq: lastValidationSeq,
      validationSignals: lastValidationSeq != null ? ['vitest run'] : [],
      persisted: null,
      source: 'ledger' as const,
    });

    expect(await maybeGoalCompletionRefusal(ctx, evidence(1, null))).toContain('Refused');
    expect(await maybeGoalCompletionRefusal(ctx, evidence(1, null))).toContain('Refused');
    expect(await maybeGoalCompletionRefusal(ctx, evidence(1, null)))
      .toContain('already found unmet requirements');
    expect(verifier).toHaveBeenCalledTimes(2);

    expect(await maybeGoalCompletionRefusal(ctx, evidence(1, 2))).toContain('Refused');
    expect(verifier).toHaveBeenCalledTimes(3);
    expect(ctx.goalVerifyAttempts).toBe(1);
  });

  it('does not re-verify a historical completed goal during side conversation', async () => {
    const verifier = vi.fn(async () => ({ goalMet: false, gaps: [] }));
    const ctx = contextWithVerifier('complete', verifier);

    expect(await maybeGoalCompletionRefusal(ctx)).toBeNull();
    expect(verifier).not.toHaveBeenCalled();
  });
});
