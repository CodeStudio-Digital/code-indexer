import { describe, expect, it, vi } from 'vitest';
import { scheduleGoalCompletionAdvisory } from '../executing-plan-gate.js';
import { makeTestContext } from './test-helpers.js';
import { asSessionId } from '@mcp/session-storage';

function contextWithVerifier(
  verifyGoalCompletion: () => Promise<{
    goalMet: boolean;
    gaps: Array<{ description: string; severity: string }>;
  } | null>,
) {
  const { ctx } = makeTestContext();
  const recordSessionInput = vi.fn();
  ctx.opts.sessionId = asSessionId(
    '00000000-0000-4000-8000-000000000042',
  );
  ctx.opts.sessionStore = { recordSessionInput } as never;
  ctx.bridge = { verifyGoalCompletion } as never;
  return { ctx, recordSessionInput };
}

describe('scheduleGoalCompletionAdvisory', () => {
  it('is a no-op when no independent reviewer is configured', () => {
    const { ctx } = makeTestContext();

    expect(scheduleGoalCompletionAdvisory(ctx)).toBe(false);
  });

  it('returns immediately and records negative gaps without refusing completion', async () => {
    const verifier = vi.fn(async () => ({
      goalMet: false,
      gaps: [{ description: 'Regression case is still failing', severity: 'high' }],
    }));
    const { ctx, recordSessionInput } = contextWithVerifier(verifier);

    expect(scheduleGoalCompletionAdvisory(ctx)).toBe(true);
    expect(verifier).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(recordSessionInput).toHaveBeenCalledTimes(1));
    expect(recordSessionInput).toHaveBeenCalledWith(expect.objectContaining({
      source_label: 'advisory:goal-verification',
      content: expect.stringContaining('Regression case is still failing'),
      meta: expect.objectContaining({ health: 'completed_with_warnings' }),
    }));
  });

  it('records a positive review as verified audit data', async () => {
    const { ctx, recordSessionInput } = contextWithVerifier(
      vi.fn(async () => ({ goalMet: true, gaps: [] })),
    );

    expect(scheduleGoalCompletionAdvisory(ctx)).toBe(true);

    await vi.waitFor(() => expect(recordSessionInput).toHaveBeenCalledTimes(1));
    expect(recordSessionInput).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ health: 'verified' }),
    }));
  });

  it.each([
    ['an inconclusive result', vi.fn(async () => null)],
    ['a reviewer failure', vi.fn(async () => { throw new Error('review offline'); })],
  ])('records %s as unverified and leaves completion untouched', async (_label, verifier) => {
    const { ctx, recordSessionInput } = contextWithVerifier(verifier);

    expect(scheduleGoalCompletionAdvisory(ctx)).toBe(true);

    await vi.waitFor(() => expect(recordSessionInput).toHaveBeenCalledTimes(1));
    expect(recordSessionInput).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ health: 'unverified' }),
    }));
  });
});
