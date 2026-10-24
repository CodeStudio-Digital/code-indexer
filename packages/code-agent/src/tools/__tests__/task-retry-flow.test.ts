/**
 * PR-C: unit-level retry harness behavior.
 * Integration test (execute_tasks invoking retry) lives in
 * `execute-tasks-retry-integration.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { dispatchWithRetry } from '../execute-tasks/task-retry.js';

const fastConfig = { maxRetries: 2, initialMs: 0, maxMs: 0, jitter: 0 };
const noSleep = () => Promise.resolve();

describe('dispatchWithRetry', () => {
  it('never repeats an uncertain effect even when the reported transport error is retryable', async () => {
    const attempt = vi.fn(async () => ({ result: 'unconfirmed', shouldStop: false,
      errorMessage: 'ETIMEDOUT', effectOutcome: 'unknown' as const }));
    const sleep = vi.fn(noSleep), onFinish = vi.fn();
    const out = await dispatchWithRetry(attempt, { config: fastConfig, sleep, onFinish });
    expect(out).toEqual({ result: 'unconfirmed', attempts: 1 });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'fatal' }));
  });

  it('does not start an attempt after parent cancellation', async () => {
    const attempt = vi.fn();
    await expect(dispatchWithRetry(attempt, { signal: AbortSignal.abort(new Error('parent cancelled')) }))
      .rejects.toThrow('parent cancelled');
    expect(attempt).not.toHaveBeenCalled();
  });

  it('cancels the backoff timer without starting another child', async () => {
    const controller = new AbortController();
    const attempt = vi.fn(async () => ({ result: 'partial', shouldStop: false, errorMessage: 'ECONNRESET' }));
    let notifyRetry!: () => void;
    const retryEntered = new Promise<void>(resolve => { notifyRetry = resolve; });
    const pending = dispatchWithRetry(attempt, { signal: controller.signal,
      config: { ...fastConfig, initialMs: 60_000, maxMs: 60_000 }, onRetry: notifyRetry });
    await retryEntered;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('does not retry a child returning after its parent has cancelled', async () => {
    const controller = new AbortController();
    const attempt = vi.fn(async () => {
      controller.abort(new Error('parent cancelled'));
      return { result: 'partial', shouldStop: false, errorMessage: 'ECONNRESET' };
    });
    await expect(dispatchWithRetry(attempt, { signal: controller.signal, config: fastConfig }))
      .rejects.toThrow('parent cancelled');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('returns immediately on first attempt success', async () => {
    const attempt = vi.fn(async () => ({ result: 'ok', shouldStop: true }));
    const out = await dispatchWithRetry(attempt, { config: fastConfig, sleep: noSleep });
    expect(out.attempts).toBe(1);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries on transient error, succeeds on attempt 2', async () => {
    let i = 0;
    const attempt = vi.fn(async () => {
      i++;
      if (i === 1) {
        return { result: 'partial', shouldStop: false, errorMessage: 'ETIMEDOUT' };
      }
      return { result: 'ok', shouldStop: true };
    });
    const out = await dispatchWithRetry(attempt, { config: fastConfig, sleep: noSleep });
    expect(out.attempts).toBe(2);
    expect(out.result).toBe('ok');
  });

  it('bails on fatal error without retrying', async () => {
    const attempt = vi.fn(async () => ({
      result: 'failed',
      shouldStop: false,
      errorMessage: 'HTTP 401 Unauthorized',
    }));
    const out = await dispatchWithRetry(attempt, { config: fastConfig, sleep: noSleep });
    expect(out.attempts).toBe(1);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries on persistent transient error', async () => {
    const attempt = vi.fn(async () => ({
      result: 'partial',
      shouldStop: false,
      errorMessage: 'ETIMEDOUT',
    }));
    const out = await dispatchWithRetry(attempt, { config: fastConfig, sleep: noSleep });
    expect(out.attempts).toBe(3); // maxRetries=2 → 3 total attempts
  });

  it('fires onRetry between attempts with the delay + verdict', async () => {
    let i = 0;
    const attempt = vi.fn(async () => {
      i++;
      return i === 1
        ? { result: 'partial', shouldStop: false, errorMessage: 'rate limit' }
        : { result: 'ok', shouldStop: true };
    });
    const onRetry = vi.fn();
    await dispatchWithRetry(attempt, { config: fastConfig, sleep: noSleep, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 0,
        nextAttempt: 1,
        verdict: 'transient',
        errorMessage: 'rate limit',
      }),
    );
  });

  it('fires onFinish with the final outcome (fatal)', async () => {
    const attempt = vi.fn(async () => ({
      result: 'failed',
      shouldStop: false,
      errorMessage: 'invalid_request',
    }));
    const onFinish = vi.fn();
    await dispatchWithRetry(attempt, { config: fastConfig, sleep: noSleep, onFinish });
    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 1, verdict: 'fatal' }),
    );
  });

  it('fires onFinish with verdict=null on clean success', async () => {
    const attempt = vi.fn(async () => ({ result: 'ok', shouldStop: true }));
    const onFinish = vi.fn();
    await dispatchWithRetry(attempt, { config: fastConfig, sleep: noSleep, onFinish });
    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 1, verdict: null }),
    );
  });

  it('maxRetries=0 means a single attempt only', async () => {
    const attempt = vi.fn(async () => ({
      result: 'failed',
      shouldStop: false,
      errorMessage: 'ETIMEDOUT',
    }));
    const out = await dispatchWithRetry(attempt, {
      config: { maxRetries: 0, initialMs: 0, maxMs: 0, jitter: 0 },
      sleep: noSleep,
    });
    expect(out.attempts).toBe(1);
  });
});
