/**
 * Unit tests for RecoveringNode.
 *
 * Contract:
 *   1. Without a ProviderError lastEvent → Aborted + stopReason='error'.
 *   2. Non-retryable ProviderError → Aborted + stopReason='error'.
 *   3. Retryable ProviderError under cap → TurnSucceeded + counter bumped.
 *   4. Retryable ProviderError over cap → recovery_aborted emitted +
 *      Aborted + stopReason='recovery_capped'.
 *   5. Status maps to the correct counter:
 *      - 401 → provider-401-refresh
 *      - 400 → provider-400-retry
 *      - 5xx/429 → provider-transient-retry
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RecoveringNode } from '../recovering.js';
import { makeTestContext } from './test-helpers.js';

beforeEach(() => {
  // Zero out backoff so tests don't wait on real timers.
  vi.stubEnv('CODER_TRANSIENT_RETRY_INITIAL_MS', '0');
  vi.stubEnv('CODER_TRANSIENT_RETRY_MAX_MS', '0');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('RecoveringNode', () => {
  it('aborts defensively when lastEvent is null', async () => {
    const { ctx } = makeTestContext();
    const event = await new RecoveringNode().execute(ctx, null);
    expect(event.kind).toBe('Aborted');
    expect(ctx.stopReason).toBe('error');
    expect(ctx.error?.message).toMatch(/without ProviderError context/);
  });

  it('aborts on a non-ProviderError lastEvent', async () => {
    const { ctx } = makeTestContext();
    const event = await new RecoveringNode().execute(ctx, {
      kind: 'TurnSucceeded',
      hasToolCalls: false,
    });
    expect(event.kind).toBe('Aborted');
    expect(ctx.stopReason).toBe('error');
  });

  it('aborts immediately on a non-retryable ProviderError without bumping counter', async () => {
    const { ctx } = makeTestContext();
    const event = await new RecoveringNode().execute(ctx, {
      kind: 'ProviderError',
      retryable: false,
      status: 402,
    });
    expect(event.kind).toBe('Aborted');
    expect(ctx.stopReason).toBe('error');
    expect(ctx.recovery.size).toBe(0);
  });

  it('bumps the transient counter and yields TurnSucceeded under cap', async () => {
    const { ctx } = makeTestContext();
    const event = await new RecoveringNode().execute(ctx, {
      kind: 'ProviderError',
      retryable: true,
      status: 503,
    });
    expect(event.kind).toBe('TurnSucceeded');
    expect(ctx.recovery.get('provider-transient-retry')).toBe(1);
  });

  it('classifies status 401 into provider-401-refresh', async () => {
    const { ctx } = makeTestContext();
    await new RecoveringNode().execute(ctx, {
      kind: 'ProviderError',
      retryable: true,
      status: 401,
    });
    expect(ctx.recovery.get('provider-401-refresh')).toBe(1);
    expect(ctx.recovery.has('provider-transient-retry')).toBe(false);
  });

  it('classifies status 400 into provider-400-retry', async () => {
    const { ctx } = makeTestContext();
    await new RecoveringNode().execute(ctx, {
      kind: 'ProviderError',
      retryable: true,
      status: 400,
    });
    expect(ctx.recovery.get('provider-400-retry')).toBe(1);
  });

  it('aborts and emits recovery_aborted when the per-kind cap is exceeded', async () => {
    vi.stubEnv('CODER_RECOVERY_TRANSIENT_MAX', '1');
    const { ctx, recordedEvents } = makeTestContext();

    // First call: under cap (1/1) → TurnSucceeded.
    const first = await new RecoveringNode().execute(ctx, {
      kind: 'ProviderError',
      retryable: true,
      status: 503,
    });
    expect(first.kind).toBe('TurnSucceeded');

    // Second call: 2/1 → exceeded → Aborted.
    const second = await new RecoveringNode().execute(ctx, {
      kind: 'ProviderError',
      retryable: true,
      status: 503,
    });

    expect(second.kind).toBe('Aborted');
    expect(ctx.stopReason).toBe('recovery_capped');
    expect(ctx.transition).toBe('provider-transient-retry');

    const aborted = recordedEvents.find((r) => r.event === 'recovery_aborted');
    expect(aborted).toBeDefined();
    expect(aborted!.args[0]).toMatchObject({
      kind: 'provider-transient-retry',
      attempts: 2,
      cap: 1,
    });
  });

  it('preserves per-kind isolation — 401 cap does not affect transient', async () => {
    vi.stubEnv('CODER_RECOVERY_401_MAX', '0');
    const { ctx } = makeTestContext();

    // 401 over cap=0 → Aborted on the first attempt.
    const refresh = await new RecoveringNode().execute(ctx, {
      kind: 'ProviderError',
      retryable: true,
      status: 401,
    });
    expect(refresh.kind).toBe('Aborted');

    // Reset stopReason / error so the next call sees a fresh ctx aside from
    // the recovery counters.
    ctx.stopReason = null;
    ctx.error = null;
    ctx.transition = null;

    // 503 with default transient cap (30) → first attempt fine.
    const transient = await new RecoveringNode().execute(ctx, {
      kind: 'ProviderError',
      retryable: true,
      status: 503,
    });
    expect(transient.kind).toBe('TurnSucceeded');
  });
});
