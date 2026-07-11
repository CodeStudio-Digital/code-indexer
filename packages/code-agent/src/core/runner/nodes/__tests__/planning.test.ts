/**
 * Unit tests for PlanningNode.
 *
 * Contract:
 *   - Clears legacy `ctx.dupCalls`; hybrid invocation state is batch-local.
 *   - Pushes a one-shot reflection `<system-reminder>` naming the guard.
 *   - Records the trigger guard in `ctx.transition` for RunResult attribution.
 *   - Yields TurnSucceeded so the orchestrator returns to Executing.
 */
import { describe, it, expect } from 'vitest';
import { PlanningNode } from '../planning.js';
import { makeTestContext } from './test-helpers.js';

function lastMessageText(ctx: { messages: Array<{ content: unknown }> }): string {
  const last = ctx.messages.at(-1);
  const blocks = (last?.content ?? []) as Array<{ type: string; text?: string }>;
  return blocks.map((b) => b.text ?? '').join('');
}

describe('PlanningNode', () => {
  it('resets the dedup table on entry', async () => {
    const { ctx } = makeTestContext();
    ctx.dupCalls.set('foo|{}', { count: 5, firstTurn: 1, lastUseId: 'u1' });
    expect(ctx.dupCalls.size).toBe(1);

    await new PlanningNode().execute(ctx, null);
    expect(ctx.dupCalls.size).toBe(0);
  });

  it('clears the failure-streak table so a refuse-thresholded tool can retry', async () => {
    const { ctx } = makeTestContext();
    // A tool that crossed the refuse threshold (e.g. app_provision_db hit from
    // inside code_exec) would otherwise stay pre-refused for the whole run.
    ctx.failureStreaks.streaks.set('app_provision_db', {
      consecutive: 5,
      firstFailureTurn: 1,
      lastFailureTurn: 5,
      lastError: 'boom',
    });
    expect(ctx.failureStreaks.streaks.size).toBe(1);

    await new PlanningNode().execute(ctx, {
      kind: 'ToolLoopDetected',
      guard: 'failure-streak',
      toolName: 'code_exec',
      count: 5,
    });
    expect(ctx.failureStreaks.streaks.size).toBe(0);
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

  it('records failure-streak guard correctly', async () => {
    const { ctx } = makeTestContext();
    await new PlanningNode().execute(ctx, {
      kind: 'ToolLoopDetected',
      guard: 'failure-streak',
    });
    expect(ctx.transition).toBe('failure-streak');
  });

  it('leaves ctx.transition unchanged when lastEvent is not ToolLoopDetected', async () => {
    const { ctx } = makeTestContext();
    ctx.transition = null;
    await new PlanningNode().execute(ctx, { kind: 'TurnSucceeded', hasToolCalls: false });
    expect(ctx.transition).toBe(null);
  });

  it('pushes a reflection reminder naming the guard, tool and count', async () => {
    const { ctx } = makeTestContext();
    await new PlanningNode().execute(ctx, {
      kind: 'ToolLoopDetected',
      guard: 'tuple-hash',
      toolName: 'mcp__grep_code',
      count: 3,
    });
    const text = lastMessageText(ctx);
    expect(ctx.messages.at(-1)?.role).toBe('user');
    expect(text).toContain('[loop-guard: duplicate-call]');
    expect(text).toContain('`mcp__grep_code`');
    expect(text).toContain('3 times');
    expect(text).toContain('DIFFERENT tool');
  });

  it('falls back to generic wording when the event carries no toolName', async () => {
    const { ctx } = makeTestContext();
    await new PlanningNode().execute(ctx, {
      kind: 'ToolLoopDetected',
      guard: 'failure-streak',
    });
    const text = lastMessageText(ctx);
    expect(text).toContain('[loop-guard: failure-streak]');
    expect(text).toContain('a tool failed repeatedly');
  });

  it('pushes no reminder when lastEvent is not ToolLoopDetected', async () => {
    const { ctx } = makeTestContext();
    await new PlanningNode().execute(ctx, null);
    await new PlanningNode().execute(ctx, { kind: 'TurnSucceeded', hasToolCalls: false });
    expect(ctx.messages).toHaveLength(0);
  });

  it('does not retain refusing signatures across a tuple-hash planning turn', async () => {
    const { ctx } = makeTestContext();
    ctx.turn = 4;
    ctx.dupCalls.set('grep|{"q":"x"}', { count: 3, firstTurn: 2, lastUseId: 'u3' });
    ctx.dupCalls.set('read|{"f":"a"}', { count: 1, firstTurn: 4, lastUseId: 'u4' });

    await new PlanningNode().execute(ctx, {
      kind: 'ToolLoopDetected',
      guard: 'tuple-hash',
      toolName: 'grep',
      count: 3,
    });

    expect(ctx.dupCalls.size).toBe(0);
  });

  it('does a FULL reset (no retention) for non-tuple-hash guards', async () => {
    const { ctx } = makeTestContext();
    ctx.dupCalls.set('grep|{"q":"x"}', { count: 3, firstTurn: 2, lastUseId: 'u3' });

    await new PlanningNode().execute(ctx, {
      kind: 'ToolLoopDetected',
      guard: 'dominance',
      toolName: 'grep',
      count: 12,
    });

    expect(ctx.dupCalls.size).toBe(0);
  });
});
