/**
 * Unit tests for BootstrapNode.
 *
 * Contract:
 *   1. Emits exactly one `run_started` event with the runner identity.
 *   2. Always yields `TurnSucceeded` so the orchestrator moves to Executing.
 *   3. Guarantees `'bootstrap'` is in `activeTiers` even if a caller passed
 *      an empty set (defensive invariant).
 */
import { describe, it, expect } from 'vitest';
import { BootstrapNode } from '../bootstrap.js';
import { makeTestContext } from './test-helpers.js';

describe('BootstrapNode', () => {
  it('emits run_started with the configured identity and yields TurnSucceeded', async () => {
    const { ctx, recordedEvents } = makeTestContext({
      providerName: 'anthropic',
      providerModel: 'claude-opus-4-7',
      profile: 'bootstrap',
      planMode: false,
      maxTurns: 50,
    });

    const node = new BootstrapNode();
    const event = await node.execute(ctx, null);

    expect(event).toEqual({ kind: 'TurnSucceeded', hasToolCalls: false });
    expect(recordedEvents).toHaveLength(1);
    expect(recordedEvents[0].event).toBe('run_started');
    expect(recordedEvents[0].args[0]).toMatchObject({
      runId: 'test-run',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      profile: 'bootstrap',
      planMode: false,
      maxTurns: 50,
    });
  });

  it('forwards planMode=true', async () => {
    const { ctx, recordedEvents } = makeTestContext({ planMode: true });
    await new BootstrapNode().execute(ctx, null);
    expect(recordedEvents[0].args[0]).toMatchObject({ planMode: true });
  });

  it('forwards profile=null when no profile was supplied', async () => {
    const { ctx, recordedEvents } = makeTestContext({ profile: null });
    await new BootstrapNode().execute(ctx, null);
    expect(recordedEvents[0].args[0]).toMatchObject({ profile: null });
  });

  it('reports an unlimited session when opts.maxTurns is unset', async () => {
    const { ctx, recordedEvents } = makeTestContext();
    delete ctx.opts.maxTurns;
    await new BootstrapNode().execute(ctx, null);
    expect(recordedEvents[0].args[0]).toMatchObject({ maxTurns: null });
  });

  it('defensively re-adds "bootstrap" to activeTiers if missing', async () => {
    const { ctx } = makeTestContext({ tiers: new Set([]) });
    expect(ctx.activeTiers?.has('bootstrap') ?? null).toBe(false);
    await new BootstrapNode().execute(ctx, null);
    expect(ctx.activeTiers?.has('bootstrap') ?? null).toBe(true);
  });
});
