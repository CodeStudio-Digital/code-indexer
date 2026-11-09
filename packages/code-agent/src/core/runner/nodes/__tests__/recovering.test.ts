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
import { describe, it, expect, vi } from 'vitest';
import { RecoveringNode } from '../recovering.js';
import { backoffDelayMs, isContextOverflowError } from '../../provider-retry.js';
import { makeTestContext } from './test-helpers.js';
import { resetProviderRetrySequence } from '../../machine/context.js';

vi.mock('../../provider-retry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../provider-retry.js')>()),
  backoffDelayMs: vi.fn(() => 0),
}));

describe('RecoveringNode', () => {
  const disconnect = { kind: 'ProviderError' as const, retryable: true, status: 0, code: 'UND_ERR_SOCKET', message: 'Connection interrupted (UND_ERR_SOCKET)' };

  it('recovers a disconnect after earlier timeouts separated by committed responses', async () => {
    const { ctx } = makeTestContext();
    for (let i = 0; i < 4; i++) {
      expect((await new RecoveringNode().execute(ctx, { ...disconnect, code: 'TIMEOUT' })).kind).toBe('TurnSucceeded');
      resetProviderRetrySequence(ctx);
    }
    expect((await new RecoveringNode().execute(ctx, disconnect)).kind).toBe('TurnSucceeded');
    expect(ctx.recovery.get('provider-transport-retry')).toBe(5);
    expect(ctx.transportRetriesThisTurn).toBe(1);
    expect(ctx.recovery.has('provider-unknown-retry')).toBe(false);
  });

  it('still stops repeated disconnects for the same response at four retries', async () => {
    const { ctx } = makeTestContext();
    for (let i = 0; i < 4; i++) expect((await new RecoveringNode().execute(ctx, disconnect)).kind).toBe('TurnSucceeded');
    expect((await new RecoveringNode().execute(ctx, disconnect)).kind).toBe('Aborted');
    expect(ctx.transition).toBe('provider-transport-retry');
    expect(ctx.error?.message).toContain('4 retries without a completed response');
  });

  it('shares the run budget across HTTP failures and socket failures even after successful responses', async () => {
    const { ctx } = makeTestContext();
    ctx.opts.runtimePolicy = { provider: { transientRetriesPerTurn: 3, transientRetriesPerRun: 2 } } as never;
    expect((await new RecoveringNode().execute(ctx, { ...disconnect, status: 503 })).kind).toBe('TurnSucceeded');
    resetProviderRetrySequence(ctx);
    expect((await new RecoveringNode().execute(ctx, disconnect)).kind).toBe('TurnSucceeded');
    resetProviderRetrySequence(ctx);
    expect((await new RecoveringNode().execute(ctx, disconnect)).kind).toBe('Aborted');
    expect(ctx.error?.message).toContain('3/2');
  });

  it('honors cancellation before spending a retry', async () => {
    const { ctx } = makeTestContext({ toolContext: { signal: AbortSignal.abort() } as never });
    expect((await new RecoveringNode().execute(ctx, disconnect)).kind).toBe('Aborted');
    expect(ctx.stopReason).toBe('aborted');
    expect(ctx.recovery.size).toBe(0);
  });

  it('cancels a backoff immediately without starting another provider attempt', async () => {
    const controller = new AbortController();
    const { ctx } = makeTestContext({ toolContext: { signal: controller.signal } as never });
    vi.mocked(backoffDelayMs).mockReturnValueOnce(10_000);
    const pending = new RecoveringNode().execute(ctx, disconnect);
    controller.abort();
    expect((await pending).kind).toBe('Aborted');
    expect(ctx.aborted).toBe(true);
    expect(ctx.stopReason).toBe('aborted');
  });

  it('does not reset the consecutive budget by alternating HTTP and socket failures', async () => {
    const { ctx } = makeTestContext();
    ctx.opts.runtimePolicy = { provider: { transientRetriesPerTurn: 2, transientRetriesPerRun: 30 } } as never;
    expect((await new RecoveringNode().execute(ctx, disconnect)).kind).toBe('TurnSucceeded');
    expect((await new RecoveringNode().execute(ctx, { ...disconnect, status: 503 })).kind).toBe('TurnSucceeded');
    expect((await new RecoveringNode().execute(ctx, disconnect)).kind).toBe('Aborted');
  });

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
    expect(ctx.transientRetriesThisTurn).toBe(1);
  });

  it('enforces the per-turn transient retry cap before the run-lifetime cap', async () => {
    const { ctx, recordedEvents } = makeTestContext();
    ctx.opts.runtimePolicy = {
      provider: { transientRetriesPerTurn: 1, transientRetriesPerRun: 30 },
    } as never;
    const error = {
      kind: 'ProviderError' as const,
      retryable: true,
      status: 429,
      message: 'rate limited',
    };

    expect((await new RecoveringNode().execute(ctx, error)).kind).toBe('TurnSucceeded');
    const second = await new RecoveringNode().execute(ctx, error);

    expect(second.kind).toBe('Aborted');
    expect(ctx.stopReason).toBe('recovery_capped');
    expect(ctx.error?.message).toContain('Per-turn transient retry cap exceeded');
    expect(ctx.recovery.get('provider-transient-retry')).toBe(2);
    expect(recordedEvents.find((entry) => entry.event === 'recovery_aborted')?.args[0])
      .toMatchObject({ attempts: 2, cap: 1 });
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
    const { ctx, recordedEvents } = makeTestContext();
    ctx.opts.runtimePolicy = {
      provider: { transientRetriesPerTurn: 3, transientRetriesPerRun: 1 },
    } as never;

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

  it('surfaces the provider message in ctx.error on a non-retryable error', async () => {
    const { ctx } = makeTestContext();
    const event = await new RecoveringNode().execute(ctx, {
      kind: 'ProviderError',
      retryable: false,
      status: 404,
      message: 'The model `glm-5.2` does not exist',
    });
    expect(event.kind).toBe('Aborted');
    expect(ctx.stopReason).toBe('error');
    expect(ctx.error?.message).toBe('The model `glm-5.2` does not exist');
  });

  it('routes a status-less error (0) to provider-unknown-retry', async () => {
    const { ctx } = makeTestContext();
    const event = await new RecoveringNode().execute(ctx, {
      kind: 'ProviderError',
      retryable: true,
      status: 0,
      message: 'socket hang up',
    });
    expect(event.kind).toBe('TurnSucceeded');
    expect(ctx.recovery.get('provider-unknown-retry')).toBe(1);
    expect(ctx.recovery.has('provider-transient-retry')).toBe(false);
  });

  it('caps provider-unknown-retry low and includes the message when exceeded', async () => {
    const { ctx, recordedEvents } = makeTestContext();
    ctx.recovery.set('provider-unknown-retry', 4);
    const err = {
      kind: 'ProviderError' as const,
      retryable: true,
      status: 0,
      message: 'unexpected end of stream',
    };

    const second = await new RecoveringNode().execute(ctx, err);
    expect(second.kind).toBe('Aborted');
    expect(ctx.stopReason).toBe('recovery_capped');
    expect(ctx.error?.message).toContain('unexpected end of stream');

    const aborted = recordedEvents.find((r) => r.event === 'recovery_aborted');
    expect(aborted!.args[0]).toMatchObject({
      kind: 'provider-unknown-retry',
      contextHint: expect.stringContaining('unexpected end of stream'),
    });
  });

  it('routes a THINKING_TIMEOUT (status 0 + code) to its own provider-thinking-timeout bucket', async () => {
    const { ctx } = makeTestContext();
    const event = await new RecoveringNode().execute(ctx, {
      kind: 'ProviderError',
      retryable: true,
      status: 0,
      code: 'THINKING_TIMEOUT',
      message: 'provider thinking-only stream exceeded 240000ms',
    });
    expect(event.kind).toBe('TurnSucceeded');
    expect(ctx.recovery.get('provider-thinking-timeout')).toBe(1);
    // Must NOT share the connection-drop bucket (that would cap prematurely).
    expect(ctx.recovery.has('provider-unknown-retry')).toBe(false);
  });

  it('caps provider-thinking-timeout and attributes the transition on abort', async () => {
    const { ctx, recordedEvents } = makeTestContext();
    ctx.recovery.set('provider-thinking-timeout', 2);
    const err = {
      kind: 'ProviderError' as const,
      retryable: true,
      status: 0,
      code: 'THINKING_TIMEOUT',
      message: 'provider thinking-only stream exceeded 240000ms',
    };

    const second = await new RecoveringNode().execute(ctx, err);
    expect(second.kind).toBe('Aborted');
    expect(ctx.stopReason).toBe('recovery_capped');
    expect(ctx.transition).toBe('provider-thinking-timeout');
    expect(ctx.error?.message).toContain('kind=provider-thinking-timeout');

    const aborted = recordedEvents.find((r) => r.event === 'recovery_aborted');
    expect(aborted!.args[0]).toMatchObject({ kind: 'provider-thinking-timeout', attempts: 3, cap: 2 });
  });

  it('routes an overflow 400 (retryable:false) to Compacting instead of aborting', async () => {
    const { ctx } = makeTestContext();
    const event = await new RecoveringNode().execute(ctx, {
      kind: 'ProviderError',
      retryable: false,
      status: 400,
      message: 'prompt is too long: 210034 tokens > 200000 maximum',
    });
    expect(event.kind).toBe('TokenThresholdHit');
    expect(ctx.recovery.get('context-overflow')).toBe(1);
    expect(ctx.stopReason).toBeNull();
  });

  it('routes a status-less overflow to Compacting, not provider-unknown-retry', async () => {
    const { ctx } = makeTestContext();
    const event = await new RecoveringNode().execute(ctx, {
      kind: 'ProviderError',
      retryable: true,
      status: 0,
      message: "This model's maximum context length is 128000 tokens.",
    });
    expect(event.kind).toBe('TokenThresholdHit');
    expect(ctx.recovery.get('context-overflow')).toBe(1);
    expect(ctx.recovery.has('provider-unknown-retry')).toBe(false);
  });

  it('detects overflow via the error code when the message is opaque', async () => {
    const { ctx } = makeTestContext();
    const event = await new RecoveringNode().execute(ctx, {
      kind: 'ProviderError',
      retryable: false,
      status: 400,
      message: 'Bad request',
      code: 'context_length_exceeded',
    });
    expect(event.kind).toBe('TokenThresholdHit');
    expect(ctx.recovery.get('context-overflow')).toBe(1);
  });

  it('aborts with compact_exhausted when overflow persists past the cap', async () => {
    const { ctx, recordedEvents } = makeTestContext();
    ctx.recovery.set('context-overflow', 3);
    const err = {
      kind: 'ProviderError' as const,
      retryable: false,
      status: 400,
      message: 'input length and max_tokens exceed context limit',
    };

    const second = await new RecoveringNode().execute(ctx, err);
    expect(second.kind).toBe('Aborted');
    expect(ctx.stopReason).toBe('compact_exhausted');
    expect(ctx.error?.message).toContain('exceed context limit');

    const aborted = recordedEvents.find((r) => r.event === 'recovery_aborted');
    expect(aborted!.args[0]).toMatchObject({ kind: 'context-overflow', attempts: 4, cap: 3 });
  });

  it('still aborts a non-overflow 400 without touching the overflow counter', async () => {
    const { ctx } = makeTestContext();
    const event = await new RecoveringNode().execute(ctx, {
      kind: 'ProviderError',
      retryable: false,
      status: 400,
      message: 'invalid_request: unknown field `foo`',
    });
    expect(event.kind).toBe('Aborted');
    expect(ctx.stopReason).toBe('error');
    expect(ctx.recovery.has('context-overflow')).toBe(false);
  });

  it('preserves per-kind isolation — 401 cap does not affect transient', async () => {
    const { ctx } = makeTestContext();
    ctx.recovery.set('provider-401-refresh', 2);

    // 401 over its product cap → Aborted.
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

describe('isContextOverflowError', () => {
  it.each([
    ['prompt is too long: 210034 tokens > 200000 maximum', undefined], // anthropic
    ['input length and max_tokens exceed context limit: 199000 + 8192', undefined], // anthropic
    ["This model's maximum context length is 128000 tokens.", undefined], // openai/deepseek
    ['Your input exceeds the context window of this model', undefined], // openai responses
    ['Bad request', 'context_length_exceeded'], // openai code-only
    ['The input token count (1048577) exceeds the maximum number of tokens allowed', undefined], // gemini
    ['Request failed: exceeded model token limit', undefined], // kimi/moonshot
    ['input length exceeds the maximum input length 131072', undefined], // zai/glm
  ])('matches %s', (message, code) => {
    expect(isContextOverflowError(message, code)).toBe(true);
  });

  it.each([
    ['rate limit exceeded, retry after 3s', undefined],
    ['The model `glm-5.2` does not exist', 'model_not_found'],
    ['socket hang up', undefined],
    ['', undefined],
    [undefined, undefined],
  ])('does not match %s', (message, code) => {
    expect(isContextOverflowError(message as string | undefined, code)).toBe(false);
  });
});
