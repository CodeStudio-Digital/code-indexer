/**
 * Unit tests for ReviewingNode.
 */
import { describe, it, expect } from 'vitest';
import { ReviewingNode } from '../reviewing.js';
import { makeTestContext } from './test-helpers.js';

describe('ReviewingNode', () => {
  it('yields TurnSucceeded for a normal post-compaction state', async () => {
    const { ctx } = makeTestContext();
    ctx.messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    const event = await new ReviewingNode().execute(ctx, null);
    expect(event.kind).toBe('TurnSucceeded');
  });

  it('re-asserts the bootstrap tier invariant', async () => {
    const { ctx } = makeTestContext({ tiers: new Set([]) });
    ctx.messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    await new ReviewingNode().execute(ctx, null);
    expect(ctx.activeTiers?.has('bootstrap') ?? null).toBe(true);
  });

  it('emits CleanFinish when the history is empty', async () => {
    const { ctx } = makeTestContext();
    ctx.messages = [];
    const event = await new ReviewingNode().execute(ctx, null);
    expect(event.kind).toBe('CleanFinish');
    expect(ctx.stopReason).toBe('completed');
  });

  it('treats MaxTurnsReached as terminal instead of re-entering Executing', async () => {
    const { ctx } = makeTestContext();
    ctx.messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];

    const event = await new ReviewingNode().execute(ctx, {
      kind: 'MaxTurnsReached',
      autoContinueLeft: 0,
    });

    expect(event.kind).toBe('CleanFinish');
    expect(ctx.stopReason).toBe('max_turns');
  });
});
