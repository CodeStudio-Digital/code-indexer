/**
 * Unit tests for PlanningNode.
 *
 * Contract:
 *   - Always clears `ctx.dupCalls` so the agent gets a fresh slate.
 *   - Records the trigger guard in `ctx.transition` for RunResult attribution.
 *   - Yields TurnSucceeded so the orchestrator returns to Executing.
 */
import { describe, it, expect } from 'vitest';
import { PlanningNode } from '../planning.js';
import { makeTestContext } from './test-helpers.js';

describe('PlanningNode', () => {
  it('resets the dedup table on entry', async () => {
    const { ctx } = makeTestContext();
    ctx.dupCalls.set('foo|{}', { count: 5, firstTurn: 1, lastUseId: 'u1' });
    expect(ctx.dupCalls.size).toBe(1);

    await new PlanningNode().execute(ctx, null);
    expect(ctx.dupCalls.size).toBe(0);
  });

  it('yields TurnSucceeded so the run continues into Executing', async () => {
    const { ctx } = makeTestContext();
    const event = await new PlanningNode().execute(ctx, null);
    expect(event.kind).toBe('TurnSucceeded');
  });

  it('records the trigger guard in ctx.transition (tuple-hash → dup-call-cap)', async () => {
    const { ctx } = makeTestContext();
    await new PlanningNode().execute(ctx, {
      kind: 'ToolLoopDetected',
      guard: 'tuple-hash',
    });
    expect(ctx.transition).toBe('dup-call-cap');
  });

  it('records doom-loop guard correctly', async () => {
    const { ctx } = makeTestContext();
    await new PlanningNode().execute(ctx, {
      kind: 'ToolLoopDetected',
      guard: 'doom-loop',
    });
    expect(ctx.transition).toBe('doom-loop-strict');
  });

  it('records dominance guard correctly', async () => {
    const { ctx } = makeTestContext();
    await new PlanningNode().execute(ctx, {
      kind: 'ToolLoopDetected',
      guard: 'dominance',
    });
    expect(ctx.transition).toBe('doom-loop-fuzzy');
  });

  it('leaves ctx.transition unchanged when lastEvent is not ToolLoopDetected', async () => {
    const { ctx } = makeTestContext();
    ctx.transition = null;
    await new PlanningNode().execute(ctx, { kind: 'TurnSucceeded', hasToolCalls: false });
    expect(ctx.transition).toBe(null);
  });
});
